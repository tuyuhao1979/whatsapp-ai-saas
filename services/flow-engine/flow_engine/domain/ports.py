"""Port interfaces (abstract base classes) for the Flow Engine domain."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from flow_engine.domain.models import (
    ConversationTurn,
    Flow,
    MessageStatusEvent,
    Session,
)


class ISessionRepo(ABC):
    @abstractmethod
    def load(self, tenant_id: str, wa_id: str) -> Session | None: ...

    @abstractmethod
    def save(self, session: Session) -> None: ...

    @abstractmethod
    def delete(self, tenant_id: str, wa_id: str) -> None: ...


class IFlowRepo(ABC):
    @abstractmethod
    def get_active_flows(self, tenant_id: str) -> list[Flow]: ...

    @abstractmethod
    def reload_tenant(self, tenant_id: str) -> None: ...


class ITenantCredentialsRepo(ABC):
    @abstractmethod
    def get_access_token(self, tenant_id: str, phone_number_id: str) -> str | None: ...


class IMetaSendPort(ABC):
    @abstractmethod
    def send_text(
        self,
        phone_number_id: str,
        to: str,
        text: str,
        access_token: str,
    ) -> str | None:
        """Send a text message; return the Meta message id (wamid) if provided."""

    @abstractmethod
    def send_interactive(
        self,
        phone_number_id: str,
        to: str,
        payload: dict[str, Any],
        access_token: str,
    ) -> str | None:
        """Send an interactive message; return the Meta message id if provided."""


class IVectorStore(ABC):
    @abstractmethod
    def query(
        self,
        tenant_id: str,
        query_text: str,
        top_k: int = 5,
    ) -> list[tuple[str, float]]: ...


class IConvLogRepo(ABC):
    @abstractmethod
    def write(self, turn: ConversationTurn) -> None: ...


class IMessageStatusRepo(ABC):
    """Persists Meta delivery/read/failure callbacks for outbound messages."""

    @abstractmethod
    def record(self, event: MessageStatusEvent) -> None: ...


class ILLMPort(ABC):
    @abstractmethod
    def generate(
        self,
        system_prompt: str,
        history: list[dict[str, Any]],
        user_message: str,
        rag_context: str | None = None,
        max_tokens: int = 500,
    ) -> tuple[str, int]: ...
