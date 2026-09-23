"""IndexDocumentUseCase: orchestrates download → parse → chunk → embed → upsert."""
from __future__ import annotations

import abc
import json
import logging
import re
import signal
from collections.abc import Callable
from types import FrameType
from typing import Any

from rag_indexer.domain.models import DocumentChunk, IndexingJob
from rag_indexer.domain.ports import IDocumentStore, IStatusRepo, IVectorStore

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# IEmbedder port (application-layer; avoids circular import with infrastructure)
# ---------------------------------------------------------------------------


class IEmbedder(abc.ABC):
    """Port for text embedding — converts strings to dense float vectors."""

    @abc.abstractmethod
    def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed a batch of texts and return one vector per text."""


# ---------------------------------------------------------------------------
# Text extraction helpers
# ---------------------------------------------------------------------------


def _extract_text_plain(raw: bytes) -> str:
    return raw.decode("utf-8", errors="replace")


def _extract_text_pdf(raw: bytes) -> str:
    try:
        import io

        import pypdf

        reader = pypdf.PdfReader(io.BytesIO(raw))
        parts: list[str] = []
        for page in reader.pages:
            text = page.extract_text() or ""
            text = text.strip()
            if text:
                parts.append(text)
        return "\n\n".join(parts)
    except Exception as exc:
        raise ValueError(f"PDF extraction failed: {exc}") from exc


def _extract_text_faq_json(raw: bytes) -> str:
    try:
        items: list[dict[str, str]] = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid FAQ JSON: {exc}") from exc
    if not isinstance(items, list):
        # ValueError, not TypeError: the indexing pipeline maps ValueError to a
        # permanent "document failed" status, which is the right outcome for
        # malformed input. A TypeError would escape as a transient error and be
        # retried until the poison-message budget ran out.
        raise ValueError("FAQ JSON must be a list of {question, answer} objects")
    parts: list[str] = []
    for item in items:
        q = item.get("question", "").strip()
        a = item.get("answer", "").strip()
        if q or a:
            parts.append(f"Q: {q}\nA: {a}")
    return "\n\n".join(parts)


def _extract_text_markdown(raw: bytes) -> str:
    text = raw.decode("utf-8", errors="replace")
    # Strip common markdown syntax: headings, bold/italic, links, images, code fences
    text = re.sub(r"```[\s\S]*?```", " ", text)            # fenced code blocks
    text = re.sub(r"`[^`]+`", " ", text)                   # inline code
    text = re.sub(r"!\[.*?\]\(.*?\)", " ", text)           # images
    text = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", text)  # links → label
    text = re.sub(r"#{1,6}\s+", "", text)                  # headings
    text = re.sub(r"(\*\*|__)(.*?)\1", r"\2", text)       # bold
    text = re.sub(r"(\*|_)(.*?)\1", r"\2", text)           # italic
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)   # bullets
    text = re.sub(r"^\s*\d+\.\s+", "", text, flags=re.MULTILINE)   # numbered
    text = re.sub(r"\|.*\|", " ", text)                    # tables
    text = re.sub(r"-{3,}", " ", text)                     # horizontal rules
    text = re.sub(r"[ \t]+", " ", text)                    # collapse spaces
    text = re.sub(r"\n{3,}", "\n\n", text)                 # collapse blank lines
    return text.strip()


_EXTRACTORS = {
    "text": _extract_text_plain,
    "pdf": _extract_text_pdf,
    "faq_json": _extract_text_faq_json,
    "markdown": _extract_text_markdown,
}


def extract_text(raw: bytes, source_type: str) -> str:
    """Dispatch raw bytes to the appropriate text extractor."""
    extractor = _EXTRACTORS.get(source_type)
    if extractor is None:
        raise ValueError(f"Unknown source_type: {source_type!r}")
    return extractor(raw)


# ---------------------------------------------------------------------------
# Recursive character text splitter
# ---------------------------------------------------------------------------

_SEPARATORS = ["\n\n", "\n", ". ", " "]


def chunk_text(
    text: str,
    chunk_size: int = 512,
    overlap: int = 50,
) -> list[str]:
    """Split *text* into overlapping chunks of at most *chunk_size* characters.

    Uses a recursive separator strategy: tries paragraph → line → sentence →
    word boundaries in that order, choosing the coarsest separator that keeps
    chunks within *chunk_size*.
    """
    if not text or not text.strip():
        return []

    if len(text) <= chunk_size:
        return [text.strip()]

    def _split(text: str, separators: list[str]) -> list[str]:
        if not separators or len(text) <= chunk_size:
            return [text] if text.strip() else []
        sep, *rest_seps = separators
        parts = text.split(sep)
        merged: list[str] = []
        current = ""
        for part in parts:
            candidate = (current + sep + part) if current else part
            if len(candidate) <= chunk_size:
                current = candidate
            else:
                if current.strip():
                    merged.append(current)
                if len(part) > chunk_size:
                    sub_chunks = _split(part, rest_seps)
                    merged.extend(sub_chunks[:-1])
                    current = sub_chunks[-1] if sub_chunks else ""
                else:
                    current = part
        if current.strip():
            merged.append(current)
        return merged

    raw_chunks = _split(text, _SEPARATORS)
    if not raw_chunks:
        return []

    # Apply overlap: each chunk begins with the last `overlap` chars of the previous
    if overlap <= 0 or len(raw_chunks) == 1:
        return raw_chunks

    result: list[str] = [raw_chunks[0]]
    for chunk in raw_chunks[1:]:
        prev = result[-1]
        tail = prev[-overlap:] if len(prev) >= overlap else prev
        combined = tail + " " + chunk
        if len(combined) > chunk_size:
            combined = combined[:chunk_size]
        result.append(combined)
    return result


# ---------------------------------------------------------------------------
# Use case
# ---------------------------------------------------------------------------

_OPERATION_TIMEOUT_SECONDS = 600  # 10 minutes


class _TimeoutError(Exception):
    pass


def _timeout_handler(signum: int, frame: object) -> None:
    raise _TimeoutError("Indexing operation timed out after 10 minutes")


class IndexDocumentUseCase:
    """Orchestrates the full indexing pipeline for a single document."""

    def __init__(
        self,
        document_store: IDocumentStore,
        vector_store: IVectorStore,
        status_repo: IStatusRepo,
        embedder: IEmbedder,
    ) -> None:
        self._document_store = document_store
        self._vector_store = vector_store
        self._status_repo = status_repo
        self._embedder = embedder

    def execute(self, job: IndexingJob) -> None:
        """Process an indexing job end-to-end.

        Status lifecycle: pending → indexing → indexed | failed
        Raises on failure after persisting the failed status.
        """
        # Idempotency: skip if already indexed
        current_status = self._status_repo.get_status(job.tenant_id, job.document_id)
        if current_status == "indexed":
            logger.info(
                "Document already indexed — skipping",
                extra={"document_id": job.document_id, "tenant_id": job.tenant_id},
            )
            return

        # Install per-operation timeout via SIGALRM (Unix only).
        # signal.signal returns the previous handler, whose type is the union
        # signal.Handlers | Callable | int | None. It is stored as the same
        # union so it can be handed straight back to signal.signal.
        old_handler: signal.Handlers | Callable[[int, FrameType | None], Any] | int | None = None
        try:
            old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
            signal.alarm(_OPERATION_TIMEOUT_SECONDS)
        except (AttributeError, OSError):
            # SIGALRM not available on Windows — skip
            pass

        try:
            self._run(job)
        except Exception as exc:
            error_msg = str(exc)[:500]
            logger.error(
                "Indexing failed",
                extra={"document_id": job.document_id, "error": error_msg},
            )
            try:
                self._status_repo.set_failed(job.tenant_id, job.document_id, error_msg)
            except Exception:
                logger.exception("Failed to persist error status")
            raise
        finally:
            try:
                signal.alarm(0)
                if old_handler is not None:
                    signal.signal(signal.SIGALRM, old_handler)
            except (AttributeError, OSError):
                pass

    def _run(self, job: IndexingJob) -> None:
        # Step 1: mark as indexing
        self._status_repo.set_indexing(job.tenant_id, job.document_id)
        logger.info(
            "Started indexing",
            extra={"document_id": job.document_id, "source_type": job.source_type},
        )

        # Step 2: download from object storage
        raw_bytes, _content_type = self._document_store.download(job.storage_uri)

        # Step 3: extract text (PII risk — log metadata only, never content)
        text = extract_text(raw_bytes, job.source_type)
        logger.info(
            "Text extracted",
            extra={
                "document_id": job.document_id,
                "char_count": len(text),
                "source_type": job.source_type,
            },
        )

        # Step 4: chunk
        raw_chunks = chunk_text(text, chunk_size=512, overlap=50)
        if not raw_chunks:
            logger.warning(
                "No text extracted — marking as indexed with 0 chunks",
                extra={"document_id": job.document_id},
            )
            self._status_repo.set_indexed(job.tenant_id, job.document_id, 0)
            return

        # Step 5: embed (batched)
        embeddings = self._embedder.embed(raw_chunks)

        # Step 6: build DocumentChunk objects
        chunks = [
            DocumentChunk(
                id=f"{job.document_id}_{i}",
                tenant_id=job.tenant_id,
                document_id=job.document_id,
                document_name=job.name,
                chunk_index=i,
                text=raw_chunks[i],
                embedding=embeddings[i],
            )
            for i in range(len(raw_chunks))
        ]

        # Step 7: upsert to vector store
        self._vector_store.upsert(job.tenant_id, chunks)
        logger.info(
            "Upserted chunks to vector store",
            extra={"document_id": job.document_id, "chunk_count": len(chunks)},
        )

        # Step 8: update status to indexed
        self._status_repo.set_indexed(job.tenant_id, job.document_id, len(chunks))
        logger.info(
            "Indexing complete",
            extra={"document_id": job.document_id, "chunk_count": len(chunks)},
        )
