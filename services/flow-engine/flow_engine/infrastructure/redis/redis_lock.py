"""Per-conversation distributed lock via Redis SET NX EX.

Usage as context manager:
    lock = RedisLock(redis_client, tenant_id, wa_id)
    acquired = lock.acquire()
    if not acquired:
        # re-enqueue or skip
        ...
    try:
        ...
    finally:
        lock.release()

Or:
    async with RedisLock(redis_client, tenant_id, wa_id):
        ...  # raises SessionLockError if not acquired
"""
from __future__ import annotations

import logging
from typing import Self

import redis

from flow_engine.domain.errors import SessionLockError

logger = logging.getLogger(__name__)

_DEFAULT_TTL = 30  # seconds


def _lock_key(tenant_id: str, wa_id: str) -> str:
    return f"lock:flow:{tenant_id}:{wa_id}"


def _idempotency_key(message_id: str) -> str:
    return f"processed:{message_id}"


class RedisLock:
    """Synchronous context manager for per-conversation locks."""

    def __init__(
        self,
        redis_client: redis.Redis,
        tenant_id: str,
        wa_id: str,
        ttl: int = _DEFAULT_TTL,
    ) -> None:
        self._redis = redis_client
        self._tenant_id = tenant_id
        self._wa_id = wa_id
        self._ttl = ttl
        self._key = _lock_key(tenant_id, wa_id)
        self._acquired = False

    def acquire(self) -> bool:
        """Try to acquire the lock. Returns True on success."""
        result = self._redis.set(self._key, "1", nx=True, ex=self._ttl)
        self._acquired = bool(result)
        return self._acquired

    def release(self) -> None:
        if self._acquired:
            try:
                self._redis.delete(self._key)
            except redis.RedisError:
                logger.exception("Failed to release lock", extra={"key": self._key})
            finally:
                self._acquired = False

    def __enter__(self) -> Self:
        if not self.acquire():
            raise SessionLockError(self._tenant_id, self._wa_id)
        return self

    def __exit__(self, exc_type: object, exc_val: object, exc_tb: object) -> None:
        self.release()


# ---------------------------------------------------------------------------
# Idempotency helpers
# ---------------------------------------------------------------------------


def is_processed(redis_client: redis.Redis, message_id: str) -> bool:
    """Return True if this message_id has already been processed."""
    try:
        return bool(redis_client.get(_idempotency_key(message_id)))
    except redis.RedisError:
        logger.exception("Redis GET failed for idempotency check", extra={"message_id": message_id})
        return False


def mark_processed(redis_client: redis.Redis, message_id: str, ttl: int = 300) -> None:
    """Mark a message as processed; TTL defaults to 5 minutes."""
    try:
        redis_client.set(_idempotency_key(message_id), "1", ex=ttl)
    except redis.RedisError:
        logger.exception("Redis SET failed for mark_processed", extra={"message_id": message_id})
