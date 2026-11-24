"""
Data models for the Nodal AI Agent HTTP API responses.

All models are plain dataclasses so they can be constructed manually,
serialised to JSON, or deserialised from API responses without depending on
an external validation library.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ComponentStatus:
    """Reachability of a single dependency."""

    horizon: str
    soroban: str
    database: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ComponentStatus":
        return cls(
            horizon=str(data.get("horizon", "down")),
            soroban=str(data.get("soroban", "down")),
            database=str(data.get("database", "down")),
        )


# Status value returned by GET /health.
HealthStatus = str


@dataclass
class HealthResponse:
    """GET /health response."""

    status: HealthStatus
    components: ComponentStatus

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "HealthResponse":
        return cls(
            status=str(data.get("status", "degraded")),
            components=ComponentStatus.from_dict(data.get("components", {})),
        )


@dataclass
class AgentResult:
    """A single task result, as returned by the /status endpoint."""

    success: bool
    task_type: str
    data: dict[str, Any] | None = None
    error: str | None = None
    error_type: str | None = None
    correlation_id: str | None = None
    duration_ms: float | None = None
    sequence_index: int | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AgentResult":
        return cls(
            success=bool(data.get("success", False)),
            task_type=str(data.get("taskType", "")),
            data=data.get("data"),
            error=data.get("error"),
            error_type=data.get("errorType"),
            correlation_id=data.get("correlationId"),
            duration_ms=data.get("durationMs"),
            sequence_index=data.get("sequenceIndex"),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "success": self.success,
            "taskType": self.task_type,
            "data": self.data,
            "error": self.error,
            "errorType": self.error_type,
            "correlationId": self.correlation_id,
            "durationMs": self.duration_ms,
            "sequenceIndex": self.sequence_index,
        }


@dataclass
class StatusResponse:
    """GET /status response."""

    results: list[AgentResult] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "StatusResponse":
        return cls(
            results=[AgentResult.from_dict(r) for r in data.get("results", [])],
        )


@dataclass
class SpendingUsage:
    """Per-asset spending breakdown entry."""

    asset_key: str
    spent: str
    limit: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SpendingUsage":
        return cls(
            asset_key=str(data.get("assetKey", "")),
            spent=str(data.get("spent", "0")),
            limit=str(data.get("limit", "0")),
        )


@dataclass
class SpendingResponse:
    """GET /spending response."""

    total: float
    limit: float
    window_ms: int
    percent_used: float
    usage: list[SpendingUsage] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SpendingResponse":
        return cls(
            total=float(data.get("total", 0)),
            limit=float(data.get("limit", 0)),
            window_ms=int(data.get("windowMs", 0)),
            percent_used=float(data.get("percentUsed", 0)),
            usage=[SpendingUsage.from_dict(u) for u in data.get("usage", [])],
        )


@dataclass
class MetricsResponse:
    """GET /metrics JSON response."""

    llm: dict[str, Any] = field(default_factory=dict)
    spending: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MetricsResponse":
        return cls(
            llm=data.get("llm", {}),
            spending=data.get("spending", {}),
        )


@dataclass
class PendingApproval:
    """A task awaiting a human approve/deny decision."""

    id: str
    task_type: str
    payload: dict[str, Any]
    amount: str
    correlation_id: str
    created_at: int
    expires_at: int

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PendingApproval":
        return cls(
            id=str(data.get("id", "")),
            task_type=str(data.get("taskType", "")),
            payload=data.get("payload", {}),
            amount=str(data.get("amount", "")),
            correlation_id=str(data.get("correlationId", "")),
            created_at=int(data.get("createdAt", 0)),
            expires_at=int(data.get("expiresAt", 0)),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "taskType": self.task_type,
            "payload": self.payload,
            "amount": self.amount,
            "correlationId": self.correlation_id,
            "createdAt": self.created_at,
            "expiresAt": self.expires_at,
        }


@dataclass
class ApprovalsResponse:
    """GET /approvals response."""

    approvals: list[PendingApproval] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ApprovalsResponse":
        return cls(
            approvals=[PendingApproval.from_dict(a) for a in data.get("approvals", [])],
        )


@dataclass
class ApprovalDecision:
    """POST /approvals/{id} request body."""

    decision: str  # "approve" or "deny"

    def to_dict(self) -> dict[str, Any]:
        return {"decision": self.decision}


@dataclass
class ApprovalDecisionResponse:
    """POST /approvals/{id} response."""

    approval: PendingApproval
    result: AgentResult | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ApprovalDecisionResponse":
        return cls(
            approval=PendingApproval.from_dict(data.get("approval", {})),
            result=AgentResult.from_dict(data["result"]) if data.get("result") else None,
        )


@dataclass
class PauseResumeResponse:
    """POST /admin/pause or /admin/resume response."""

    paused: bool

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PauseResumeResponse":
        return cls(paused=bool(data.get("paused", False)))


@dataclass
class ErrorResponse:
    """A non-2xx error response."""

    error: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ErrorResponse":
        return cls(error=str(data.get("error", "Unknown error")))

    def __str__(self) -> str:
        return self.error
