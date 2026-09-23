"""Meta Graph API client for sending WhatsApp messages.

Implements IMetaSendPort for both production and test/dry-run use cases.
"""
from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from flow_engine.domain.ports import IMetaSendPort

logger = logging.getLogger(__name__)

_WA_TEXT_LIMIT = 4096


class MetaSendClient(IMetaSendPort):
    """Production client — POSTs to the Meta Cloud API.

    - Base URL is configurable (META_API_BASE) so non-production deployments can
      target a mock/sandbox without patching code.
    - Transient failures (429, 5xx, connection errors) are retried with bounded
      exponential backoff, honouring Retry-After when present.
    - Returns the Meta message id (wamid) of the accepted message so the caller
      can correlate delivery/read callbacks.
    """

    DEFAULT_BASE_URL = "https://graph.facebook.com/v21.0"

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        timeout_s: float = 10.0,
        max_attempts: int = 3,
        backoff_base_s: float = 0.5,
    ) -> None:
        self._base_url = (base_url or self.DEFAULT_BASE_URL).rstrip("/")
        self._timeout_s = timeout_s
        self._max_attempts = max(1, max_attempts)
        self._backoff_base_s = backoff_base_s

    def send_text(
        self,
        phone_number_id: str,
        to: str,
        text: str,
        access_token: str,
    ) -> str | None:
        payload: dict[str, Any] = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "text",
            "text": {"body": text[:_WA_TEXT_LIMIT]},
        }
        return self._post(phone_number_id, payload, access_token, to)

    def send_interactive(
        self,
        phone_number_id: str,
        to: str,
        payload: dict[str, Any],
        access_token: str,
    ) -> str | None:
        envelope: dict[str, Any] = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            **payload,
        }
        return self._post(phone_number_id, envelope, access_token, to)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _post(
        self,
        phone_number_id: str,
        envelope: dict[str, Any],
        access_token: str,
        to: str,
    ) -> str | None:
        url = f"{self._base_url}/{phone_number_id}/messages"
        last_error: Exception | None = None

        for attempt in range(1, self._max_attempts + 1):
            try:
                resp = httpx.post(
                    url,
                    json=envelope,
                    headers={"Authorization": f"Bearer {access_token}"},
                    timeout=self._timeout_s,
                )
            except httpx.RequestError as exc:
                last_error = exc
                if attempt == self._max_attempts:
                    logger.warning(
                        "Meta send failed after retries",
                        extra={"phone_number_id": phone_number_id, "attempt": attempt},
                    )
                    raise
                _sleep_backoff(self._backoff_base_s, attempt)
                continue

            if resp.status_code == 429 or 500 <= resp.status_code < 600:
                if attempt == self._max_attempts:
                    resp.raise_for_status()
                retry_after = resp.headers.get("Retry-After")
                logger.warning(
                    "Meta send retryable status",
                    extra={
                        "phone_number_id": phone_number_id,
                        "status_code": resp.status_code,
                        "attempt": attempt,
                    },
                )
                _sleep_backoff(self._backoff_base_s, attempt, retry_after)
                continue

            resp.raise_for_status()
            logger.debug(
                "Message sent",
                extra={"phone_number_id": phone_number_id, "to": to},
            )
            return _extract_wamid(resp)

        if last_error is not None:  # pragma: no cover — loop always returns/raises
            raise last_error
        return None


def _extract_wamid(resp: httpx.Response) -> str | None:
    """Read the accepted message id out of a Graph API send response."""
    try:
        body = resp.json()
    except ValueError:
        return None
    messages = body.get("messages") if isinstance(body, dict) else None
    if not messages:
        return None
    first = messages[0]
    wamid = first.get("id") if isinstance(first, dict) else None
    return str(wamid) if wamid else None


def _sleep_backoff(base_s: float, attempt: int, retry_after: str | None = None) -> None:
    """Sleep before the next attempt, preferring the server's Retry-After."""
    delay = base_s * (2 ** (attempt - 1))
    if retry_after:
        try:
            delay = max(delay, float(retry_after))
        except (TypeError, ValueError):
            # A malformed Retry-After must not fail the send; fall back to the
            # computed backoff.
            pass
    time.sleep(min(delay, 30.0))


class RecordingMetaSendClient(IMetaSendPort):
    """Test / dry-run client — records all outbound messages in memory."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    def send_text(
        self,
        phone_number_id: str,
        to: str,
        text: str,
        access_token: str,
    ) -> str | None:
        self.sent.append({"type": "text", "to": to, "text": text})
        return f"wamid.DRYRUN.{len(self.sent)}"

    def send_interactive(
        self,
        phone_number_id: str,
        to: str,
        payload: dict[str, Any],
        access_token: str,
    ) -> str | None:
        self.sent.append({"type": "interactive", "to": to, "payload": payload})
        return f"wamid.DRYRUN.{len(self.sent)}"
