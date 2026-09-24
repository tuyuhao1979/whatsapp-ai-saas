"""The shipped ChromaDB client against a real, authenticated server.

The unit tests assert the bearer header is passed to the SDK. This is the other
half of audit finding H3: that the server actually accepts it, and refuses
everything else — proved with ChromaRetriever itself rather than a hand-rolled
HTTP request standing in for it.

Skipped unless a server is configured, so `pytest tests/` stays runnable without
Docker. CI points it at the chromadb service container (see ci-python.yml):
    CHROMA_INTEGRATION_URL=http://127.0.0.1:8000
    CHROMA_AUTH_TOKEN=<the server's CHROMA_SERVER_AUTHN_CREDENTIALS>
"""
from __future__ import annotations

import os
import urllib.parse
from typing import Any

import pytest

chromadb = pytest.importorskip("chromadb")

from flow_engine.infrastructure.chroma.chroma_retriever import ChromaRetriever  # noqa: E402

_URL = os.environ.get("CHROMA_INTEGRATION_URL", "")
_TOKEN = os.environ.get("CHROMA_AUTH_TOKEN", "")
_TENANT = "integration-auth-check"
_COLLECTION = f"tenant_{_TENANT.replace('-', '')}"
_VECTOR = [0.11, 0.22, 0.33]

pytestmark = pytest.mark.skipif(
    not (_URL and _TOKEN),
    reason="set CHROMA_INTEGRATION_URL and CHROMA_AUTH_TOKEN to run against a real ChromaDB",
)


class _FixedEmbedder:
    """Returns the same vector for any text, so no model download is needed."""

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [_VECTOR for _ in texts]


def _host_port() -> tuple[str, int]:
    parsed = urllib.parse.urlparse(_URL)
    return parsed.hostname or "127.0.0.1", parsed.port or 8000


def _seed_collection() -> None:
    """Write one document with an authenticated client, outside the class under
    test, so the assertion is about reading it back."""
    host, port = _host_port()
    client = chromadb.HttpClient(
        host=host, port=port, headers={"Authorization": f"Bearer {_TOKEN}"},
    )
    collection = client.get_or_create_collection(
        _COLLECTION, metadata={"hnsw:space": "cosine"},
    )
    collection.upsert(
        ids=[f"{_TENANT}-chunk-0"],
        embeddings=[_VECTOR],
        documents=["the knowledge base answer"],
    )


def test_authenticated_retriever_reads_a_document() -> None:
    _seed_collection()
    host, port = _host_port()
    retriever = ChromaRetriever(
        host=host, port=port, auth_token=_TOKEN, embedder=_FixedEmbedder(),
    )

    results = retriever.query(_TENANT, "anything", top_k=1)

    assert [text for text, _score in results] == ["the knowledge base answer"]


def test_retriever_returns_nothing_for_a_missing_collection() -> None:
    """The documented "no KB yet" path, which is also why an unauthenticated
    client would be invisible in production rather than loud."""
    host, port = _host_port()
    retriever = ChromaRetriever(
        host=host, port=port, auth_token=_TOKEN, embedder=_FixedEmbedder(),
    )

    assert retriever.query("tenant-without-documents", "anything") == []


@pytest.mark.parametrize("header", [None, "Bearer wrong-token"])
def test_server_refuses_a_client_without_valid_credentials(header: str | None) -> None:
    host, port = _host_port()
    headers: dict[str, Any] = {"Authorization": header} if header else {}

    # chromadb 0.5.23 performs an authenticated identity call while building the
    # client, so a rejected credential raises here rather than on the first
    # query. That is the loud failure the constructor guard is there to reach
    # early and legibly: without it the traceback lands inside the SDK.
    with pytest.raises(Exception) as excinfo:
        client = chromadb.HttpClient(host=host, port=port, headers=headers)
        client.get_or_create_collection("h3_should_not_exist").upsert(
            ids=["x"], embeddings=[_VECTOR], documents=["x"],
        )

    assert "Forbidden" in str(excinfo.value) or "AuthError" in type(excinfo.value).__name__
