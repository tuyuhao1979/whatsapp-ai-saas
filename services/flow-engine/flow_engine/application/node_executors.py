"""Node executor implementations for all 8 Flow Engine node types.

Each executor receives a FlowNode, the current Session, the message text,
and an ExecutorDeps bundle, and returns a NodeResult.

No executor imports from infrastructure directly — they use the port interfaces
injected via ExecutorDeps.
"""
from __future__ import annotations

import ipaddress
import logging
import re
import socket
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import httpx
import jmespath

from flow_engine.domain.errors import NodeExecutionError
from flow_engine.domain.models import FlowNode, Session
from flow_engine.domain.ports import ILLMPort, IMetaSendPort, IVectorStore

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass
class NodeResult:
    reply: str | None = None
    next_node: str | None = None
    slot_updates: dict[str, Any] = field(default_factory=dict)
    done: bool = False
    requires_user_input: bool = False  # True for message/interactive/collect_input
    llm_tokens: int = 0
    sent_wamid: str | None = None      # Meta message id of the last outbound send


# ---------------------------------------------------------------------------
# Dependency bundle
# ---------------------------------------------------------------------------


@dataclass
class ExecutorDeps:
    meta_send: IMetaSendPort
    vector_store: IVectorStore
    llm: ILLMPort
    phone_number_id: str
    access_token: str


# ---------------------------------------------------------------------------
# SSRF guard (shared between api_call and any other HTTP-making node)
# ---------------------------------------------------------------------------

_PRIVATE_NETS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),  # link-local
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
]


