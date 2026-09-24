"""Static guard: the chromadb client pin must match the deployed server image.

Regression test for a defect found while implementing H3. Both pyprojects asked
for `chromadb>=0.5`, which by now resolves to chromadb 1.5.9, while the server
image stayed at `chromadb/chroma:0.5.23`. The 1.x client's create-collection
payload is rejected by that server with

    Exception {"error":"KeyError('_type')"}

so the indexer could not create a collection and the flow engine could never
find one: RAG was entirely non-functional in the shipped stack, and nothing
covered the pair (the verification stack had no vector store at all, and the
Python CI ran unit tests without a server).

Reads both sides instead of asserting a literal, so it fails on drift in either
direction: raising the server image without the pin, or the pin without the
image.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[4]
_COMPOSE = _REPO_ROOT / "infra" / "docker-compose.yml"
_PYPROJECT = _REPO_ROOT / "services" / "flow-engine" / "pyproject.toml"

_IMAGE_RE = re.compile(r"image:\s*chromadb/chroma:(\S+)")
_REQUIREMENT_RE = re.compile(r'"chromadb([<>=!~]+)([^"]+)"')


def _server_version() -> str:
    match = _IMAGE_RE.search(_COMPOSE.read_text(encoding="utf-8"))
    assert match, "no chromadb/chroma image found in infra/docker-compose.yml"
    return match.group(1)


def _client_pin() -> str:
    match = _REQUIREMENT_RE.search(_PYPROJECT.read_text(encoding="utf-8"))
    assert match, "pyproject.toml declares no chromadb requirement"
    operator, version = match.group(1), match.group(2)
    assert operator == "==", (
        f"chromadb must be pinned with `==` to the server image, not `{operator}`: "
        "an open-ended constraint is what let the client drift to a version the "
        "server rejects"
    )
    return version


def test_client_pin_matches_server_image() -> None:
    assert _client_pin() == _server_version(), (
        f"chromadb client pin {_client_pin()!r} does not match the server image "
        f"{_server_version()!r} in infra/docker-compose.yml -- move them together"
    )


def test_installed_client_matches_server_image() -> None:
    """The resolved version, not just the declaration.

    A pin can still be overridden by the resolver (another dependency asking for
    a different chromadb), which is exactly how this drifted.
    """
    chromadb = pytest.importorskip("chromadb")
    assert chromadb.__version__ == _server_version(), (
        f"installed chromadb {chromadb.__version__} does not match the server "
        f"image {_server_version()!r}"
    )
