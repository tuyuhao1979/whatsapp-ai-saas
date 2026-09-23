"""Abstract port definitions for the RAG Indexer service (hexagonal architecture)."""
from __future__ import annotations

import abc

from rag_indexer.domain.models import DocumentChunk


class IDocumentStore(abc.ABC):
    """Port for downloading raw document bytes from object storage."""

    @abc.abstractmethod
    def download(self, storage_uri: str) -> tuple[bytes, str]:
        """Download a document.

        Args:
            storage_uri: URI in format ``s3://{bucket}/{key}``.

        Returns:
            A tuple of (raw_bytes, content_type).
        """


class IVectorStore(abc.ABC):
    """Port for persisting and deleting document chunk embeddings."""

    @abc.abstractmethod
    def upsert(self, tenant_id: str, chunks: list[DocumentChunk]) -> None:
        """Upsert chunks into the tenant's vector collection."""

    @abc.abstractmethod
    def delete_by_document(self, tenant_id: str, document_id: str) -> None:
        """Delete all chunks belonging to a specific document."""


class IStatusRepo(abc.ABC):
    """Port for reading and writing document indexing status in Postgres."""

    @abc.abstractmethod
    def get_status(self, tenant_id: str, document_id: str) -> str | None:
        """Return current status string or None if document not found."""

    @abc.abstractmethod
    def set_indexing(self, tenant_id: str, document_id: str) -> None:
        """Transition document status to 'indexing'."""

    @abc.abstractmethod
    def set_indexed(self, tenant_id: str, document_id: str, chunk_count: int) -> None:
        """Transition document status to 'indexed' and record chunk_count + indexed_at."""

    @abc.abstractmethod
    def set_failed(
        self, tenant_id: str, document_id: str, error_message: str
    ) -> None:
        """Transition document status to 'failed' and record error_message."""
