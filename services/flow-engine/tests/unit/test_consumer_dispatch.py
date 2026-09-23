"""Status callbacks + wamid idempotency.

Two defects are covered here:
  * H10 — the gateway generated a fresh random UUID per delivery and flow-engine
    used it as the idempotency key, so a Meta re-delivery produced a second AI
    reply. The key is now Meta's own wamid (or wamid:status:timestamp).
  * Status callbacks — `statuses` events were dropped entirely, so delivery,
    read and failure state was never recorded.
"""
from __future__ import annotations

import json
from typing import Any

import pytest

from flow_engine.domain.models import MessageStatusEvent
from flow_engine.interfaces.consumer import (
    FlowEngineConsumer,
    _parse_message,
    _parse_status,
)


class _FakeRedis:
    """Minimal Redis stub covering the commands the consumer touches."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.acked: list[str] = []
        self.xadded: list[tuple[str, dict[str, Any]]] = []

    def get(self, key: str) -> str | None:
        return self.store.get(key)

    def set(self, key: str, value: str, ex: int | None = None) -> bool:
        self.store[key] = value
        return True

    def xack(self, stream: str, group: str, message_id: str) -> int:
        self.acked.append(message_id)
        return 1

    def xadd(self, stream: str, fields: dict[str, Any], **kwargs: Any) -> str:
        self.xadded.append((stream, fields))
        return "1-0"

    def incr(self, key: str) -> int:
        current = int(self.store.get(key, "0")) + 1
        self.store[key] = str(current)
        return current

    def expire(self, key: str, seconds: int) -> bool:
        return True


class _RecordingStatusRepo:
    def __init__(self) -> None:
        self.events: list[MessageStatusEvent] = []

    def record(self, event: MessageStatusEvent) -> None:
        self.events.append(event)


class _ExplodingExecutor:
    def execute(self, *args: Any, **kwargs: Any) -> list[str]:
        raise AssertionError("executor must not run for status envelopes")


def _status_envelope(
    tenant_id: str = "11111111-1111-1111-1111-111111111111",
    status: str = "delivered",
    timestamp: str = "1737000000",
) -> dict[str, str]:
    payload = {
        "message_id": "trace-uuid",
        "wamid": f"wamid.ABC:{status}:{timestamp}",
        "kind": "status",
        "received_at": "2026-01-01T00:00:00+00:00",
        "tenant_id": tenant_id,
        "phone_number_id": "PN1",
        "raw": {
            "messaging_product": "whatsapp",
            "metadata": {"phone_number_id": "PN1"},
            "statuses": [
                {
                    "id": "wamid.ABC",
                    "status": status,
                    "timestamp": timestamp,
                    "recipient_id": "521234567890",
                    "conversation": {"id": "conv-1"},
                    "pricing": {"category": "utility"},
                }
            ],
        },
    }
    return {"kind": "status", "data": json.dumps(payload)}


def _consumer(redis: _FakeRedis, repo: _RecordingStatusRepo) -> FlowEngineConsumer:
    return FlowEngineConsumer(
        redis_client=redis,  # type: ignore[arg-type]
        executor=_ExplodingExecutor(),  # type: ignore[arg-type]
        session_repo=object(),  # type: ignore[arg-type]
        conv_log_repo=object(),  # type: ignore[arg-type]
        tenant_credentials_repo=object(),  # type: ignore[arg-type]
        meta_send=object(),
        message_status_repo=repo,
    )


def test_parse_status_extracts_delivery_details() -> None:
    event = _parse_status(_status_envelope())
    assert event.tenant_id == "11111111-1111-1111-1111-111111111111"
    assert event.wamid == "wamid.ABC"
    assert event.status == "delivered"
    assert event.recipient_id == "521234567890"
    assert event.conversation_id == "conv-1"
    assert event.pricing_category == "utility"
    assert event.occurred_at is not None and event.occurred_at.startswith("2025-01-16")


def test_parse_status_captures_failure_error() -> None:
    envelope = _status_envelope(status="failed")
    payload = json.loads(envelope["data"])
    payload["raw"]["statuses"][0]["errors"] = [
        {"code": 131047, "title": "Re-engagement message"}
    ]
    envelope["data"] = json.dumps(payload)

    event = _parse_status(envelope)
    assert event.status == "failed"
    assert event.error_code == "131047"
    assert event.error_title == "Re-engagement message"


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(lambda p: p["raw"].update({"statuses": []}), id="no-statuses"),
        pytest.param(
            lambda p: p["raw"]["statuses"][0].pop("id"), id="missing-wamid"
        ),
    ],
)
def test_parse_status_rejects_malformed(mutate: Any) -> None:
    envelope = _status_envelope()
    payload = json.loads(envelope["data"])
    mutate(payload)
    envelope["data"] = json.dumps(payload)
    with pytest.raises((KeyError, ValueError)):
        _parse_status(envelope)


def test_status_envelope_is_recorded_and_acked() -> None:
    redis = _FakeRedis()
    repo = _RecordingStatusRepo()
    consumer = _consumer(redis, repo)

    consumer._process("flow-engine:tenant", "1-0", _status_envelope())

    assert len(repo.events) == 1
    assert repo.events[0].status == "delivered"
    assert redis.acked == ["1-0"]


def test_duplicate_status_delivery_is_skipped() -> None:
    """Meta retries deliveries — the same transition must be recorded once."""
    redis = _FakeRedis()
    repo = _RecordingStatusRepo()
    consumer = _consumer(redis, repo)

    consumer._process("flow-engine:tenant", "1-0", _status_envelope())
    consumer._process("flow-engine:tenant", "2-0", _status_envelope())

    assert len(repo.events) == 1


def test_status_transitions_are_not_collapsed() -> None:
    """sent → delivered → read must each be recorded."""
    redis = _FakeRedis()
    repo = _RecordingStatusRepo()
    consumer = _consumer(redis, repo)

    for i, status in enumerate(["sent", "delivered", "read"]):
        consumer._process(
            "flow-engine:tenant", f"{i}-0", _status_envelope(status=status, timestamp=f"17370000{i:02d}")
        )

    assert [e.status for e in repo.events] == ["sent", "delivered", "read"]


def test_status_without_repo_is_acked_not_retried() -> None:
    redis = _FakeRedis()
    consumer = FlowEngineConsumer(
        redis_client=redis,  # type: ignore[arg-type]
        executor=_ExplodingExecutor(),  # type: ignore[arg-type]
        session_repo=object(),  # type: ignore[arg-type]
        conv_log_repo=object(),  # type: ignore[arg-type]
        tenant_credentials_repo=object(),  # type: ignore[arg-type]
        meta_send=object(),
        message_status_repo=None,
    )
    consumer._process("flow-engine:tenant", "9-0", _status_envelope())
    assert redis.acked == ["9-0"]


def test_parse_message_uses_meta_wamid_as_identity() -> None:
    payload = {
        "message_id": "trace-uuid",
        "wamid": "wamid.REAL",
        "kind": "message",
        "received_at": "2026-01-01T00:00:00+00:00",
        "tenant_id": "t1",
        "phone_number_id": "PN1",
        "raw": {
            "messaging_product": "whatsapp",
            "metadata": {"phone_number_id": "PN1"},
            "contacts": [{"wa_id": "521234567890"}],
            "messages": [
                {
                    "from": "521234567890",
                    "id": "wamid.REAL",
                    "timestamp": "1737000000",
                    "type": "interactive",
                    "text": {"body": "hello"},
                }
            ],
        },
    }
    msg = _parse_message({"kind": "message", "data": json.dumps(payload)})
    assert msg.wamid == "wamid.REAL"
    assert msg.message_type == "interactive"
    assert msg.text == "hello"


def test_status_idempotency_key_distinguishes_transitions() -> None:
    sent = MessageStatusEvent(tenant_id="t", wamid="w", status="sent", occurred_at="1")
    read = MessageStatusEvent(tenant_id="t", wamid="w", status="read", occurred_at="2")
    resent = MessageStatusEvent(tenant_id="t", wamid="w", status="sent", occurred_at="1")
    assert sent.idempotency_key != read.idempotency_key
    assert sent.idempotency_key == resent.idempotency_key
