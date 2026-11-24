# nodal-ai-client

Thin Python client over the [Nodal AI Agent](https://github.com/Nodal-stellar/Nodal-AI)
HTTP API.

## Installation

```bash
pip install nodal-ai-client
```

Optional — for the LangChain tool wrapper:

```bash
pip install "nodal-ai-client[langchain]"
```

## Quick start

```python
from nodal_ai_client import NodalAIClient

client = NodalAIClient(
    base_url="http://localhost:3000",
    api_token="my-secret-token",
)

# Health check
health = client.get_health()
print(health.status)                     # "ok" | "degraded"
print(health.components.horizon)         # "up" | "down"

# Spending window
spending = client.get_spending()
print(spending.total)                    # cumulative spend
print(spending.percent_used)             # percent of limit used

# Persisted task results
results = client.get_results(limit=20)
for result in results:
    print(result.task_type, result.success)

# Human-in-the-loop approvals
approvals = client.list_approvals()
for approval in approvals.approvals:
    client.approve(approval.id)

# Agent lifecycle
client.pause_agent()
client.resume_agent()
```

## LangChain tool wrapper

Wrap the agent endpoints as LangChain tools:

```python
from examples.langchain_tool import make_nodal_ai_tools

tools = make_nodal_ai_tools(
    base_url="http://localhost:3000",
    api_token="my-secret-token",
)

# Pass `tools` to a LangChain agent:
# from langchain.agents import initialize_agent
# agent = initialize_agent(tools, llm, agent="zero-shot-react-description")
```

## API coverage

| Endpoint | Method | Client method |
|----------|--------|---------------|
| `/health` | GET | `get_health()` |
| `/status` | GET | `get_status(limit, offset)` |
| `/spending` | GET | `get_spending()` |
| `/metrics` | GET | `get_metrics(accept)` |
| `/approvals` | GET | `list_approvals()` |
| `/approvals/{id}` | POST | `approve(id)` / `deny(id)` / `decide_approval(id, decision)` |
| `/admin/pause` | POST | `pause_agent()` |
| `/admin/resume` | POST | `resume_agent()` |
| `/stream` | GET | `stream_events()` |

All authenticated endpoints send `Authorization: Bearer <token>` when an
`api_token` is configured.

## Publishing to PyPI

```bash
# Build
python -m build

# Upload to TestPyPI
python -m twine upload --repository testpypi dist/*

# Upload to PyPI
python -m twine upload dist/*
```

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Lint
ruff check nodal_ai_client tests
black --check nodal_ai_client tests

# Type check
mypy nodal_ai_client
```

## License

MIT
