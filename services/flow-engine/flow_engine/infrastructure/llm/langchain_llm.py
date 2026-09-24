"""LangChain 0.3.x LLM port implementation.

All langchain imports are intentionally isolated in this module.
Domain and application code never import from langchain directly.

Model: gpt-4o-mini (configurable via OPENAI_MODEL env var).
Max tokens: hard-capped at 1000 — never exceeded regardless of node config.
"""
from __future__ import annotations

import logging
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from pydantic import SecretStr

from flow_engine.domain.ports import ILLMPort

logger = logging.getLogger(__name__)

_ABSOLUTE_MAX_TOKENS = 1000


class LangChainLLMPort(ILLMPort):
    def __init__(
        self,
        openai_api_key: str,
        model: str = "gpt-4o-mini",
    ) -> None:
        self._llm = ChatOpenAI(
            # SecretStr is what the client expects; passing a bare str is
            # flagged by the type checker and would risk the key reaching a log
            # formatter through a plain-str repr.
            api_key=SecretStr(openai_api_key),
            model=model,
            # Provider parameters go through model_kwargs: the `max_tokens=`
            # constructor argument is not part of the current langchain-openai
            # stubs, while model_kwargs is typed and forwarded to the OpenAI
            # client on every version this service supports.
            model_kwargs={"max_tokens": 500},  # default; overridden per call
            temperature=0.3,
        )

    def generate(
        self,
        system_prompt: str,
        history: list[dict[str, Any]],
        user_message: str,
        rag_context: str | None = None,
        max_tokens: int = 500,
    ) -> tuple[str, int]:
        """Return (reply_text, total_tokens_used).

        Args:
            system_prompt: System-level instructions (already interpolated).
            history: Last N turns [{role, content, ts}, ...].
            user_message: Current inbound text from the user.
            rag_context: Optional retrieved chunks from ChromaDB.
            max_tokens: Per-call cap; hard-capped at 1000.
        """
        effective_max = min(max_tokens, _ABSOLUTE_MAX_TOKENS)

        messages: list[Any] = [SystemMessage(content=system_prompt)]
        if rag_context:
            messages.append(
                SystemMessage(content=f"Context from knowledge base:\n{rag_context}")
            )

        for turn in history[-10:]:
            role = turn.get("role", "user")
            content = turn.get("content", "")
            if role == "user":
                messages.append(HumanMessage(content=content))
            else:
                messages.append(AIMessage(content=content))

        messages.append(HumanMessage(content=user_message))

        # `bind` forwards the parameter to the model call, which is what the
        # per-call cap is for. The previous with_config({"max_tokens": ...}) only
        # added a run-config entry, which is not a model parameter, so the cap
        # silently had no effect. bind is also what the stubs accept.
        llm = self._llm.bind(max_tokens=effective_max)
        response = llm.invoke(messages)

        tokens: int = 0
        # usage_metadata is present on AIMessage but not on the BaseMessage the
        # stub declares for invoke(), so it is read defensively.
        usage = getattr(response, "usage_metadata", None)
        if usage:
            tokens = usage.get("total_tokens", 0)

        return str(response.content), tokens
