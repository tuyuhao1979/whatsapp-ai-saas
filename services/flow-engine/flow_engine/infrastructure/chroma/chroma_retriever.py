"""ChromaDB retriever: queries the per-tenant vector collection.

Collection naming mirrors rag-indexer: ``tenant_{tenantId_no_hyphens}``.
Embedder model: sentence-transformers/all-MiniLM-L6-v2 (384 dimensions).
"""
from __future__ import annotations

import logging
from typing import Any, cast

import chromadb
from chromadb.api.types import IncludeEnum

from flow_engine.domain.ports import IVectorStore

logger = logging.getLogger(__name__)


class ChromaRetriever(IVectorStore):
    def __init__(self, host: str, port: int, auth_token: str, embedder: Any) -> None:
        # ChromaDB is started with token authentication (audit finding H3), so
        # every request has to carry the bearer token. The client performs an
        # authenticated identity call while being constructed, so a missing or
        # wrong token raises from inside the SDK — this guard turns that into a
        # named error naming the cause, before the first query.
        if not auth_token:
            raise ValueError("ChromaRetriever requires a non-empty auth_token")
        self._client = chromadb.HttpClient(
            host=host,
            port=port,
            headers={"Authorization": f"Bearer {auth_token}"},
        )
        self._embedder = embedder  # same LocalEmbedder as rag-indexer

    def query(
        self,
        tenant_id: str,
        query_text: str,
        top_k: int = 5,
    ) -> list[tuple[str, float]]:
        """Return up to top_k (text, similarity_score) tuples.

        Similarity score is 1.0 - cosine_distance; higher is better.
        Returns [] if the collection doesn't exist yet (no KB indexed).
        """
        collection_name = f"tenant_{tenant_id.replace('-', '')}"
        try:
            collection = self._client.get_collection(collection_name)
        except Exception:  # noqa: BLE001 — Chroma raises unrelated types for a
            # missing collection; the intended behaviour is "no KB yet" -> no
            # RAG context, never a failed reply.
            logger.debug(
                "No ChromaDB collection for tenant",
                extra={"tenant_id": tenant_id, "collection": collection_name},
            )
            return []

        query_embedding: list[float] = self._embedder.embed([query_text])[0]

        try:
            results = collection.query(
                # Same union-vs-list mismatch as rag-indexer's upsert: cast the
                # value the HTTP API accepts.
                query_embeddings=cast(Any, [query_embedding]),
                n_results=min(top_k, 20),
                # IncludeEnum, not the equivalent strings: chromadb's own stubs
                # type this as list[IncludeEnum] (the values are str-backed, so
                # both work at runtime, but only the enum type-checks).
                include=[IncludeEnum.documents, IncludeEnum.distances],
            )
        except Exception:
            logger.exception(
                "ChromaDB query failed",
                extra={"tenant_id": tenant_id},
            )
            return []

        # Bind to locals first: mypy cannot narrow a repeated subscript of a
        # TypedDict whose value is `list[...] | None`, so the previous
        # `results["documents"][0] if results.get("documents") else []` was an
        # error -- and would also have raised TypeError if the key were present
        # but null.
        raw_documents = results["documents"]
        raw_distances = results["distances"]
        docs: list[str] = list(raw_documents[0]) if raw_documents else []
        distances: list[float] = list(raw_distances[0]) if raw_distances else []

        # Convert cosine distance [0, 2] to similarity score [0, 1]
        return [
            (doc, max(0.0, 1.0 - dist))
            for doc, dist in zip(docs, distances, strict=False)
        ]
