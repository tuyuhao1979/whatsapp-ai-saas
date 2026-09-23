"""Redis Streams consumer for the Flow Engine.

Reads from ``flow-engine:{tenantId}`` streams using XREADGROUP.
Same pattern as the RAG Indexer consumer, adapted for Flow Engine concerns:
  - Idempotency guard (processed:{message_id} key)
  - Per-tenant rate limiter (30 msg/min)
  - Per-conversation distributed lock
  - Session load → FlowExecutor.execute → Session save
  - Conversation log write
  - XACK after all steps complete
"""
from __future__ import annotations

import json
import logging
import math
import socket
import time
from datetime import UTC, datetime
from typing import Any

import redis

from flow_engine.application.flow_executor import FlowExecutor
from flow_engine.domain.models import (
    ConversationTurn,
    InboundMessage,
    MessageStatusEvent,
    Session,
)
from flow_engine.domain.ports import (
    IConvLogRepo,
    IMessageStatusRepo,
    ISessionRepo,
    ITenantCredentialsRepo,
)
from flow_engine.infrastructure.redis.redis_lock import (
    RedisLock,
    is_processed,
    mark_processed,
)

logger = logging.getLogger(__name__)

_GROUP_NAME = "flow-engine-workers"
_CONSUMER_NAME = f"flow-engine-{socket.gethostname()}"
_BLOCK_MS = 5_000
_XCLAIM_IDLE_MS = 10 * 60 * 1_000
_XCLAIM_CHECK_INTERVAL_S = 60
_READ_COUNT = 5
_RATE_LIMIT = 30     # messages per minute per tenant
_RATE_LIMIT_MSG = "I'm temporarily busy. Please try again in a minute."
_LOCK_MAX_RETRIES = 3   # re-enqueue budget when the conversation lock is busy


