"""
nodal_ai_client - Thin Python client over the Nodal AI Agent HTTP API.

The Nodal AI Agent exposes a REST HTTP API for health checks, spending
window queries, human-in-the-loop approvals, agent lifecycle controls,
persisted results, server-sent events and Prometheus metrics.

Basic usage:

    from nodal_ai_client import NodalAIClient

    client = NodalAIClient(
        base_url="http://localhost:3000",
        api_token="my-secret-token",
    )
    health = client.get_health()
    print(health.status)  # "ok" | "degraded"

    spending = client.get_spending()
    print(spending.total)  # cumulative spend in asset units

See the LangChain example in ``examples/langchain_tool.py`` for how to
wrap this client as a LangChain tool.
"""

from .client import NodalAIClient, NodalAIClientError, NodalAIAuthError
from .models import (
    HealthResponse,
    HealthStatus,
    ComponentStatus,
    StatusResponse,
    SpendingResponse,
    SpendingUsage,
    MetricsResponse,
    ApprovalsResponse,
    PendingApproval,
    ApprovalDecision,
    ApprovalDecisionResponse,
    PauseResumeResponse,
    AgentResult,
    ErrorResponse,
)

__all__ = [
    "NodalAIClient",
    "NodalAIClientError",
    "NodalAIAuthError",
    "HealthStatus",
    "HealthResponse",
    "ComponentStatus",
    "StatusResponse",
    "SpendingResponse",
    "SpendingUsage",
    "MetricsResponse",
    "ApprovalsResponse",
    "PendingApproval",
    "ApprovalDecision",
    "ApprovalDecisionResponse",
    "PauseResumeResponse",
    "AgentResult",
    "ErrorResponse",
]

__version__ = "1.0.0"
