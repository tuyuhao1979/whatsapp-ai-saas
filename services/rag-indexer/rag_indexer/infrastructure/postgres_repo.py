"""Postgres adapter: implements IStatusRepo using psycopg2 with explicit RLS context."""
from __future__ import annotations

import logging
from typing import Optional

import psycopg2
import psycopg2.extras

from rag_indexer.domain.ports import IStatusRepo

logger = logging.getLogger(__name__)


class PostgresStatusRepo(IStatusRepo):
    """Updates knowledge_base_documents status in Postgres.

    IMPORTANT: every query on a tenant-scoped table runs inside a transaction
    that first calls ``SELECT set_config('app.tenant_id', %s, true)`` with the
    tenant id bound as a parameter. This satisfies the Row-Level Security
    policy defined in migration 005 without ever interpolating the value into
    SQL text.
    The heartbeat is NOT tenant-scoped (written to worker_heartbeats).
    """

    def __init__(self, connection_string: str) -> None:
        self._conn_string = connection_string

    def _connect(self) -> psycopg2.extensions.connection:
        return psycopg2.connect(self._conn_string, cursor_factory=psycopg2.extras.RealDictCursor)

    def get_status(self, tenant_id: str, document_id: str) -> Optional[str]:
        """Return the current status of a document, or None if not found."""
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
                cur.execute(
                    "SELECT status FROM knowledge_base_documents WHERE id = %s AND tenant_id = %s",
                    (document_id, tenant_id),
                )
                row = cur.fetchone()
                if row is None:
                    return None
                return row["status"]

    def set_indexing(self, tenant_id: str, document_id: str) -> None:
        """Transition document to 'indexing' status."""
        self._update_status(tenant_id, document_id, "indexing")

    def set_indexed(self, tenant_id: str, document_id: str, chunk_count: int) -> None:
        """Transition document to 'indexed' and record chunk_count + indexed_at."""
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
                cur.execute(
                    """
                    UPDATE knowledge_base_documents
                       SET status = 'indexed',
                           chunk_count = %s,
                           indexed_at = NOW(),
                           error_message = NULL,
                           updated_at = NOW()
                     WHERE id = %s
                       AND tenant_id = %s
                    """,
                    (chunk_count, document_id, tenant_id),
                )
            conn.commit()
        logger.info(
            "Status → indexed",
            extra={"document_id": document_id, "chunk_count": chunk_count},
        )

    def set_failed(
        self, tenant_id: str, document_id: str, error_message: str
    ) -> None:
        """Transition document to 'failed' and record error_message."""
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
                cur.execute(
                    """
                    UPDATE knowledge_base_documents
                       SET status = 'failed',
                           error_message = %s,
                           updated_at = NOW()
                     WHERE id = %s
                       AND tenant_id = %s
                    """,
                    (error_message[:500], document_id, tenant_id),
                )
            conn.commit()
        logger.warning(
            "Status → failed",
            extra={"document_id": document_id, "error": error_message[:200]},
        )

    def _update_status(self, tenant_id: str, document_id: str, status: str) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
                cur.execute(
                    """
                    UPDATE knowledge_base_documents
                       SET status = %s, updated_at = NOW()
                     WHERE id = %s
                       AND tenant_id = %s
                    """,
                    (status, document_id, tenant_id),
                )
            conn.commit()
