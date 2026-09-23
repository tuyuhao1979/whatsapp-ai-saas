"""MinIO adapter: implements IDocumentStore via the minio Python package."""
from __future__ import annotations

import logging
from urllib.parse import urlparse

from minio import Minio

from rag_indexer.domain.ports import IDocumentStore

logger = logging.getLogger(__name__)


class MinioDocumentStore(IDocumentStore):
    """Downloads documents from MinIO / S3-compatible object storage.

    URI format expected: ``s3://{bucket}/{key}``
    """

    def __init__(
        self,
        endpoint: str,
        access_key: str,
        secret_key: str,
        secure: bool = False,
    ) -> None:
        self._client = Minio(
            endpoint,
            access_key=access_key,
            secret_key=secret_key,
            secure=secure,
        )

    def download(self, storage_uri: str) -> tuple[bytes, str]:
        """Download the object at *storage_uri* and return (raw_bytes, content_type).

        Args:
            storage_uri: ``s3://{bucket}/{key}`` URI as stored in knowledge_base_documents.

        Returns:
            Tuple of (raw bytes, content_type header returned by MinIO).
        """
        bucket, key = self._parse_uri(storage_uri)
        logger.info(
            "Downloading from MinIO",
            extra={"bucket": bucket, "key_prefix": key.split("/")[0]},
        )

        response = self._client.get_object(bucket, key)
        try:
            raw = response.read()
            content_type: str = response.headers.get("content-type", "application/octet-stream")
        finally:
            response.close()
            response.release_conn()

        logger.info(
            "Download complete",
            extra={"bucket": bucket, "size_bytes": len(raw)},
        )
        return raw, content_type

    @staticmethod
    def _parse_uri(storage_uri: str) -> tuple[str, str]:
        """Extract bucket and key from ``s3://{bucket}/{key}``."""
        parsed = urlparse(storage_uri)
        if parsed.scheme != "s3":
            raise ValueError(f"Unsupported URI scheme: {parsed.scheme!r} (expected 's3')")
        bucket = parsed.netloc
        # Remove leading slash from path
        key = parsed.path.lstrip("/")
        if not bucket:
            raise ValueError(f"Could not parse bucket from URI: {storage_uri!r}")
        if not key:
            raise ValueError(f"Could not parse object key from URI: {storage_uri!r}")
        return bucket, key
