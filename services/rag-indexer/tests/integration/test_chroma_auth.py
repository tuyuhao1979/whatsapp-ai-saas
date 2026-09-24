"""The shipped ChromaDB client against a real, authenticated server.

The unit tests assert the bearer header is passed to the SDK. This is the other
half of audit finding H3: that the server actually accepts a write from
ChromaVectorStore, and refuses everything else.

Skipped unless a server is configured, so `pytest tests/` stays runnable without
Docker. CI points it at the chromadb service container (see ci-python.yml):
    CHROMA_INTEGRATION_URL=http://127.0.0.1:8000
    CHROMA_AUTH_TOKEN=<the server's CHROMA_SERVER_AUTHN_CREDENTIALS>
"""
from __future__ import annotations

import os
import urllib.parse

import pytest

chromadb = pytest.importorskip("chromadb")

from rag_indexer.domain.models import DocumentChunk  # noqa: E402
from rag_indexer.infrastructure.chroma_store import ChromaVectorStore  # noqa: E402

_URL = os.environ.get("CHROMA_INTEGRATION_URL", "")
_TOKEN = os.environ.get("CHROMA_AUTH_TOKEN", "")
_TENANT = "integration-auth-check"
_COLLECTION = f"tenant_{_TENANT.replace('-', '')}"
_VECTOR = [0.11, 0.22, 0.33]

pytestmark = pytest.mark.skipif(
    not (_URL and _TOKEN),
    reason="set CHROMA_INTEGRATION_URL and CHROMA_AUTH_TOKEN to run against a real ChromaDB",
)


def _host_port() -> tuple[str, int]:
    parsed = urllib.parse.urlparse(_URL)
    return parsed.hostname or "127.0.0.1", parsed.port or 8000


def _chunk() -> DocumentChunk:
    return DocumentChunk(
        id=f"{_TENANT}-chunk-0",
        tenant_id=_TENANT,
        document_id="doc-1",
        document_name="handbook.md",
        chunk_index=0,
        text="the knowledge base answer",
        embedding=_VECTOR,
    )


def test_authenticated_store_writes_a_document() -> None:
    host, port = _host_port()
    store = ChromaVectorStore(host=host, port=port, auth_token=_TOKEN)

    store.upsert(_TENANT, [_chunk()])

    # Read back with a separate authenticated client: the assertion is about
    # what the authenticated store actually put on the server.
    reader = chromadb.HttpClient(
        host=host, port=port, headers={"Authorization": f"Bearer {_TOKEN}"},
    )
    stored = reader.get_collection(_COLLECTION).get(ids=[_chunk().id])
    assert stored["documents"] == ["the knowledge base answer"]


@pytest.mark.parametrize("header", ["", "Bearer wrong-token"])
def test_server_refuses_a_client_without_valid_credentials(header: str) -> None:
    host, port = _host_port()
    headers = {"Authorization": header} if header else {}

    # chromadb 0.5.23 performs an authenticated identity call while building the
    # client, so a rejected credential raises here rather than on the first
    # write. That is the loud failure the constructor guard is there to reach
    # early and legibly: without it the traceback lands inside the SDK.
    with pytest.raises(Exception) as excinfo:
        client = chromadb.HttpClient(host=host, port=port, headers=headers)
        client.get_or_create_collection("h3_should_not_exist").upsert(
            ids=["x"], embeddings=[_VECTOR], documents=["x"],
        )

    assert "Forbidden" in str(excinfo.value) or "AuthError" in type(excinfo.value).__name__
