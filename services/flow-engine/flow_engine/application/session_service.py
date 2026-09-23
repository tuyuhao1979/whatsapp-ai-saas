"""SessionService: load, save, and manage conversation sessions."""
from __future__ import annotations

import logging
from datetime import UTC, datetime

from flow_engine.domain.models import Session
from flow_engine.domain.ports import ISessionRepo

logger = logging.getLogger(__name__)


class SessionService:
    """Orchestrates session lifecycle operations."""

    def __init__(self, session_repo: ISessionRepo) -> None:
        self._repo = session_repo

    def load_or_create(self, tenant_id: str, wa_id: str) -> Session:
        """Load an existing session or create a fresh IDLE one."""
        session = self._repo.load(tenant_id, wa_id)
        if session is None:
            now = _now_iso()
            session = Session.new(tenant_id, wa_id, now)
            logger.info(
                "New session created",
                extra={"tenant_id": tenant_id, "wa_id": wa_id},
            )
        return session

    def save(self, session: Session) -> None:
        session.last_msg_at = _now_iso()
        self._repo.save(session)

    def reset(self, tenant_id: str, wa_id: str) -> None:
        """Delete session and any associated locks."""
        self._repo.delete(tenant_id, wa_id)
        logger.info(
            "Session reset",
            extra={"tenant_id": tenant_id, "wa_id": wa_id},
        )


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()
