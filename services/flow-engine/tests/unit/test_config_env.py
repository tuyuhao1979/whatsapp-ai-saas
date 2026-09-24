"""B1 — the Postgres connection string must be accepted under either name.

Before the fix, flow_engine.config required DATABASE_URL while docker-compose
injected POSTGRES_URL, so the service exited(1) at startup under the shipped
compose file. These are the failing-first tests for that contract.
"""
from __future__ import annotations

import pytest

from flow_engine.config import load_config

_BASE_ENV = {
    "REDIS_URL": "redis://localhost:6379/0",
    "CHROMADB_HOST": "localhost",
    "CHROMADB_PORT": "8000",
    "CHROMA_AUTH_TOKEN": "test-chroma-token",
    "OPENAI_API_KEY": "sk-test",
    "INTERNAL_TOKEN": "internal-token",
    "MASTER_KEY": "0" * 64,
}


def _env(**overrides: str) -> dict[str, str]:
    env = dict(_BASE_ENV)
    env.update(overrides)
    return env


def test_accepts_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    env = _env(DATABASE_URL="postgresql://app_user:pw@postgres:5432/saas")
    monkeypatch.setattr("os.environ", env)
    assert load_config(env).database_url == env["DATABASE_URL"]


def test_accepts_postgres_url_alias(monkeypatch: pytest.MonkeyPatch) -> None:
    """docker-compose injects POSTGRES_URL — this must not be a fatal error."""
    env = _env(POSTGRES_URL="postgresql://app_user:pw@postgres:5432/saas")
    monkeypatch.setattr("os.environ", env)
    assert load_config(env).database_url == env["POSTGRES_URL"]


def test_database_url_wins_over_postgres_url(monkeypatch: pytest.MonkeyPatch) -> None:
    env = _env(
        DATABASE_URL="postgresql://app_user:pw@postgres:5432/preferred",
        POSTGRES_URL="postgresql://app_user:pw@postgres:5432/other",
    )
    monkeypatch.setattr("os.environ", env)
    assert load_config(env).database_url.endswith("/preferred")


def test_exits_when_no_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    env = _env()
    monkeypatch.setattr("os.environ", env)
    with pytest.raises(SystemExit):
        load_config(env)


def test_mode_defaults_to_both_and_is_validated(monkeypatch: pytest.MonkeyPatch) -> None:
    env = _env(DATABASE_URL="postgresql://x/y")
    monkeypatch.setattr("os.environ", env)
    assert load_config(env).mode == "both"

    bad = _env(DATABASE_URL="postgresql://x/y", MODE="nonsense")
    monkeypatch.setattr("os.environ", bad)
    with pytest.raises(SystemExit):
        load_config(bad)


def test_meta_api_base_and_body_storage_are_configurable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env = _env(
        DATABASE_URL="postgresql://x/y",
        META_API_BASE="https://graph.facebook.com/v21.0/",
        STORE_MESSAGE_BODY="true",
    )
    monkeypatch.setattr("os.environ", env)
    cfg = load_config(env)
    assert cfg.meta_api_base == "https://graph.facebook.com/v21.0"  # trailing / trimmed
    assert cfg.store_message_body is True


def test_chroma_auth_token_is_carried_into_the_config(monkeypatch: pytest.MonkeyPatch) -> None:
    env = _env(DATABASE_URL="postgresql://x/y", CHROMA_AUTH_TOKEN="tok")
    monkeypatch.setattr("os.environ", env)
    assert load_config(env).chromadb_auth_token == "tok"


def test_exits_without_a_chroma_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """H3: ChromaDB requires authentication, so a deployment that forgets the
    token must stop at startup rather than serve an unauthenticated vector store
    (or, worse, start and have every RAG lookup come back empty)."""
    env = _env(DATABASE_URL="postgresql://x/y")
    del env["CHROMA_AUTH_TOKEN"]
    monkeypatch.setattr("os.environ", env)
    with pytest.raises(SystemExit):
        load_config(env)
