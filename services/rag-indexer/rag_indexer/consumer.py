"""Redis Streams consumer for the RAG Indexer.

Reads from ``indexing:{tenantId}`` streams using consumer groups,
re-claims stuck messages (XCLAIM), and dispatches to IndexDocumentUseCase.
"""
from __future__ import annotations

import logging
import socket
import time
from typing import Any, Optional

import redis

from rag_indexer.application.index_document import IndexDocumentUseCase
from rag_indexer.domain.models import IndexingJob
from rag_indexer.domain.ports import IVectorStore

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_GROUP_NAME = "rag-indexer-workers"
_CONSUMER_NAME = f"rag-indexer-{socket.gethostname()}"
_BLOCK_MS = 5_000
_XCLAIM_IDLE_MS = 10 * 60 * 1_000   # 10 minutes
_MAX_RETRIES = 3
_XCLAIM_CHECK_INTERVAL_S = 60       # seconds between PEL sweeps
_READ_COUNT = 5                      # messages per XREADGROUP batch


class IndexingConsumer:
    """Consumer group worker that processes ``indexing:*`` Redis Streams."""

    STREAM_PATTERN = "indexing:*"
    GROUP_NAME = _GROUP_NAME
    CONSUMER_NAME = _CONSUMER_NAME
    BLOCK_MS = _BLOCK_MS
    XCLAIM_IDLE_MS = _XCLAIM_IDLE_MS
    MAX_RETRIES = _MAX_RETRIES

    def __init__(
        self,
        redis_client: redis.Redis,
        use_case: IndexDocumentUseCase,
        vector_store: IVectorStore,
    ) -> None:
        self._redis = redis_client
        self._use_case = use_case
        self._vector_store = vector_store
        self._last_xclaim_check: float = 0.0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def run(self) -> None:
        """Blocking event loop — call this from main thread."""
        logger.info(
            "Starting consumer",
            extra={"consumer": self.CONSUMER_NAME, "group": self.GROUP_NAME},
        )
        self._ensure_groups_for_existing_streams()

        while True:
            try:
                self._tick()
            except KeyboardInterrupt:
                logger.info("Shutting down consumer on KeyboardInterrupt")
                break
            except Exception:
                logger.exception("Unexpected error in consumer loop — continuing")
                time.sleep(1)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _tick(self) -> None:
        """One iteration: read new messages + periodic XCLAIM sweep."""
        # XCLAIM sweep for stuck messages
        if time.monotonic() - self._last_xclaim_check >= _XCLAIM_CHECK_INTERVAL_S:
            self._xclaim_stuck_messages()
            self._last_xclaim_check = time.monotonic()

        # Discover any new streams created since startup
        stream_keys = self._discover_streams()
        if not stream_keys:
            time.sleep(1)
            return

        self._ensure_groups(stream_keys)

        # XREADGROUP across all tenant streams
        try:
            results: Optional[list[Any]] = self._redis.xreadgroup(
                groupname=self.GROUP_NAME,
                consumername=self.CONSUMER_NAME,
                streams={k: ">" for k in stream_keys},
                count=_READ_COUNT,
                block=self.BLOCK_MS,
            )
        except redis.RedisError:
            logger.exception("XREADGROUP error")
            return

        if not results:
            return

        for stream_key, messages in results:
            if isinstance(stream_key, bytes):
                stream_key = stream_key.decode()
            for message_id, fields in messages:
                if isinstance(message_id, bytes):
                    message_id = message_id.decode()
                decoded_fields = {
                    (k.decode() if isinstance(k, bytes) else k): (
                        v.decode() if isinstance(v, bytes) else v
                    )
                    for k, v in fields.items()
                }
                self._process_message(stream_key, message_id, decoded_fields)

    def _process_message(
        self,
        stream_key: str,
        message_id: str,
        fields: dict[str, str],
    ) -> None:
        """Attempt to process one message; ACK on success, retry otherwise."""
        retry_count = int(fields.get("_retry_count", "0"))
        # Handle deletion jobs (job_type == 'delete') before parsing as IndexingJob
        if fields.get("job_type") == "delete":
            tenant_id = fields.get("tenant_id", "")
            document_id = fields.get("document_id", "")
            try:
                self._vector_store.delete_by_document(tenant_id, document_id)
                self._ack(stream_key, message_id)
                logger.info(
                    "Deletion job processed",
                    extra={"message_id": message_id, "document_id": document_id},
                )
            except Exception:
                logger.exception(
                    "Failed to process deletion job",
                    extra={"message_id": message_id, "document_id": document_id},
                )
                self._ack(stream_key, message_id)  # ACK anyway — retry won't help
            return

        try:
            job = IndexingJob.from_stream_message(fields)
        except (KeyError, ValueError):
            logger.exception(
                "Malformed message — ACKing to prevent infinite retry",
                extra={"message_id": message_id},
            )
            self._ack(stream_key, message_id)
            return

        try:
            self._use_case.execute(job)
            self._ack(stream_key, message_id)
            logger.info(
                "Message processed",
                extra={"message_id": message_id, "document_id": job.document_id},
            )
        except Exception:
            logger.exception(
                "Failed to process message",
                extra={
                    "message_id": message_id,
                    "document_id": job.document_id,
                    "retry_count": retry_count,
                },
            )
            if retry_count >= self.MAX_RETRIES:
                logger.error(
                    "Max retries reached — ACKing poisoned message",
                    extra={"message_id": message_id, "document_id": job.document_id},
                )
                # Status already set to 'failed' by IndexDocumentUseCase
                self._ack(stream_key, message_id)
            # else: leave in PEL for retry / XCLAIM

    def _ack(self, stream_key: str, message_id: str) -> None:
        try:
            self._redis.xack(stream_key, self.GROUP_NAME, message_id)
        except redis.RedisError:
            logger.exception(
                "XACK failed", extra={"stream": stream_key, "message_id": message_id}
            )

    def _xclaim_stuck_messages(self) -> None:
        """Scan PEL for each known stream and re-claim messages idle > XCLAIM_IDLE_MS."""
        stream_keys = self._discover_streams()
        for stream_key in stream_keys:
            try:
                # XAUTOCLAIM is available in Redis ≥ 6.2 and ioredis / redis-py ≥ 4
                result = self._redis.xautoclaim(
                    stream_key,
                    self.GROUP_NAME,
                    self.CONSUMER_NAME,
                    self.XCLAIM_IDLE_MS,
                    start="0-0",
                    count=10,
                )
                # result = (next_start_id, [(id, fields), ...], [deleted_ids])
                claimed_messages = result[1] if result else []
                for message_id, fields in claimed_messages:
                    if isinstance(message_id, bytes):
                        message_id = message_id.decode()
                    decoded_fields = {
                        (k.decode() if isinstance(k, bytes) else k): (
                            v.decode() if isinstance(v, bytes) else v
                        )
                        for k, v in fields.items()
                    }
                    logger.warning(
                        "Re-claiming stuck message",
                        extra={"stream": stream_key, "message_id": message_id},
                    )
                    self._process_message(stream_key, message_id, decoded_fields)
            except redis.RedisError:
                logger.exception(
                    "XAUTOCLAIM error", extra={"stream": stream_key}
                )

    def _discover_streams(self) -> list[str]:
        """Return all keys matching ``indexing:*`` via SCAN (not KEYS)."""
        try:
            keys = list(self._redis.scan_iter(match=self.STREAM_PATTERN, count=100))
            return [k.decode() if isinstance(k, bytes) else k for k in keys]
        except redis.RedisError:
            logger.exception("Failed to discover streams")
            return []

    def _ensure_groups(self, stream_keys: list[str]) -> None:
        """Create consumer group for each stream if it doesn't already exist."""
        for key in stream_keys:
            try:
                self._redis.xgroup_create(key, self.GROUP_NAME, id="0", mkstream=True)
            except redis.exceptions.ResponseError as exc:
                if "BUSYGROUP" in str(exc):
                    pass  # Group already exists — expected
                else:
                    logger.exception(
                        "XGROUP CREATE error", extra={"stream": key}
                    )

    def _ensure_groups_for_existing_streams(self) -> None:
        """On startup: create consumer groups for all pre-existing streams."""
        self._ensure_groups(self._discover_streams())
