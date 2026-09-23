"""Postgres-backed tenant credential lookup for WhatsApp access tokens."""
from __future__ import annotations

import logging
import time

import psycopg2
import psycopg2.extras

from flow_engine.domain.ports import ITenantCredentialsRepo
from flow_engine.infrastructure.crypto import decrypt_aes256_gcm

logger = logging.getLogger(__name__)

_CACHE_TTL_S = 300.0


class PostgresTenantCredentialsRepo(ITenantCredentialsRepo):
    def __init__(self, connection_string: str, master_key: str) -> None:
        self._conn_string = connection_string
        self._master_key = master_key
        self._cache: dict[tuple[str, str], tuple[float, str]] = {}

    def _connect(self) -> psycopg2.extensions.connection:
        return psycopg2.connect(
            self._conn_string,
            cursor_factory=psycopg2.extras.RealDictCursor,
        )

    def get_access_token(self, tenant_id: str, phone_number_id: str) -> str | None:
        cache_key = (tenant_id, phone_number_id)
        now = time.monotonic()
        cached = self._cache.get(cache_key)
        if cached is not None and cached[0] > now:
            return cached[1]

        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                    SELECT access_token
                      FROM tenants
                     WHERE id = %s
                       AND phone_number_id = %s
                       AND access_token IS NOT NULL
                     LIMIT 1
                    """,
                (tenant_id, phone_number_id),
            )
            row = cur.fetchone()

        if not row:
            logger.warning(
                "Tenant access token not found",
                extra={"tenant_id": tenant_id, "phone_number_id": phone_number_id},
            )
            return None

        ciphertext = row["access_token"]
        if not ciphertext:
            return None

        access_token = decrypt_aes256_gcm(ciphertext, self._master_key)
        self._cache[cache_key] = (now + _CACHE_TTL_S, access_token)
        return access_token
