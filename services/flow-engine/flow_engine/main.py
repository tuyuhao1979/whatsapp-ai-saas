"""Entrypoint for the Flow Engine service.

Starts two concurrent workers:
  1. FlowEngineConsumer — blocking Redis Streams loop (daemon thread)
  2. FastAPI admin API — uvicorn on port 8001 (main thread)

Startup sequence:
  1. Load and validate config (fail-fast on missing env vars)
  2. Configure JSON structured logging
  3. Load embedding model (blocks ~2-5s — do BEFORE entering consumer loop)
  4. Wire infrastructure adapters
  5. Start consumer thread (daemon=True)
  6. Start uvicorn (blocking)
"""
from __future__ import annotations

import logging
import sys
import threading

import redis
import uvicorn
from sentence_transformers import SentenceTransformer

from flow_engine.application.flow_executor import FlowExecutor
from flow_engine.config import Config, load_config
from flow_engine.infrastructure.chroma.chroma_retriever import ChromaRetriever
from flow_engine.infrastructure.llm.langchain_llm import LangChainLLMPort
from flow_engine.infrastructure.meta.meta_send_client import MetaSendClient
from flow_engine.infrastructure.postgres.postgres_conv_log import PostgresConvLogRepo
from flow_engine.infrastructure.postgres.postgres_flow_repo import PostgresFlowRepo
from flow_engine.infrastructure.postgres.postgres_message_status_repo import (
    PostgresMessageStatusRepo,
)
from flow_engine.infrastructure.postgres.postgres_tenant_credentials_repo import (
    PostgresTenantCredentialsRepo,
)
from flow_engine.infrastructure.redis.redis_session_repo import RedisSessionRepo
from flow_engine.interfaces.admin_api import _state, app
from flow_engine.interfaces.consumer import FlowEngineConsumer

# ---------------------------------------------------------------------------
# Structured JSON logging
# ---------------------------------------------------------------------------


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        import json

        base = {
            "time": self.formatTime(record, self.datefmt),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        reserved = logging.LogRecord("", 0, "", 0, "", (), None).__dict__.keys()
        for key, value in record.__dict__.items():
            if key not in reserved and not key.startswith("_"):
                base[key] = value
        return json.dumps(base, default=str)


def _configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter())
    root = logging.getLogger()
    root.setLevel(level)
    root.handlers = [handler]


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


def main() -> None:
    cfg: Config = load_config()
    _configure_logging(cfg.log_level)
    logger = logging.getLogger(__name__)
    logger.info("Flow Engine starting up")

    # Load embedding model before entering consumer loop
    logger.info("Loading embedding model")
    _raw_model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")

    class _Embedder:
        def embed(self, texts: list[str]) -> list[list[float]]:
            return [v.tolist() for v in _raw_model.encode(texts, show_progress_bar=False)]

    embedder = _Embedder()
    logger.info("Embedding model ready")

    # Infrastructure adapters
    redis_client = redis.from_url(cfg.redis_url, decode_responses=False)

    flow_repo = PostgresFlowRepo(connection_string=cfg.database_url)
    session_repo = RedisSessionRepo(redis_client=redis_client)
    conv_log_repo = PostgresConvLogRepo(
        connection_string=cfg.database_url,
        store_message_body=cfg.store_message_body,
    )
    message_status_repo = PostgresMessageStatusRepo(connection_string=cfg.database_url)
    tenant_credentials_repo = PostgresTenantCredentialsRepo(
        connection_string=cfg.database_url,
        master_key=cfg.master_key,
    )
    meta_send = MetaSendClient(base_url=cfg.meta_api_base)
    vector_store = ChromaRetriever(
        host=cfg.chromadb_host,
        port=cfg.chromadb_port,
        embedder=embedder,
    )
    llm = LangChainLLMPort(
        openai_api_key=cfg.openai_api_key,
        model=cfg.openai_model,
    )

    executor = FlowExecutor(
        flow_repo=flow_repo,
        meta_send=meta_send,
        vector_store=vector_store,
        llm=llm,
        conv_log_repo=conv_log_repo,
    )

    consumer = FlowEngineConsumer(
        redis_client=redis_client,
        executor=executor,
        session_repo=session_repo,
        conv_log_repo=conv_log_repo,
        tenant_credentials_repo=tenant_credentials_repo,
        meta_send=meta_send,
        message_status_repo=message_status_repo,
    )

    # Populate admin API shared state
    _state.update(
        {
            "flow_repo": flow_repo,
            "session_repo": session_repo,
            "redis_client": redis_client,
            "executor": executor,
            "chroma_retriever": vector_store,
            "db_url": cfg.database_url,
            "internal_token": cfg.internal_token,
        }
    )

    # Consumer runs in a daemon thread (unless this replica is admin-only).
    # MODE lets an operator split stream consumption from the admin HTTP API;
    # previously the variable was documented but never read, so every replica
    # did both.
    consumer_thread: threading.Thread | None = None
    if cfg.mode in ("both", "consumer"):
        consumer_thread = threading.Thread(
            target=consumer.run, daemon=True, name="flow-consumer"
        )
        consumer_thread.start()
        logger.info("Consumer thread started", extra={"mode": cfg.mode})
    else:
        logger.info("MODE=admin — consumer disabled on this replica")

    if cfg.mode == "consumer":
        # No HTTP server on this replica: block on the consumer thread.
        consumer_thread.join()  # type: ignore[union-attr]
        return

    # Admin API runs in the main thread (uvicorn is the process anchor)
    uvicorn.run(app, host="0.0.0.0", port=cfg.flow_engine_port, log_config=None)


if __name__ == "__main__":
    main()
