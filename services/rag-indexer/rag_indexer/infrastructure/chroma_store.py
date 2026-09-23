"""ChromaDB adapter: implements IVectorStore with one collection per tenant."""
from __future__ import annotations

import logging

import chromadb

from rag_indexer.domain.models import DocumentChunk
from rag_indexer.domain.ports import IVectorStore

logger = logging.getLogger(__name__)


def _collection_name(tenant_id: str) -> str:
    """Convert a tenant UUID to a valid ChromaDB collection name.

    ChromaDB collection names must match [a-zA-Z0-9_-]{3,63} and cannot
    contain hyphens at start/end or consecutive hyphens.
    We strip hyphens entirely to stay safe with UUID-formatted tenant IDs.
    """
    return f"tenant_{tenant_id.replace('-', '')}"


class ChromaVectorStore(IVectorStore):
    """Stores and retrieves document chunk embeddings via ChromaDB HTTP API."""

    def __init__(self, host: str, port: int) -> None:
        self._client = chromadb.HttpClient(host=host, port=port)

    def upsert(self, tenant_id: str, chunks: list[DocumentChunk]) -> None:
        """Upsert all chunks into the tenant's ChromaDB collection."""
        if not chunks:
            return

        collection_name = _collection_name(tenant_id)
        collection = self._client.get_or_create_collection(
            name=collection_name,
            metadata={"hnsw:space": "cosine"},
        )

        collection.upsert(
            ids=[c.id for c in chunks],
            embeddings=[c.embedding for c in chunks],
            documents=[c.text for c in chunks],
            metadatas=[
                {
                    "tenant_id": c.tenant_id,
                    "document_id": c.document_id,
                    "document_name": c.document_name,
                    "chunk_index": c.chunk_index,
                }
                for c in chunks
            ],
        )
        logger.info(
            "ChromaDB upsert complete",
            extra={"collection": collection_name, "chunk_count": len(chunks)},
        )

    def delete_by_document(self, tenant_id: str, document_id: str) -> None:
        """Delete all chunks belonging to *document_id* from the tenant collection."""
        collection_name = _collection_name(tenant_id)
        try:
            collection = self._client.get_collection(collection_name)
            collection.delete(where={"document_id": document_id})
            logger.info(
                "ChromaDB delete complete",
                extra={"collection": collection_name, "document_id": document_id},
            )
        except Exception:  # noqa: BLE001 — the collection may simply not exist
            # yet; deletion is idempotent and must not fail the job.
            logger.debug(
                "ChromaDB delete skipped (collection not found)",
                extra={"collection": collection_name},
            )