def _ssrf_guard(url: str) -> None:
    """Raise NodeExecutionError if url resolves to a private/loopback address."""
    parsed = urlparse(url)
    hostname = parsed.hostname or ""
    if hostname.lower() in ("localhost", "127.0.0.1", "::1"):
        raise NodeExecutionError("api_call", f"SSRF: blocked hostname {hostname!r}")
    try:
        addrs = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        raise NodeExecutionError("api_call", f"Cannot resolve hostname: {hostname!r}")
    for addr_info in addrs:
        ip_str = addr_info[4][0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        for net in _PRIVATE_NETS:
            if ip in net:
                raise NodeExecutionError(
                    "api_call", f"SSRF: {ip_str} is in private range {net}"
                )


# ---------------------------------------------------------------------------
# Node executors
# ---------------------------------------------------------------------------


def execute_message(
    node: FlowNode,
    session: Session,
    message_text: str,
    deps: ExecutorDeps,
) -> NodeResult:
    """Send a text message, optionally collect a slot from next user input."""
    config = node.config
    content: str = config.get("content", "")
    # Interpolate slots
    try:
        content = content.format_map(session.slots)
    except (KeyError, ValueError):
        pass  # send as-is if slot not yet filled

    sent_wamid = deps.meta_send.send_text(
        phone_number_id=deps.phone_number_id,
        to=session.wa_id,
        text=content,
        access_token=deps.access_token,
    )

    collect_slot: str | None = config.get("collect_slot")
    if collect_slot:
        # Wait for next user input — stay on this node
        return NodeResult(
            reply=content,
            next_node=None,
            requires_user_input=True,
            sent_wamid=sent_wamid,
        )

    next_node = _first_transition(node, session)
    return NodeResult(reply=content, next_node=next_node, sent_wamid=sent_wamid)


def execute_interactive(
    node: FlowNode,
    session: Session,
    message_text: str,
    deps: ExecutorDeps,
) -> NodeResult:
    """Send a WhatsApp interactive button message; wait for user's button reply."""
    config = node.config
    body_text: str = config.get("body", "")
    try:
        body_text = body_text.format_map(session.slots)
    except (KeyError, ValueError):
        pass

    buttons: list[dict[str, Any]] = config.get("buttons", [])
    payload: dict[str, Any] = {
        "type": "interactive",
        "interactive": {
            "type": "button",
            "body": {"text": body_text},
            "action": {"buttons": buttons},
        },
    }
    sent_wamid = deps.meta_send.send_interactive(
        phone_number_id=deps.phone_number_id,
        to=session.wa_id,
        payload=payload,
        access_token=deps.access_token,
    )
    return NodeResult(
        reply=body_text,
        next_node=None,
        requires_user_input=True,
        sent_wamid=sent_wamid,
    )


def execute_collect_input(
    node: FlowNode,
    session: Session,
    message_text: str,
    deps: ExecutorDeps,
) -> NodeResult:
    """Send a prompt and store the user's reply in a slot."""
    config = node.config
    prompt: str = config.get("prompt", "")
    slot: str = config.get("slot", "")
    validation_pattern: str | None = config.get("validation")

    if not message_text:
        # First entry: send the prompt and wait
        prompt_wamid = deps.meta_send.send_text(
            phone_number_id=deps.phone_number_id,
            to=session.wa_id,
            text=prompt,
            access_token=deps.access_token,
        )
        return NodeResult(
            reply=prompt,
            next_node=None,
            requires_user_input=True,
            sent_wamid=prompt_wamid,
        )

    # User replied: validate and store
    if validation_pattern:
        if not re.fullmatch(validation_pattern, message_text, re.IGNORECASE):
            session.retry_count += 1
            if session.retry_count > 3:
                return NodeResult(
                    next_node=_transition_for_condition(node, "error"),
                    done=False,
                )
            error_msg: str = config.get("validation_error", "Invalid input. Please try again.")
            error_wamid = deps.meta_send.send_text(
                phone_number_id=deps.phone_number_id,
                to=session.wa_id,
                text=error_msg,
                access_token=deps.access_token,
            )
            return NodeResult(
                reply=error_msg,
                next_node=None,
                requires_user_input=True,
                sent_wamid=error_wamid,
            )

    slot_updates = {slot: message_text} if slot else {}
    next_node = _first_transition(node, session)
    return NodeResult(next_node=next_node, slot_updates=slot_updates)


def execute_condition(
    node: FlowNode,
    session: Session,
    message_text: str,
    deps: ExecutorDeps,
) -> NodeResult:
    """Evaluate JMESPath expression; branch accordingly. No message sent."""
    context = {"slots": session.slots}
    for transition in node.transitions:
        condition: str | None = transition.get("condition")
        if condition is None or condition == "default":
            return NodeResult(next_node=transition.get("next_node"))
        try:
            result = jmespath.search(condition, context)
        except jmespath.exceptions.JMESPathError:
            logger.warning(
                "JMESPath eval error",
                extra={"node_id": node.id, "expr": condition},
            )
            result = None
        if result:
            return NodeResult(next_node=transition.get("next_node"))

    return NodeResult(next_node=None)


def execute_rag_lookup(
    node: FlowNode,
    session: Session,
    message_text: str,
    deps: ExecutorDeps,
) -> NodeResult:
    """Embed query, retrieve chunks from ChromaDB; store results in slots."""
    config = node.config
    query_template: str = config.get("query_template", message_text)
    try:
        query = query_template.format_map(session.slots)
    except (KeyError, ValueError):
        query = query_template

    top_k: int = min(int(config.get("top_k", 5)), 10)
    min_confidence: float = float(config.get("min_confidence", 0.75))
    store_in_slot: str = config.get("store_in_slot", "_rag_context")

    results = deps.vector_store.query(session.tenant_id, query, top_k=top_k)

    slot_updates: dict[str, Any] = {}
    if results:
        best_score = results[0][1]
        slot_updates["_rag_confidence"] = best_score
        if best_score >= min_confidence:
            chunks_text = "\n\n".join(text for text, _ in results)
            slot_updates[store_in_slot] = chunks_text
    else:
        slot_updates["_rag_confidence"] = 0.0

    next_node = _first_transition(node, session)
    return NodeResult(next_node=next_node, slot_updates=slot_updates)


def execute_llm_generate(
    node: FlowNode,
    session: Session,
    message_text: str,
    deps: ExecutorDeps,
) -> NodeResult:
    """Assemble prompt with optional RAG context, call LLM, send reply."""
    config = node.config
    system_prompt_template: str = config.get("system_prompt", "You are a helpful assistant.")
    try:
        system_prompt = system_prompt_template.format_map(session.slots)
    except (KeyError, ValueError):
        system_prompt = system_prompt_template

    include_rag: bool = config.get("include_rag", False)
    rag_context: str | None = None
    if include_rag:
        rag_context = session.slots.get("_rag_context")

    requested_max: int = int(config.get("max_tokens", 500))
    max_tokens: int = min(requested_max, 1000)  # hard cap

    reply_text, tokens = deps.llm.generate(
        system_prompt=system_prompt,
        history=session.history[-10:],
        user_message=message_text,
        rag_context=rag_context,
        max_tokens=max_tokens,
    )

    sent_wamid = deps.meta_send.send_text(
        phone_number_id=deps.phone_number_id,
        to=session.wa_id,
        text=reply_text,
        access_token=deps.access_token,
    )

    next_node = _first_transition(node, session)
    return NodeResult(
        reply=reply_text,
        next_node=next_node,
        llm_tokens=tokens,
        sent_wamid=sent_wamid,
    )


def execute_api_call(
    node: FlowNode,
    session: Session,
    message_text: str,
    deps: ExecutorDeps,
) -> NodeResult:
    """Make an external HTTP call; store response in a slot."""
    config = node.config
    url: str = config.get("url", "")
    method: str = config.get("method", "POST").upper()
    headers: dict[str, str] = config.get("headers", {})
    store_in_slot: str = config.get("store_in_slot", "_api_response")

    # SSRF guard
    _ssrf_guard(url)

    # Interpolate body template
    body_template: dict[str, Any] | str = config.get("body_template", {})
    if isinstance(body_template, str):
        try:
            body_str = body_template.format_map(session.slots)
            import json as _json
            body: Any = _json.loads(body_str)
        except (KeyError, ValueError):
            body = body_template
    else:
        body = _interpolate_dict(body_template, session.slots)

    try:
        if method == "GET":
            resp = httpx.get(url, headers=headers, timeout=10.0, follow_redirects=False)
        else:
            resp = httpx.post(url, json=body, headers=headers, timeout=10.0, follow_redirects=False)
        resp.raise_for_status()
        response_text = resp.text
    except httpx.HTTPStatusError as exc:
        raise NodeExecutionError(node.id, f"HTTP {exc.response.status_code}")
    except httpx.TimeoutException:
        raise NodeExecutionError(node.id, "Request timed out after 10s")
    except httpx.RequestError as exc:
        raise NodeExecutionError(node.id, str(exc))

    next_node = _first_transition(node, session)
    return NodeResult(
        next_node=next_node,
        slot_updates={store_in_slot: response_text},
    )


def execute_end(
    node: FlowNode,
    session: Session,
    message_text: str,
    deps: ExecutorDeps,
) -> NodeResult:
    """Send optional closing message; reset session state (keep history)."""
    config = node.config
    content: str | None = config.get("content")
    sent_wamid: str | None = None
    if content:
        try:
            content = content.format_map(session.slots)
        except (KeyError, ValueError):
            pass
        sent_wamid = deps.meta_send.send_text(
            phone_number_id=deps.phone_number_id,
            to=session.wa_id,
            text=content,
            access_token=deps.access_token,
        )

    return NodeResult(reply=content, done=True, sent_wamid=sent_wamid)


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

_EXECUTORS = {
    "message": execute_message,
    "interactive": execute_interactive,
    "collect_input": execute_collect_input,
    "condition": execute_condition,
    "rag_lookup": execute_rag_lookup,
    "llm_generate": execute_llm_generate,
    "api_call": execute_api_call,
    "end": execute_end,
}


def execute_node(
    node: FlowNode,
    session: Session,
    message_text: str,
    deps: ExecutorDeps,
) -> NodeResult:
    executor = _EXECUTORS.get(node.node_type)
    if executor is None:
        raise NodeExecutionError(node.id, f"Unknown node type: {node.node_type!r}")
    return executor(node, session, message_text, deps)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _first_transition(node: FlowNode, session: Session) -> str | None:
    """Return the first unconditional (or only) transition target."""
    for t in node.transitions:
        cond = t.get("condition")
        if cond is None or cond == "default":
            return t.get("next_node")
    return None


def _transition_for_condition(node: FlowNode, label: str) -> str | None:
    for t in node.transitions:
        if t.get("condition") == label:
            return t.get("next_node")
    return None


def _interpolate_dict(obj: Any, slots: dict[str, Any]) -> Any:
    if isinstance(obj, str):
        try:
            return obj.format_map(slots)
        except (KeyError, ValueError):
            return obj
    if isinstance(obj, dict):
        return {k: _interpolate_dict(v, slots) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_interpolate_dict(item, slots) for item in obj]
    return obj
