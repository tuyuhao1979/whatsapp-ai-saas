"""The ChromaDB client must authenticate (audit finding H3).

ChromaDB runs with token authentication, so a client built without the bearer
token is refused. chromadb 0.5.23 raises from inside the SDK while constructing
the client, so the guard here is about *when and how clearly* the failure
appears: the vector store is built during startup, and a ValueError naming the
variable beats a ChromaAuthError traceback from library internals.

These tests cover the wiring; tests/integration/test_chroma_auth.py proves this
class against a real authenticated server.
"""
from __future__ import annotations

from typing import ClassVar

import pytest

chromadb = pytest.importorskip("chromadb")

from flow_engine.infrastructure.chroma import chroma_retriever  # noqa: E402
from flow_engine.infrastructure.chroma.chroma_retriever import ChromaRetriever  # noqa: E402


class _FakeHttpClient:
    """Captures the constructor arguments instead of dialling a server."""

    last_kwargs: ClassVar[dict[str, object]] = {}

    def __init__(self, **kwargs: object) -> None:
        _FakeHttpClient.last_kwargs = kwargs


@pytest.fixture
def patched_client(monkeypatch: pytest.MonkeyPatch) -> type[_FakeHttpClient]:
    monkeypatch.setattr(chroma_retriever.chromadb, "HttpClient", _FakeHttpClient)
    return _FakeHttpClient


def test_client_sends_the_bearer_token(patched_client: type[_FakeHttpClient]) -> None:
    ChromaRetriever(host="chromadb", port=8000, auth_token="s3cret", embedder=object())

    assert patched_client.last_kwargs["host"] == "chromadb"
    assert patched_client.last_kwargs["port"] == 8000
    assert patched_client.last_kwargs["headers"] == {"Authorization": "Bearer s3cret"}


def test_refuses_to_build_without_a_token(patched_client: type[_FakeHttpClient]) -> None:
    with pytest.raises(ValueError, match="auth_token"):
        ChromaRetriever(host="chromadb", port=8000, auth_token="", embedder=object())


def test_no_client_is_constructed_when_the_token_is_missing(
    patched_client: type[_FakeHttpClient],
) -> None:
    """The guard runs before the SDK call, so a misconfigured service never
    reaches the network with an unauthenticated client."""
    patched_client.last_kwargs = {}
    with pytest.raises(ValueError):
        ChromaRetriever(host="chromadb", port=8000, auth_token="", embedder=object())
    assert patched_client.last_kwargs == {}
