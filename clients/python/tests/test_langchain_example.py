"""
Tests for the LangChain tool wrapper example.

These tests stub out langchain-core so they run without the package installed.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest import mock

import pytest


def test_make_nodal_ai_tools_without_langchain(monkeypatch):
    """Importing the example should raise ImportError when langchain-core is missing."""
    # Block langchain-core import
    monkeypatch.delitem(__import__("sys").modules, "langchain_core", raising=False)

    import importlib

    # Ensure the module is re-imported fresh
    mod = importlib.import_module("examples.langchain_tool", package=None)
    # The module sets Tool = None when import fails
    assert mod.Tool is None

    client_mod = importlib.import_module("nodal_ai_client.client", package=None)
    client = client_mod.NodalAIClient(base_url="http://localhost:3000")

    with pytest.raises(ImportError, match="langchain-core"):
        mod.make_nodal_ai_tools(base_url="http://localhost:3000", client=client)


def test_make_nodal_ai_tools_structure():
    """Verify the tool wrapper returns two tools with expected names/descriptions."""
    fake_tool_cls = mock.Mock()
    fake_tools = []

    def fake_tool(name, description, func):
        fake_tools.append({"name": name, "description": description, "func": func})
        return fake_tool_cls()

    fake_langchain_core = SimpleNamespace(Tool=fake_tool)

    with mock.patch.dict("sys.modules", {"langchain_core": fake_langchain_core, "langchain_core.tools": fake_langchain_core}):
        import importlib

        mod = importlib.import_module("examples.langchain_tool")
        mod.Tool = fake_tool

        # Build a real client to inject
        client_mod = importlib.import_module("nodal_ai_client.client")
        client = client_mod.NodalAIClient(base_url="http://localhost:3000")

        tools = mod.make_nodal_ai_tools(base_url="http://localhost:3000", client=client)

        assert len(tools) == 2
        names = {t["name"] for t in fake_tools}
        assert names == {"nodal_ai_health", "nodal_ai_spending"}
        for t in fake_tools:
            assert callable(t["func"])
