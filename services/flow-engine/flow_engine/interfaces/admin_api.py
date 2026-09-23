"""FastAPI admin API for the Flow Engine service.

Endpoints:
  POST /admin/flows/{tenant_id}/reload  — invalidate process-local flow cache
  POST /admin/sessions/{tenant_id}/{wa_id}/reset  — delete session + lock
  GET  /admin/health  — dependency health check
  POST /admin/dry-run — execute a flow without sending real messages

All endpoints require X-Internal-Token header (shared secret).
"""
from __future__ import annotations

import logging
from datetime import UTC
from typing import Any

import redis as redis_module
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)

app = FastAPI(title="Flow Engine Admin API", docs_url=None, redoc_url=None)

# Populated at startup via lifespan injection from main.py
_state: dict[str, Any] = {}

_INTERNAL_TOKEN_HEADER = "X-Internal-Token"


# ---------------------------------------------------------------------------
# Auth dependency
# ---------------------------------------------------------------------------


def _require_internal_token(x_internal_token: str = Header(...)) -> None:
    expected = _state.get("internal_token", "")
    if not expected or x_internal_token != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.post(
    "/admin/flows/{tenant_id}/reload",
    dependencies=[Depends(_require_internal_token)],
)
def reload_flows(tenant_id: str) -> dict[str, str]:
    flow_repo = _state.get("flow_repo")
    if flow_repo is None:
        raise HTTPException(status_code=503, detail="Flow repo not initialized")
    flow_repo.reload_tenant(tenant_id)
    logger.info("Flow cache reloaded via admin", extra={"tenant_id": tenant_id})
    return {"status": "ok", "tenant_id": tenant_id}


@app.post(
    "/admin/sessions/{tenant_id}/{wa_id}/reset",
    dependencies=[Depends(_require_internal_token)],
)
def reset_session(tenant_id: str, wa_id: str) -> dict[str, str]:
    redis_client: redis_module.Redis = _state.get("redis_client")  # type: ignore[assignment]
    if redis_client is None:
        raise HTTPException(status_code=503, detail="Redis not initialized")
    session_key = f"session:{tenant_id}:{wa_id}"
    lock_key = f"lock:flow:{tenant_id}:{wa_id}"
    redis_client.delete(session_key, lock_key)
    logger.info("Session reset via admin", extra={"tenant_id": tenant_id, "wa_id": wa_id})
    return {"status": "ok", "tenant_id": tenant_id, "wa_id": wa_id}


@app.get(
    "/admin/health",
    dependencies=[Depends(_require_internal_token)],
)
def health() -> dict[str, Any]:
    redis_ok = _ping_redis()
    postgres_ok = _ping_postgres()
    chromadb_ok = _ping_chromadb()
    return {
        "status": "ok" if all([redis_ok, postgres_ok, chromadb_ok]) else "degraded",
        "redis": redis_ok,
        "postgres": postgres_ok,
        "chromadb": chromadb_ok,
    }


class DryRunRequest(BaseModel):
    tenant_id: str
    message: str
    simulated_wa_id: str = "dry-run-0000000000"


@app.post(
    "/admin/dry-run",
    dependencies=[Depends(_require_internal_token)],
)
def dry_run(body: DryRunRequest) -> dict[str, Any]:
    """Execute a flow with a RecordingMetaSendClient and return the trace."""
    import copy
    from datetime import datetime

    from flow_engine.domain.models import InboundMessage, Session
    from flow_engine.infrastructure.meta.meta_send_client import RecordingMetaSendClient

    executor = _state.get("executor")
    session_repo = _state.get("session_repo")
    if executor is None or session_repo is None:
        raise HTTPException(status_code=503, detail="Executor not initialized")

    # Shallow-copy the executor so concurrent dry-run requests each get their
    # own _meta_send reference without touching the shared production instance.
    recording_client = RecordingMetaSendClient()
    dry_executor = copy.copy(executor)
    dry_executor._meta_send = recording_client

    now = datetime.now(UTC).isoformat()
    session = session_repo.load(body.tenant_id, body.simulated_wa_id)
    if session is None:
        session = Session.new(body.tenant_id, body.simulated_wa_id, now)

    msg = InboundMessage(
        message_id=f"dry-run-{now}",
        tenant_id=body.tenant_id,
        phone_number_id="dry-run",
        wa_id=body.simulated_wa_id,
        text=body.message,
        timestamp=now,
        access_token="dry-run",
    )

    dry_executor.execute(msg, session)

    return {
        "session_state": session.state,
        "current_node": session.current_node,
        "slots": session.slots,
        "sent": recording_client.sent,
    }


# ---------------------------------------------------------------------------
# Dependency health helpers
# ---------------------------------------------------------------------------


def _ping_redis() -> bool:
    client = _state.get("redis_client")
    if client is None:
        return False
    try:
        return client.ping()
    except Exception:  # noqa: BLE001 — a health probe must never raise
        return False


def _ping_postgres() -> bool:
    conn_str = _state.get("db_url", "")
    if not conn_str:
        return False
    try:
        import psycopg2
        with psycopg2.connect(conn_str, connect_timeout=3) as conn, conn.cursor() as cur:
            cur.execute("SELECT 1")
        return True
    except Exception:  # noqa: BLE001 — a health probe must never raise
        return False


def _ping_chromadb() -> bool:
    retriever = _state.get("chroma_retriever")
    if retriever is None:
        return False
    try:
        retriever._client.heartbeat()
        return True
    except Exception:  # noqa: BLE001 — a health probe must never raise
        return False