class FlowEngineConsumer:
    STREAM_PATTERN = "flow-engine:*"
    GROUP_NAME = _GROUP_NAME
    CONSUMER_NAME = _CONSUMER_NAME

    def __init__(
        self,
        redis_client: redis.Redis,
        executor: FlowExecutor,
        session_repo: ISessionRepo,
        conv_log_repo: IConvLogRepo,
        tenant_credentials_repo: ITenantCredentialsRepo,
        meta_send: Any,  # IMetaSendPort — needed for rate-limit replies
        message_status_repo: IMessageStatusRepo | None = None,
    ) -> None:
        self._redis = redis_client
        self._executor = executor
        self._session_repo = session_repo
        self._conv_log_repo = conv_log_repo
        self._tenant_credentials_repo = tenant_credentials_repo
        self._meta_send = meta_send
        self._message_status_repo = message_status_repo
        self._last_xclaim_check: float = 0.0

    def run(self) -> None:
        logger.info(
            "FlowEngineConsumer starting",
            extra={"consumer": self.CONSUMER_NAME, "group": self.GROUP_NAME},
        )
        self._ensure_groups_for_existing_streams()

        while True:
            try:
                self._tick()
            except KeyboardInterrupt:
                logger.info("Shutting down on KeyboardInterrupt")
                break
            except Exception:
                logger.exception("Unexpected error in consumer loop — continuing")
                time.sleep(1)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _tick(self) -> None:
        if time.monotonic() - self._last_xclaim_check >= _XCLAIM_CHECK_INTERVAL_S:
            self._xclaim_stuck_messages()
            self._last_xclaim_check = time.monotonic()

        stream_keys = self._discover_streams()
        if not stream_keys:
            time.sleep(1)
            return

        self._ensure_groups(stream_keys)

        try:
            results: Any = self._redis.xreadgroup(
                groupname=self.GROUP_NAME,
                consumername=self.CONSUMER_NAME,
                streams={k: ">" for k in stream_keys},
                count=_READ_COUNT,
                block=_BLOCK_MS,
            )
        except redis.RedisError:
            logger.exception("XREADGROUP error")
            return

        if not results:
            return

        for stream_entry in results:
            stream_key, messages = stream_entry
            if isinstance(stream_key, bytes):
                stream_key = stream_key.decode()
            for message_id, fields in messages:
                if isinstance(message_id, bytes):
                    message_id = message_id.decode()
                decoded = _decode_fields(fields)
                self._process(stream_key, message_id, decoded)

    def _process(
        self,
        stream_key: str,
        message_id: str,
        fields: dict[str, str],
    ) -> None:
        """Dispatch on the envelope kind published by the gateway.

        `kind` is written as its own stream field so dispatch does not require
        parsing the JSON envelope first.
        """
        if fields.get("kind") == "status":
            self._process_status(stream_key, message_id, fields)
            return
        self._process_message(stream_key, message_id, fields)

    # ------------------------------------------------------------------
    # Delivery/read/failure callbacks
    # ------------------------------------------------------------------

    def _process_status(
        self,
        stream_key: str,
        message_id: str,
        fields: dict[str, str],
    ) -> None:
        """Persist a Meta message-status callback. Never raises."""
        try:
            event = _parse_status(fields)
        except (KeyError, ValueError):
            logger.exception(
                "Malformed status envelope — ACKing", extra={"message_id": message_id}
            )
            self._ack(stream_key, message_id)
            return

        if self._message_status_repo is None:
            logger.warning(
                "No message status repo configured — dropping status event",
                extra={"tenant_id": event.tenant_id, "wamid": event.wamid},
            )
            self._ack(stream_key, message_id)
            return

        # Idempotency: Meta retries deliveries. The DB uniqueness constraint is
        # the authoritative guard; this is a cheap short-circuit.
        dedupe_key = event.idempotency_key
        if is_processed(self._redis, dedupe_key):
            logger.info(
                "Duplicate status event — skipping",
                extra={"tenant_id": event.tenant_id, "wamid": event.wamid},
            )
            self._ack(stream_key, message_id)
            return

        self._message_status_repo.record(event)
        mark_processed(self._redis, dedupe_key)
        self._ack(stream_key, message_id)

    # ------------------------------------------------------------------
    # Inbound messages
    # ------------------------------------------------------------------

    def _process_message(
        self,
        stream_key: str,
        message_id: str,
        fields: dict[str, str],
    ) -> None:
        # 1. Parse envelope
        try:
            msg = _parse_message(fields)
        except (KeyError, ValueError):
            logger.exception(
                "Malformed stream message — ACKing",
                extra={"message_id": message_id},
            )
            self._ack(stream_key, message_id)
            return

        # Idempotency key is Meta's own message id (wamid), NOT the internal
        # trace UUID: Meta re-delivers the same webhook on timeout, and a
        # per-delivery random key would let duplicates through.
        dedupe_key = msg.wamid or msg.message_id

        if is_processed(self._redis, dedupe_key):
            logger.info(
                "Duplicate message — skipping",
                extra={"tenant_id": msg.tenant_id, "wamid": dedupe_key},
            )
            self._ack(stream_key, message_id)
            return

        access_token = self._tenant_credentials_repo.get_access_token(
            msg.tenant_id,
            msg.phone_number_id,
        )
        if not access_token:
            logger.error(
                "Missing tenant access token — ACKing",
                extra={
                    "tenant_id": msg.tenant_id,
                    "phone_number_id": msg.phone_number_id,
                    "message_id": message_id,
                },
            )
            self._ack(stream_key, message_id)
            return
        msg.access_token = access_token

        log_extra = {
            "tenant_id": msg.tenant_id,
            "wa_id": msg.wa_id,
            "wamid": dedupe_key,
            "message_id": message_id,
        }

        # 2. Rate limit
        if not self._check_rate_limit(msg.tenant_id):
            logger.warning("Rate limit exceeded", extra={"tenant_id": msg.tenant_id})
            try:
                self._meta_send.send_text(
                    phone_number_id=msg.phone_number_id,
                    to=msg.wa_id,
                    text=_RATE_LIMIT_MSG,
                    access_token=msg.access_token,
                )
            except Exception:
                logger.exception("Failed to send rate-limit notice", extra=log_extra)
            self._ack(stream_key, message_id)
            return

        # 3. Conversation lock
        lock = RedisLock(self._redis, msg.tenant_id, msg.wa_id)
        if not lock.acquire():
            logger.info("Lock busy — re-enqueuing", extra=log_extra)
            self._reenqueue(stream_key, fields)
            self._ack(stream_key, message_id)
            return

        sent_wamids: list[str] = []
        llm_tokens = 0
        processed_ok = False
        started = time.monotonic()
        try:
            # 4. Load session
            session = self._session_repo.load(msg.tenant_id, msg.wa_id)
            if session is None:
                now = datetime.now(UTC).isoformat()
                session = Session.new(msg.tenant_id, msg.wa_id, now)

            # 5. Execute
            execution = self._executor.execute(msg, session)
            sent_wamids = list(execution.sent_wamids)
            llm_tokens = execution.llm_tokens

            # 6. Save session
            self._session_repo.save(session)
            processed_ok = True

            # 7. Write conversation log (inbound turn)
            latency_ms = int((time.monotonic() - started) * 1000)
            now_str = datetime.now(UTC).isoformat()
            self._conv_log_repo.write(
                ConversationTurn(
                    tenant_id=msg.tenant_id,
                    wa_id=msg.wa_id,
                    flow_id=session.flow_id,
                    direction="inbound",
                    message_type=msg.message_type,
                    content=self._build_conv_content(msg, sent_wamids),
                    node_key=session.current_node,
                    llm_tokens=llm_tokens,
                    latency_ms=latency_ms,
                    created_at=now_str,
                )
            )

        except Exception:
            logger.exception("Processing error", extra=log_extra)
        finally:
            lock.release()

        # Marking processed only on success preserves the ability to retry a
        # failed message instead of silently dropping it.
        if processed_ok:
            mark_processed(self._redis, dedupe_key)
        else:
            logger.warning(
                "Message processing failed — not marked processed", extra=log_extra
            )

        self._ack(stream_key, message_id)
        logger.info("Message processed", extra=log_extra)

    def _build_conv_content(
        self, msg: InboundMessage, sent_wamids: list[str]
    ) -> dict[str, Any]:
        build = getattr(self._conv_log_repo, "build_content", None)
        content: dict[str, Any] = build(msg.text) if callable(build) else {}
        if sent_wamids:
            content["sent_wamids"] = sent_wamids
        return content

    def _check_rate_limit(self, tenant_id: str) -> bool:
        minute_bucket = math.floor(time.time() / 60)
        key = f"rate:tenant:{tenant_id}:minute:{minute_bucket}"
        try:
            count = self._redis.incr(key)
            if count == 1:
                self._redis.expire(key, 120)
            return count <= _RATE_LIMIT
        except redis.RedisError:
            logger.exception("Rate limit check failed — allowing through")
            return True

    def _reenqueue(self, stream_key: str, fields: dict[str, str]) -> None:
        """Re-queue a message whose conversation lock was busy.

        The consumer loop is single-threaded, so sleeping here would stall
        every other tenant. Instead we carry a retry counter and give up after
        a bounded number of attempts.
        """
        retries = int(fields.get("_lock_retries", "0")) + 1
        if retries > _LOCK_MAX_RETRIES:
            logger.warning(
                "Lock retry budget exhausted — dropping message",
                extra={"stream": stream_key, "retries": retries},
            )
            return

        new_fields = dict(fields)
        new_fields["_lock_retries"] = str(retries)
        try:
            self._redis.xadd(stream_key, new_fields, maxlen=10_000, approximate=True)  # type: ignore[arg-type]
        except redis.RedisError:
            logger.exception("Failed to re-enqueue message", extra={"stream": stream_key})

    def _ack(self, stream_key: str, message_id: str) -> None:
        try:
            self._redis.xack(stream_key, self.GROUP_NAME, message_id)
        except redis.RedisError:
            logger.exception(
                "XACK failed",
                extra={"stream": stream_key, "message_id": message_id},
            )

    def _discover_streams(self) -> list[str]:
        """Return all keys matching the stream pattern.

        Uses SCAN rather than KEYS: KEYS is O(N) and blocks the Redis server,
        and it was also not granted in the service ACL.
        """
        try:
            keys = list(self._redis.scan_iter(match=self.STREAM_PATTERN, count=100))
            return [k.decode() if isinstance(k, bytes) else k for k in keys]
        except redis.RedisError:
            logger.exception("Failed to discover streams")
            return []

    def _ensure_groups(self, stream_keys: list[str]) -> None:
        for key in stream_keys:
            try:
                self._redis.xgroup_create(key, self.GROUP_NAME, id="0", mkstream=True)
            except redis.exceptions.ResponseError as exc:
                if "BUSYGROUP" not in str(exc):
                    logger.exception("XGROUP CREATE error", extra={"stream": key})

    def _ensure_groups_for_existing_streams(self) -> None:
        self._ensure_groups(self._discover_streams())

    def _xclaim_stuck_messages(self) -> None:
        for stream_key in self._discover_streams():
            try:
                result = self._redis.xautoclaim(
                    stream_key,
                    self.GROUP_NAME,
                    self.CONSUMER_NAME,
                    _XCLAIM_IDLE_MS,
                    # redis-py names this parameter `start_id`. Passing
                    # `start=` raised TypeError on every sweep; the broad
                    # except below swallowed it, so stuck-message recovery
                    # silently never ran.
                    start_id="0-0",
                    count=10,
                )
                claimed = result[1] if result else []
                for message_id, fields in claimed:
                    if isinstance(message_id, bytes):
                        message_id = message_id.decode()
                    decoded = _decode_fields(fields)
                    logger.warning("Re-claiming stuck message", extra={"message_id": message_id})
                    self._process(stream_key, message_id, decoded)
            except redis.RedisError:
                logger.exception("XAUTOCLAIM error", extra={"stream": stream_key})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _decode_fields(fields: dict[Any, Any]) -> dict[str, str]:
    return {
        (k.decode() if isinstance(k, bytes) else k): (
            v.decode() if isinstance(v, bytes) else v
        )
        for k, v in fields.items()
    }


