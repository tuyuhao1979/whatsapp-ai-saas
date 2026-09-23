"""Domain models for the RAG Indexer service."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class IndexingJob:
    """Represents a document indexing job received from a Redis Stream message."""

    job_id: str
    tenant_id: str
    document_id: str
    storage_uri: str
    source_type: str  # "text" | "pdf" | "faq_json" | "markdown"
    name: str
    embedder: str
    enqueued_at: str

    @classmethod
    def from_stream_message(cls, fields: dict[str, str]) -> IndexingJob:
        """Build an IndexingJob from a raw Redis Streams message dict."""
        return cls(
            job_id=fields["job_id"],
            tenant_id=fields["tenant_id"],
            document_id=fields["document_id"],
            storage_uri=fields["storage_uri"],
            source_type=fields["source_type"],
            name=fields.get("name", ""),
            embedder=fields.get("embedder", "all-MiniLM-L6-v2"),
            enqueued_at=fields.get("enqueued_at", ""),
        )


@dataclass
class DocumentChunk:
    """A single text chunk with its embedding, ready for vector store upsert."""

    id: str              # f"{document_id}_{chunk_index}"
    tenant_id: str
    document_id: str
    document_name: str
    chunk_index: int
    text: str
    embedding: list[float] = field(default_factory=list)

    @classmethod
    def build(
        cls,
        document_id: str,
        tenant_id: str,
        document_name: str,
        chunk_index: int,
        text: str,
    ) -> DocumentChunk:
        return cls(
            id=f"{document_id}_{chunk_index}",
            tenant_id=tenant_id,
            document_id=document_id,
            document_name=document_name,
            chunk_index=chunk_index,
            text=text,
        )
