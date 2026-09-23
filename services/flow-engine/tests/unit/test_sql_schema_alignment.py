"""Static guard: Python adapters must only reference columns that exist.

This is the regression test for the schema-drift family of blockers (B3/B6/B7).
All three had the same root cause — a Python adapter written against a column
name the SQL migrations never created — and all three failed at runtime with
`UndefinedColumn` or a NOT NULL violation:

  * postgres_flow_repo  used `trigger_config`, `node_type`, `is_entry`
  * postgres_conv_log   used `node_id` and omitted `message_type`/`content`
  * rag postgres_repo   wrote `knowledge_base_documents.updated_at`

Parsing the migrations keeps this check honest: it fails if either side drifts.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[4]
_MIGRATIONS = _REPO_ROOT / "infra" / "migrations"

_FLOW_ENGINE = _REPO_ROOT / "services" / "flow-engine" / "flow_engine"
_RAG_INDEXER = _REPO_ROOT / "services" / "rag-indexer" / "rag_indexer"

_CREATE_RE = re.compile(r"CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)\s*\((.*?)\n\);", re.S)
_ALTER_RE = re.compile(r"ALTER TABLE\s+(\w+)\s+ADD COLUMN(?: IF NOT EXISTS)?\s+(\w+)", re.S)
_COLUMN_RE = re.compile(r"^\s{2}([a-z_][a-z0-9_]*)\s+[A-Za-z\[]")
_NON_COLUMN_KEYWORDS = {"constraint", "primary", "unique", "foreign", "check", "exclude"}


def _schema() -> dict[str, set[str]]:
    """table name -> column names, merged across all migrations."""
    tables: dict[str, set[str]] = {}
    for path in sorted(_MIGRATIONS.glob("*.sql")):
        text = path.read_text(encoding="utf-8")
        for table, body in _CREATE_RE.findall(text):
            columns = {
                m.group(1)
                for m in (_COLUMN_RE.match(line) for line in body.splitlines())
                if m and m.group(1) not in _NON_COLUMN_KEYWORDS
            }
            tables.setdefault(table, set()).update(columns)
        for table, column in _ALTER_RE.findall(text):
            tables.setdefault(table, set()).add(column)
    return tables


@pytest.fixture(scope="module")
def schema() -> dict[str, set[str]]:
    parsed = _schema()
    assert parsed, f"no migrations parsed from {_MIGRATIONS}"
    return parsed


# ---------------------------------------------------------------------------
# The specific drifted columns
# ---------------------------------------------------------------------------


def test_flow_repo_columns_exist(schema: dict[str, set[str]]) -> None:
    assert {"id", "name", "trigger", "entry_node", "is_active"} <= schema["flows"]
    assert {"flow_id", "node_key", "type", "config", "transitions"} <= schema["flow_nodes"]


def _strip_comments(source: str) -> str:
    """Drop # comments so prose mentioning a ghost column does not trip the guard."""
    return "\n".join(line.split("#", 1)[0] for line in source.splitlines())


_SQL_BLOCK_RE = re.compile(r'"""(.*?)"""', re.S)


def _sql_blocks(source: str) -> str:
    """Extract triple-quoted SQL bodies.

    Only these must be free of ghost columns: `node_type=row["type"]` is a
    Python keyword argument for the FlowNode dataclass field, not SQL.
    """
    return "\n".join(_SQL_BLOCK_RE.findall(source))


def test_flow_repo_sql_does_not_use_removed_column_names() -> None:
    sql = _sql_blocks(
        (_FLOW_ENGINE / "infrastructure/postgres/postgres_flow_repo.py").read_text()
    )
    assert sql.strip(), "expected triple-quoted SQL statements in the flow repo"
    for ghost in ("trigger_config", "node_type", "is_entry"):
        assert ghost not in sql, f"{ghost!r} does not exist in the SQL schema"
    for real in ("trigger", "entry_node", "node_key", "type", "transitions"):
        assert real in sql, f"expected column {real!r} in the flow repo SQL"


def test_conversation_log_insert_covers_not_null_columns(schema: dict[str, set[str]]) -> None:
    """Every NOT NULL conversation_logs column without a default must be supplied."""
    sql = (_REPO_ROOT / "infra/migrations/004_create_conversation_logs.sql").read_text()
    required = {"tenant_id", "wa_id", "direction", "message_type", "content", "created_at"}
    for column in required:
        assert column in schema["conversation_logs"] or column in sql

    source = (_FLOW_ENGINE / "infrastructure/postgres/postgres_conv_log.py").read_text()
    insert = source.split("INSERT INTO conversation_logs")[1].split("VALUES")[0]
    for column in required:
        assert column in insert, f"conversation_logs INSERT omits NOT NULL column {column!r}"
    assert "node_key" in insert
    assert "node_id" not in insert


def test_rag_status_repo_column_exists(schema: dict[str, set[str]]) -> None:
    source = (_RAG_INDEXER / "infrastructure/postgres_repo.py").read_text()
    if "updated_at" in source:
        assert "updated_at" in schema["knowledge_base_documents"], (
            "migration 006 must add knowledge_base_documents.updated_at"
        )


def test_message_status_columns_exist(schema: dict[str, set[str]]) -> None:
    assert "message_statuses" in schema
    assert {
        "tenant_id",
        "wamid",
        "status",
        "recipient_id",
        "occurred_at",
        "error_code",
        "error_title",
        "conversation_id",
        "pricing_category",
        "raw",
    } <= schema["message_statuses"]


def test_message_statuses_has_rls_policy() -> None:
    sql = (_REPO_ROOT / "infra/migrations/006_message_statuses.sql").read_text()
    assert "ENABLE ROW LEVEL SECURITY" in sql
    assert "FORCE ROW LEVEL SECURITY" in sql
    assert "current_setting('app.tenant_id', true)::uuid" in sql


def test_tenant_scoped_python_adapters_set_the_rls_guc() -> None:
    """Every adapter touching a tenant-scoped table must set app.tenant_id."""
    adapters = [
        _FLOW_ENGINE / "infrastructure/postgres/postgres_conv_log.py",
        _FLOW_ENGINE / "infrastructure/postgres/postgres_flow_repo.py",
        _FLOW_ENGINE / "infrastructure/postgres/postgres_message_status_repo.py",
        _RAG_INDEXER / "infrastructure/postgres_repo.py",
    ]
    for adapter in adapters:
        text = adapter.read_text()
        assert "set_config('app.tenant_id'" in text, f"{adapter.name} never sets app.tenant_id"


def test_no_adapter_uses_string_interpolated_tenant_id() -> None:
    """The RLS GUC must be bound as a parameter, never interpolated (H4)."""
    for path in list(_FLOW_ENGINE.rglob("*.py")) + list(_RAG_INDEXER.rglob("*.py")):
        text = _strip_comments(path.read_text())
        assert "SET LOCAL app.tenant_id = '" not in text, f"{path} interpolates tenant_id"
        assert "SET LOCAL app.tenant_id = {" not in text, f"{path} interpolates tenant_id"
        assert "set_config('app.tenant_id', f'" not in text, f"{path} f-string in set_config"