def _parse_message(fields: dict[str, str]) -> InboundMessage:
    """Parse a `kind=message` stream envelope into an InboundMessage.

    Supports the JSON envelope in `data` and the legacy flat-field shape.
    """
    if "data" in fields:
        payload = json.loads(fields["data"])
        raw = payload["raw"]
        messages = raw.get("messages") or []
        contacts = raw.get("contacts") or []
        first_message = messages[0] if messages else {}
        first_contact = contacts[0] if contacts else {}
        wa_id = (
            first_message.get("from")
            or first_contact.get("wa_id")
            or raw.get("metadata", {}).get("phone_number_id", "")
        )
        text = first_message.get("text", {}).get("body", "")
        timestamp = first_message.get("timestamp", payload.get("received_at", ""))
        return InboundMessage(
            message_id=payload["message_id"],
            tenant_id=payload["tenant_id"],
            phone_number_id=payload["phone_number_id"],
            wa_id=wa_id,
            text=text,
            timestamp=timestamp,
            access_token="",
            wamid=first_message.get("id", ""),
            message_type=first_message.get("type", "text"),
        )

    return InboundMessage(
        message_id=fields["message_id"],
        tenant_id=fields["tenant_id"],
        phone_number_id=fields.get("phone_number_id", ""),
        wa_id=fields["wa_id"],
        text=fields.get("text", ""),
        timestamp=fields.get("timestamp", ""),
        access_token=fields.get("access_token", ""),
        wamid=fields.get("wamid", ""),
        message_type=fields.get("message_type", "text"),
    )


