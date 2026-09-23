"""Postgres-backed conversation log repository.

Writes inbound and outbound turns to ``conversation_logs``.
Every INSERT runs inside a transaction with the RLS GUC set for that tenant.

Privacy: the message *body* is deliberately not persisted. Only structural
metadata is written unless ``store_message_body`` is explicitly enabled by the
operator (default off). When disabled the JSONB ``content`` payload carries
only non-identifying shape information.
"""
from __future__ import annotations

import json
import logging

import psycopg2
import psycopg2.extras

from flow_engine.domain.models import ConversationTurn
from flow_engine.domain.ports import IConvLogRepo

logger = logging.getLogger(__name__)


class PostgresConvLogRepo(IConvLogRepo):
    def __init__(self, connection_string: str, store_message_body: bool = False) -> None:
        self._conn_string = connection_string
        self._store_message_body = store_message_body

    def _connect(self) -> psycopg2.extensions.connection:
        return psycopg2.connect(
            self._conn_string,
            cursor_factory=psycopg2.extras.RealDictCursor,
        )

    def write(self, turn: ConversationTurn) -> None:
        try:
            with self._connect() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT set_config('app.tenant_id', %s, true)",
                        (turn.tenant_id,),
                    )
                    cur.execute(
                        """
                        INSERT INTO conversation_logs
                            (tenant_id, wa_id, flow_id, direction, message_type,
                             content, node_key, llm_tokens, latency_ms, created_at)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        (
                            turn.tenant_id,
                            turn.wa_id,
                            turn.flow_id,
                            turn.direction,
                            turn.message_type,
                            json.dumps(turn.content),
                            turn.node_key,
                            turn.llm_tokens,
                            turn.latency_ms,
                            turn.created_at,
                        ),
                    )
                conn.commit()
        except Exception:
            # Logging failures must not crash the processing loop
            logger.exception(
                "Failed to write conversation log",
                extra={"tenant_id": turn.tenant_id, "wa_id": turn.wa_id},
            )

    def build_content(self, message_text: str) -> dict[str, object]:
        """Build the JSONB payload, honouring the body-storage policy."""
        if self._store_message_body:
            return {"text": message_text}
        return {"chars": len(message_text), "redacted": True}
