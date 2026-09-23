"""Domain models for the Flow Engine service."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass
class Session:
    tenant_id: str
    wa_id: str
    state: Literal["IDLE", "IN_FLOW", "LLM_FALLBACK", "ERROR"]
    flow_id: str | None
    current_node: str | None
    slots: dict[str, Any]
    history: list[dict[str, Any]]  # last 10 turns: [{role, content, ts}]
    retry_count: int
    started_at: str   # ISO datetime
    last_msg_at: str  # ISO datetime

    @classmethod
    def new(cls, tenant_id: str, wa_id: str, now: str) -> Session:
        return cls(
            tenant_id=tenant_id,
            wa_id=wa_id,
            state="IDLE",
            flow_id=None,
            current_node=None,
            slots={},
            history=[],
            retry_count=0,
            started_at=now,
            last_msg_at=now,
        )

    def to_hash(self) -> dict[str, str]:
        """Serialize to Redis Hash fields (all values are strings)."""
        return {
            "tenant_id": self.tenant_id,
            "wa_id": self.wa_id,
            "state": self.state,
            "flow_id": self.flow_id or "",
            "current_node": self.current_node or "",
            "slots": json.dumps(self.slots),
            "history": json.dumps(self.history),
            "retry_count": str(self.retry_count),
            "started_at": self.started_at,
            "last_msg_at": self.last_msg_at,
        }

    @classmethod
    def from_hash(cls, data: dict[str, str]) -> Session:
        """Deserialize from Redis Hash fields."""
        return cls(
            tenant_id=data["tenant_id"],
            wa_id=data["wa_id"],
            state=data["state"],  # type: ignore[arg-type]
            flow_id=data["flow_id"] or None,
            current_node=data["current_node"] or None,
            slots=json.loads(data.get("slots", "{}")),
            history=json.loads(data.get("history", "[]")),
            retry_count=int(data.get("retry_count", "0")),
            started_at=data["started_at"],
            last_msg_at=data["last_msg_at"],
        )


@dataclass
class FlowNode:
    id: str
    node_type: str
    config: dict[str, Any]
    transitions: list[dict[str, Any]]  # [{condition, next_node}]


@dataclass
class Flow:
    id: str
    tenant_id: str
    name: str
    trigger: dict[str, Any]  # {type: keyword_match|regex_match|always, keywords?, regex?}
    entry_node: str
    nodes: dict[str, FlowNode]  # node_id -> FlowNode
    is_active: bool


@dataclass
class ConversationTurn:
    tenant_id: str
    wa_id: str
    flow_id: str | None
    direction: Literal["inbound", "outbound"]
    message_type: str                      # text | interactive | status | ...
    content: dict[str, Any]                # JSONB payload (no message body by default)
    node_key: str | None
    llm_tokens: int
    latency_ms: int | None
    created_at: str


@dataclass
class MessageStatusEvent:
    """A Meta delivery/read/failure callback for a previously sent message."""

    tenant_id: str
    wamid: str                             # Meta message id the status refers to
    status: str                            # sent | delivered | read | failed | ...
    recipient_id: str | None = None
    occurred_at: str | None = None         # ISO 8601
    error_code: str | None = None
    error_title: str | None = None
    conversation_id: str | None = None
    pricing_category: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def idempotency_key(self) -> str:
        """Stable key for deduplicating Meta's repeated status deliveries."""
        return f"status:{self.wamid}:{self.status}:{self.occurred_at or ''}"


@dataclass
class InboundMessage:
    message_id: str
    tenant_id: str
    phone_number_id: str
    wa_id: str
    text: str
    timestamp: str
    access_token: str  # decrypted at consumer, passed through
    wamid: str = ""  # Meta message id — the idempotency key (H10)
    message_type: str = "text"

    @classmethod
    def from_stream_fields(cls, fields: dict[str, str]) -> InboundMessage:
        return cls(
            message_id=fields["message_id"],
            tenant_id=fields["tenant_id"],
            phone_number_id=fields.get("phone_number_id", ""),
            wa_id=fields.get("wa_id", ""),
            text=fields.get("text", ""),
            timestamp=fields.get("timestamp", ""),
            access_token=fields.get("access_token", ""),
            wamid=fields.get("wamid", ""),
            message_type=fields.get("message_type", "text"),
        )
