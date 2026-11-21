"""
Tests for nodal_ai_client.client.

These tests use only the Python standard library (unittest.mock) so they run
without installing any third-party dependencies.
"""

from __future__ import annotations

import json
from http.client import HTTPResponse
from io import BytesIO
from unittest import mock
from urllib.error import HTTPError

import pytest

from nodal_ai_client import NodalAIClient, NodalAIAuthError, NodalAINotFoundError, NodalAIAPIError
from nodal_ai_client.models import HealthResponse, SpendingResponse, StatusResponse


# ── fake urlopen ──────────────────────────────────────────────────────

class _FakeResp:
    """A minimal file-like object with .status, .headers, .read()."""

    def __init__(self, status: int, body: str | bytes, headers: dict[str, str] | None = None) -> None:
        self.status = status
        self.headers = headers or {"Content-Type": "application/json"}
        self._body = body.encode("utf-8") if isinstance(body, str) else body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self) -> bytes:
        return self._body


def _make_client(responses: dict[tuple[str, str], tuple[int, str]]) -> NodalAIClient:
    """Build a client whose urlopen returns canned responses keyed by (method, path)."""

    def fake_urlopen(req, timeout=None):  # noqa: ARG001
        key = (req.method, req.full_url.split("://", 1)[1].split("/", 1)[1].split("?")[0])
        status, body = responses[key]
        return _FakeResp(status, body)

    with mock.patch("nodal_ai_client.client.urllib_request.urlopen", side_effect=fake_urlopen):
        return NodalAIClient(base_url="http://localhost:3000", api_token="test-token")


# ── get_health ────────────────────────────────────────────────────────

def test_get_health_ok():
    client = _make_client({("GET", "/health"): (200, json.dumps({
        "status": "ok",
        "components": {"horizon": "up", "soroban": "up", "database": "up"},
    }))})
    health = client.get_health()
    assert isinstance(health, HealthResponse)
    assert health.status == "ok"
    assert health.components.horizon == "up"


def test_get_health_degraded():
    client = _make_client({("GET", "/health"): (503, json.dumps({
        "status": "degraded",
        "components": {"horizon": "down", "soroban": "up", "database": "up"},
    }))})
    health = client.get_health()
    assert health.status == "degraded"
    assert health.components.horizon == "down"


# ── get_status ────────────────────────────────────────────────────────

def test_get_status_pagination():
    client = _make_client({("GET", "/status"): (200, json.dumps({
        "results": [
            {"success": True, "taskType": "stellar_payment", "correlationId": "c1"},
        ],
    }))})
    status = client.get_status(limit=5, offset=0)
    assert len(status.results) == 1
    assert status.results[0].task_type == "stellar_payment"
    assert status.results[0].success is True


# ── get_spending ──────────────────────────────────────────────────────

def test_get_spending():
    client = _make_client({("GET", "/spending"): (200, json.dumps({
        "total": 35.5,
        "limit": 100,
        "windowMs": 60000,
        "percentUsed": 35.5,
        "usage": [],
    }))})
    spending = client.get_spending()
    assert isinstance(spending, SpendingResponse)
    assert spending.total == 35.5
    assert spending.percent_used == 35.5


# ── auth errors ───────────────────────────────────────────────────────

def test_401_raises_auth_error():
    def fake_urlopen(req, timeout=None):  # noqa: ARG001
        raise HTTPError("http://localhost:3000/health", 401, "Unauthorized", {}, BytesIO(b'{"error":"Unauthorized"}'))

    with mock.patch("nodal_ai_client.client.urllib_request.urlopen", side_effect=fake_urlopen):
        client = NodalAIClient(base_url="http://localhost:3000", api_token="test-token")
        with pytest.raises(NodalAIAuthError):
            client.get_health()


def test_404_raises_not_found():
    def fake_urlopen(req, timeout=None):  # noqa: ARG001
        raise HTTPError("http://localhost:3000/approvals/missing", 404, "Not Found", {}, BytesIO(b'{"error":"Not found"}'))

    with mock.patch("nodal_ai_client.client.urllib_request.urlopen", side_effect=fake_urlopen):
        client = NodalAIClient(base_url="http://localhost:3000", api_token="test-token")
        with pytest.raises(NodalAINotFoundError):
            client.decide_approval("missing", "approve")


def test_500_raises_api_error():
    def fake_urlopen(req, timeout=None):  # noqa: ARG001
        raise HTTPError("http://localhost:3000/health", 500, "Internal Server Error", {}, BytesIO(b'{"error":"boom"}'))

    with mock.patch("nodal_ai_client.client.urllib_request.urlopen", side_effect=fake_urlopen):
        client = NodalAIClient(base_url="http://localhost:3000", api_token="test-token")
        with pytest.raises(NodalAIAPIError) as exc:
            client.get_health()
        assert exc.value.status_code == 500


# ── bearer token header ───────────────────────────────────────────────

def test_bearer_token_sent():
    captured: dict[str, str] = {}

    def fake_urlopen(req, timeout=None):  # noqa: ARG001
        captured.update(dict(req.header_items()))
        return _FakeResp(200, json.dumps({"status": "ok", "components": {"horizon": "up", "soroban": "up", "database": "up"}}))

    with mock.patch("nodal_ai_client.client.urllib_request.urlopen", side_effect=fake_urlopen):
        client = NodalAIClient(base_url="http://localhost:3000", api_token="secret-token")
        client.get_health()
    assert captured.get("Authorization") == "Bearer secret-token"


def test_no_token_when_omitted():
    captured: dict[str, str] = {}

    def fake_urlopen(req, timeout=None):  # noqa: ARG001
        captured.update(dict(req.header_items()))
        return _FakeResp(200, json.dumps({"status": "ok", "components": {"horizon": "up", "soroban": "up", "database": "up"}}))

    with mock.patch("nodal_ai_client.client.urllib_request.urlopen", side_effect=fake_urlopen):
        client = NodalAIClient(base_url="http://localhost:3000")
        client.get_health()
    assert "Authorization" not in captured


# ── convenience helpers ───────────────────────────────────────────────

def _health_body() -> str:
    return json.dumps({
        "status": "ok",
        "components": {"horizon": "up", "soroban": "up", "database": "up"},
    })


def _spending_body() -> str:
    return json.dumps({
        "total": 10.0,
        "limit": 100,
        "windowMs": 60000,
        "percentUsed": 10.0,
        "usage": [],
    })


def test_convenience_helpers():
    client = _make_client({
        ("GET", "/health"): (200, _health_body()),
        ("GET", "/spending"): (200, _spending_body()),
    })
    assert client.is_healthy() is True
    assert client.get_spending_total() == 10.0
    results = client.get_results()
    assert results == []
