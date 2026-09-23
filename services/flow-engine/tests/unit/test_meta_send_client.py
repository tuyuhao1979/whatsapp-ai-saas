"""Outbound Meta send: configurable base URL, transient-failure retry, wamid.

Before the fix the client hard-coded graph.facebook.com (so META_API_BASE was
dead config), performed no retry at all, and returned nothing — leaving
delivery status callbacks impossible to correlate.
"""
from __future__ import annotations

from typing import Any

import httpx
import pytest

from flow_engine.infrastructure.meta import meta_send_client as mod
from flow_engine.infrastructure.meta.meta_send_client import (
    MetaSendClient,
    RecordingMetaSendClient,
)


class _FakeResponse:
    def __init__(self, status_code: int, body: Any = None, headers: dict[str, str] | None = None):
        self.status_code = status_code
        self._body = body if body is not None else {}
        self.headers = headers or {}
        self.url = "https://example.invalid/123/messages"

    def json(self) -> Any:
        return self._body

    @property
    def text(self) -> str:
        return str(self._body)

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}",
                request=httpx.Request("POST", self.url),
                response=httpx.Response(self.status_code),
            )


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mod.time, "sleep", lambda _seconds: None)


def test_uses_configured_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """META_API_BASE must actually reach the request URL."""
    seen: list[str] = []

    def fake_post(url: str, **kwargs: Any) -> _FakeResponse:
        seen.append(url)
        return _FakeResponse(200, {"messages": [{"id": "wamid.X"}]})

    monkeypatch.setattr(mod.httpx, "post", fake_post)
    client = MetaSendClient(base_url="https://graph.facebook.com/v21.0")
    client.send_text("123", "5212345", "hi", "token")

    assert seen == ["https://graph.facebook.com/v21.0/123/messages"]


def test_retries_on_429_then_succeeds(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts: list[int] = []

    def fake_post(url: str, **kwargs: Any) -> _FakeResponse:
        attempts.append(1)
        if len(attempts) == 1:
            return _FakeResponse(429, {"error": "rate limited"}, {"Retry-After": "1"})
        return _FakeResponse(200, {"messages": [{"id": "wamid.OK"}]})

    monkeypatch.setattr(mod.httpx, "post", fake_post)
    client = MetaSendClient(max_attempts=3)
    wamid = client.send_text("123", "5212345", "hi", "token")

    assert len(attempts) == 2
    assert wamid == "wamid.OK"


def test_retries_on_5xx_then_succeeds(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts: list[int] = []

    def fake_post(url: str, **kwargs: Any) -> _FakeResponse:
        attempts.append(1)
        if len(attempts) < 3:
            return _FakeResponse(503, {})
        return _FakeResponse(200, {"messages": [{"id": "wamid.3"}]})

    monkeypatch.setattr(mod.httpx, "post", fake_post)
    client = MetaSendClient(max_attempts=3)
    assert client.send_text("123", "5212345", "hi", "token") == "wamid.3"
    assert len(attempts) == 3


def test_raises_after_exhausting_attempts(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_post(url: str, **kwargs: Any) -> _FakeResponse:
        return _FakeResponse(500, {})

    monkeypatch.setattr(mod.httpx, "post", fake_post)
    client = MetaSendClient(max_attempts=2)
    with pytest.raises(httpx.HTTPStatusError):
        client.send_text("123", "5212345", "hi", "token")


def test_does_not_retry_on_4xx_client_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 400 (bad token / bad payload) must fail fast, not burn the retry budget."""
    attempts: list[int] = []

    def fake_post(url: str, **kwargs: Any) -> _FakeResponse:
        attempts.append(1)
        return _FakeResponse(400, {"error": {"message": "Invalid OAuth access token"}})

    monkeypatch.setattr(mod.httpx, "post", fake_post)
    client = MetaSendClient(max_attempts=3)
    with pytest.raises(httpx.HTTPStatusError):
        client.send_text("123", "5212345", "hi", "expired-token")
    assert len(attempts) == 1


def test_returns_none_when_meta_omits_message_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mod.httpx, "post", lambda url, **kw: _FakeResponse(200, {}))
    assert MetaSendClient().send_text("1", "2", "hi", "t") is None


def test_recording_client_returns_wamid() -> None:
    """Dry-run must behave like production for wamid correlation."""
    recorder = RecordingMetaSendClient()
    assert recorder.send_text("1", "2", "hi", "t") is not None
    assert len(recorder.sent) == 1
