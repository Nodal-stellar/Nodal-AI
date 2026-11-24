"""
NodalAIClient - thin HTTP client over the Nodal AI Agent API.

All methods raise ``NodalAIClientError`` (or a subclass) on non-2xx responses.
Bearer-token authentication is sent on every request when an ``api_token`` is
configured.
"""

from __future__ import annotations

import json
from typing import Any, Iterator
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError

from .exceptions import NodalAIAuthError, NodalAINotFoundError, NodalAIAPIError, NodalAIClientError
from .models import (
    AgentResult,
    ApprovalDecision,
    ApprovalDecisionResponse,
    ApprovalsResponse,
    HealthResponse,
    MetricsResponse,
    PauseResumeResponse,
    SpendingResponse,
    StatusResponse,
)


class NodalAIClient:
    """
    Client for the Nodal AI Agent HTTP API.

    Parameters
    ----------
    base_url:
        Base URL of the agent API, e.g. ``"http://localhost:3000"``.
        Trailing slashes are stripped.
    api_token:
        Bearer token for authenticated endpoints. When omitted, unauthenticated
        requests are sent (which succeed only on non-mainnet networks when no
        ADMIN_API_TOKEN is configured).
    timeout:
        Request timeout in seconds. Defaults to 30.
    """

    def __init__(self, base_url: str, api_token: str | None = None, timeout: float = 30.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_token = api_token
        self._timeout = timeout

    # ── internal helpers ──────────────────────────────────────────────

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers: dict[str, str] = {"Accept": "application/json"}
        if self._api_token:
            headers["Authorization"] = f"Bearer {self._api_token}"
        if extra:
            headers.update(extra)
        return headers

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
        accept: str = "application/json",
    ) -> tuple[int, str, str]:
        """
        Perform an HTTP request and return ``(status_code, content_type, body)``.

        Raises ``NodalAIClientError`` on network errors or non-2xx responses.
        """
        url = self._base_url + path
        if query:
            parts: list[str] = []
            for key, value in query.items():
                if value is None:
                    continue
                parts.append(f"{key}={value}")
            if parts:
                url += "?" + "&".join(parts)

        data: bytes | None = None
        headers = self._headers()
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if accept:
            headers["Accept"] = accept

        req = urllib_request.Request(url, data=data, headers=headers, method=method)

        try:
            with urllib_request.urlopen(req, timeout=self._timeout) as resp:
                raw = resp.read().decode("utf-8")
                content_type = resp.headers.get("Content-Type", "")
                return resp.status, content_type, raw
        except HTTPError as err:
            raw = err.read().decode("utf-8") if err.fp else ""
            content_type = err.headers.get("Content-Type", "") if err.headers else ""
            self._raise_for_status(err.code, raw)
            # Unreachable, but keeps type checkers happy
            raise NodalAIAPIError(f"HTTP {err.code}", status_code=err.code, response_body=raw)
        except URLError as err:
            raise NodalAIClientError(f"Request failed: {err}") from err

    @staticmethod
    def _raise_for_status(status_code: int, body: str) -> None:
        if status_code == 401:
            raise NodalAIAuthError(response_body=body)
        if status_code == 404:
            raise NodalAINotFoundError(response_body=body)
        if status_code >= 400:
            raise NodalAIAPIError(f"HTTP {status_code}", status_code=status_code, response_body=body)

    def _parse_json(self, body: str) -> dict[str, Any]:
        try:
            return json.loads(body)
        except json.JSONDecodeError as err:
            raise NodalAIClientError(f"Invalid JSON response: {err}") from err

    # ── API methods ───────────────────────────────────────────────────

    def get_health(self) -> HealthResponse:
        """
        GET /health

        Returns the reachability of Horizon, Soroban RPC and the database.
        """
        _, _, body = self._request("GET", "/health")
        return HealthResponse.from_dict(self._parse_json(body))

    def get_status(
        self, limit: int | None = None, offset: int | None = None
    ) -> StatusResponse:
        """
        GET /status

        Returns paginated persisted task results, newest first.
        """
        query: dict[str, Any] = {}
        if limit is not None:
            query["limit"] = limit
        if offset is not None:
            query["offset"] = offset
        _, _, body = self._request("GET", "/status", query=query)
        return StatusResponse.from_dict(self._parse_json(body))

    def get_spending(self) -> SpendingResponse:
        """
        GET /spending

        Returns cumulative spend within the rolling window, per-asset usage
        and the configured limit.
        """
        _, _, body = self._request("GET", "/spending")
        return SpendingResponse.from_dict(self._parse_json(body))

    def get_metrics(self, accept: str = "application/json") -> Any:
        """
        GET /metrics

        Returns Prometheus text by default, or a JSON snapshot when
        ``accept="application/json"``.
        """
        _, content_type, body = self._request("GET", "/metrics", accept=accept)
        if "application/json" in content_type:
            return MetricsResponse.from_dict(self._parse_json(body))
        return body  # Prometheus text exposition format

    def list_approvals(self) -> ApprovalsResponse:
        """
        GET /approvals

        Returns all tasks currently awaiting a human approve/deny decision.
        """
        _, _, body = self._request("GET", "/approvals")
        return ApprovalsResponse.from_dict(self._parse_json(body))

    def decide_approval(self, approval_id: str, decision: str) -> ApprovalDecisionResponse:
        """
        POST /approvals/{id}

        Approve or deny a pending task. ``decision`` must be ``"approve"``
        or ``"deny"``.
        """
        payload = ApprovalDecision(decision=decision)
        _, _, body = self._request(
            "POST", f"/approvals/{approval_id}", body=payload.to_dict()
        )
        return ApprovalDecisionResponse.from_dict(self._parse_json(body))

    def approve(self, approval_id: str) -> ApprovalDecisionResponse:
        """Approve a pending task."""
        return self.decide_approval(approval_id, "approve")

    def deny(self, approval_id: str) -> ApprovalDecisionResponse:
        """Deny a pending task."""
        return self.decide_approval(approval_id, "deny")

    def pause_agent(self) -> PauseResumeResponse:
        """
        POST /admin/pause

        Halts value-moving tasks. Requires a configured API token.
        """
        _, _, body = self._request("POST", "/admin/pause")
        return PauseResumeResponse.from_dict(self._parse_json(body))

    def resume_agent(self) -> PauseResumeResponse:
        """
        POST /admin/resume

        Resumes value-moving tasks after a pause. Requires a configured API token.
        """
        _, _, body = self._request("POST", "/admin/resume")
        return PauseResumeResponse.from_dict(self._parse_json(body))

    def stream_events(self) -> Iterator[str]:
        """
        GET /stream

        Yields raw SSE event lines as strings. The caller is responsible for
        parsing the ``event:`` / ``data:`` fields.

        Note: this method blocks indefinitely while the stream is open.
        """
        url = self._base_url + "/stream"
        headers = self._headers()
        headers["Accept"] = "text/event-stream"
        req = urllib_request.Request(url, headers=headers, method="GET")

        try:
            with urllib_request.urlopen(req, timeout=self._timeout) as resp:
                for line in resp:
                    decoded = line.decode("utf-8").rstrip("\n")
                    if decoded:
                        yield decoded
        except HTTPError as err:
            raw = err.read().decode("utf-8") if err.fp else ""
            self._raise_for_status(err.code, raw)
        except URLError as err:
            raise NodalAIClientError(f"Stream failed: {err}") from err

    # ── convenience helpers ───────────────────────────────────────────

    def get_results(
        self, limit: int | None = None, offset: int | None = None
    ) -> list[AgentResult]:
        """Convenience: return just the result list from GET /status."""
        return self.get_status(limit=limit, offset=offset).results

    def get_spending_total(self) -> float:
        """Convenience: return just the cumulative spend total."""
        return self.get_spending().total

    def is_healthy(self) -> bool:
        """Convenience: return True when the health status is "ok"."""
        return self.get_health().status == "ok"
