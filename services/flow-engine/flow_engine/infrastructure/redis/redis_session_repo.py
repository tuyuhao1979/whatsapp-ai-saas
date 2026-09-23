"""Redis Hash-backed session repository.

Key: ``session:{tenant_id}:{wa_id}``
TTL: 86400 seconds (24h), refreshed on every write.
``slots`` and ``history`` are stored as JSON strings inside the Hash.
"""
from __future__ import annotations

import logging
from typing import Any

import redis

from flow_engine.domain.models import Session
from flow_engine.domain.ports import ISessionRepo

logger = logging.getLogger(__name__)

_TTL_SECONDS = 86_400  # 24 hours


class RedisSessionRepo(ISessionRepo):
    def __init__(self, redis_client: redis.Redis) -> None:
        self._redis = redis_client

    def _key(self, tenant_id: str, wa_id: str) -> str:
        return f"session:{tenant_id}:{wa_id}"

    def load(self, tenant_id: str, wa_id: str) -> Session | None:
        key = self._key(tenant_id, wa_id)
        try:
            data: dict[Any, Any] = self._redis.hgetall(key)
        except redis.RedisError:
            logger.exception("Redis HGETALL failed", extra={"key": key})
            return None

        if not data:
            return None

        decoded: dict[str, str] = {
            (k.decode() if isinstance(k, bytes) else k): (
                v.decode() if isinstance(v, bytes) else v
            )
            for k, v in data.items()
        }

        try:
            return Session.from_hash(decoded)
        except (KeyError, ValueError):
            logger.exception("Failed to deserialize session", extra={"key": key})
            return None

    def save(self, session: Session) -> None:
        key = self._key(session.tenant_id, session.wa_id)
        fields = session.to_hash()
        try:
            pipe = self._redis.pipeline()
            pipe.hset(key, mapping=fields)  # type: ignore[arg-type]  # redis-py accepts str mappings at runtime
            pipe.expire(key, _TTL_SECONDS)
            pipe.execute()
        except redis.RedisError:
            logger.exception("Redis HSET failed", extra={"key": key})

    def delete(self, tenant_id: str, wa_id: str) -> None:
        key = self._key(tenant_id, wa_id)
        try:
            self._redis.delete(key)
        except redis.RedisError:
            logger.exception("Redis DEL failed", extra={"key": key})
