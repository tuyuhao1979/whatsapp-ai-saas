"""Postgres-backed persistence for inbound Meta message status callbacks.

Meta sends delivery lifecycle events (sent / delivered / read / failed) on the
same webhook as inbound messages. The gateway forwards them as `kind=status`
envelopes; the consumer lands them here.

Every statement runs inside a transaction that first sets the RLS GUC via
`set_config(..., true)` (transaction-local), matching the pattern used by the
other Postgres adapters.
"""
from __future__ import annotations

import json
import logging

import psycopg2
import psycopg2.extras

from flow_engine.domain.models import MessageStatusEvent
from flow_engine.domain.ports import IMessageStatusRepo

logger = logging.getLogger(__name__)

# Meta statuses we accept verbatim; anything else is normalised to 'unknown'
# so a future Meta status value cannot break ingestion.
_KNOWN_STATUSES = {
    "sent",
    "delivered",
    "read",
    "failed",
    "deleted",
    "warning",
}


class PostgresMessageStatusRepo(IMessageStatusRepo):
    def __init__(self, connection_string: str) -> None:
        self._conn_string = connection_string

    def _connect(self) -> psycopg2.extensions.connection:
        return psycopg2.connect(
            self._conn_string,
            cursor_factory=psycopg2.extras.RealDictCursor,
        )

    def record(self, event: MessageStatusEvent) -> None:
        status = event.status if event.status in _KNOWN_STATUSES else "unknown"
        try:
            with self._connect() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.tenant_id', %s, true)", (event.tenant_id,))
                    cur.execute(
                        """
                        INSERT INTO message_statuses
                            (tenant_id, wamid, status, recipient_id, occurred_at,
                             error_code, error_title, conversation_id,
                             pricing_category, raw)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT ON CONSTRAINT message_statuses_dedupe
                        DO UPDATE SET
                            recipient_id     = EXCLUDED.recipient_id,
                            error_code       = EXCLUDED.error_code,
                            error_title      = EXCLUDED.error_title,
                            conversation_id  = EXCLUDED.conversation_id,
                            pricing_category = EXCLUDED.pricing_category,
                            raw              = EXCLUDED.raw,
                            updated_at       = now()
                        """,
                        (
                            event.tenant_id,
                            event.wamid,
                            status,
                            event.recipient_id,
                            event.occurred_at,
                            event.error_code,
                            event.error_title,
                            event.conversation_id,
                            event.pricing_category,
                            json.dumps(event.raw),
                        ),
                    )
                conn.commit()
            logger.info(
                "Message status recorded",
                extra={
                    "tenant_id": event.tenant_id,
                    "wamid": event.wamid,
                    "status": status,
                },
            )
        except Exception:
            # Status ingestion is best-effort telemetry: never break the
            # consumer loop over it.
            logger.exception(
                "Failed to record message status",
                extra={"tenant_id": event.tenant_id, "wamid": event.wamid},
            )