def _parse_status(fields: dict[str, str]) -> MessageStatusEvent:
    """Parse a `kind=status` stream envelope into a MessageStatusEvent.

    Raises KeyError/ValueError on a malformed envelope so the caller can ACK
    and move on rather than retrying a poison message forever.
    """
    payload = json.loads(fields["data"])
    raw = payload["raw"]
    statuses = raw.get("statuses") or []
    if not statuses:
        raise ValueError("status envelope carries no statuses")

    status_entry = statuses[0]
    wamid = status_entry.get("id")
    if not wamid:
        raise ValueError("status entry is missing the message id")

    errors = status_entry.get("errors") or []
    first_error = errors[0] if errors else {}
    conversation = status_entry.get("conversation") or {}
    pricing = status_entry.get("pricing") or {}

    error_code = first_error.get("code")
    return MessageStatusEvent(
        tenant_id=payload["tenant_id"],
        wamid=str(wamid),
        status=str(status_entry.get("status", "unknown")),
        recipient_id=status_entry.get("recipient_id"),
        occurred_at=_unix_to_iso(status_entry.get("timestamp"))
        or payload.get("received_at"),
        error_code=str(error_code) if error_code is not None else None,
        error_title=first_error.get("title"),
        conversation_id=conversation.get("id"),
        pricing_category=pricing.get("category"),
        raw=status_entry,
    )


def _unix_to_iso(value: Any) -> str | None:
    """Convert a Meta unix-seconds timestamp (string or int) to ISO 8601."""
    if value is None or value == "":
        return None
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(seconds, tz=UTC).isoformat()
