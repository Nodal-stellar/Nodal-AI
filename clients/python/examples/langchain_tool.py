"""
LangChain tool wrapper for the Nodal AI Agent HTTP API.

This example exposes the agent's health and spending endpoints as LangChain
tools so a LangChain agent can query the Nodal AI agent without writing
custom HTTP code.

Setup::

    pip install nodal-ai-client langchain

Usage::

    from examples.langchain_tool import make_nodal_ai_tools

    tools = make_nodal_ai_tools(
        base_url="http://localhost:3000",
        api_token="my-secret-token",
    )

    # Pass `tools` to a LangChain agent constructor.
"""

from __future__ import annotations

from typing import Optional

from nodal_ai_client import NodalAIClient

try:
    from langchain_core.tools import Tool
except ImportError:  # pragma: no cover - LangChain is an optional dependency
    Tool = None  # type: ignore[assignment,misc]


def make_nodal_ai_tools(
    base_url: str,
    api_token: Optional[str] = None,
) -> list[Tool]:
    """
    Build a list of LangChain tools wrapping the Nodal AI Agent client.

    Parameters
    ----------
    base_url:
        Base URL of the agent API, e.g. ``"http://localhost:3000"``.
    api_token:
        Bearer token for authenticated endpoints.

    Returns
    -------
    A list of :class:`langchain_core.tools.Tool` instances:

    * ``nodal_ai_health`` - ``GET /health`` → dependency status
    * ``nodal_ai_spending`` - ``GET /spending`` → cumulative spend + limit

    Raises
    ------
    ImportError
        If ``langchain-core`` is not installed.
    """
    if Tool is None:  # pragma: no cover
        raise ImportError(
            "langchain-core is required to use the LangChain tool wrapper. "
            "Install it with: pip install nodal-ai-client[langchain]"
        )

    client = NodalAIClient(base_url=base_url, api_token=api_token)

    def health(_input: str = "") -> str:
        """Check the health of the Nodal AI Agent (Horizon, Soroban, database)."""
        try:
            health = client.get_health()
            components = ", ".join(
                f"{name}={status}"
                for name, status in (
                    ("horizon", health.components.horizon),
                    ("soroban", health.components.soroban),
                    ("database", health.components.database),
                )
            )
            return f"Agent status: {health.status}. Components: {components}"
        except Exception as exc:  # pragma: no cover - network errors
            return f"Health check failed: {exc}"

    def spending(_input: str = "") -> str:
        """Return cumulative spending within the rolling window and the limit."""
        try:
            spending = client.get_spending()
            usage = "; ".join(
                f"{u.asset_key}={u.spent}/{u.limit}" for u in spending.usage
            ) or "no per-asset usage"
            return (
                f"Spending: {spending.total} / {spending.limit} "
                f"({spending.percent_used:.1f}% used over {spending.window_ms}ms window). "
                f"Per-asset: {usage}"
            )
        except Exception as exc:  # pragma: no cover - network errors
            return f"Spending query failed: {exc}"

    return [
        Tool(
            name="nodal_ai_health",
            description="Check the Nodal AI Agent health (Horizon, Soroban, database status).",
            func=health,
        ),
        Tool(
            name="nodal_ai_spending",
            description="Query cumulative spending within the rolling window and the configured limit.",
            func=spending,
        ),
    ]


__all__ = ["make_nodal_ai_tools"]
