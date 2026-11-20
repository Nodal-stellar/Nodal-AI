# Quick Start

## Create Your First Agent

```typescript
import { Agent } from './backend/agent';
import { createBuiltinTools } from './backend/tools/builtin';

// Initialize the agent with configuration
const agent = new Agent({
  // Your agent configuration
});

// Register tools
const tools = createBuiltinTools();
agent.registerTools(tools);

// Start the agent
await agent.start();
```

## Run the MCP Server

```bash
npm run mcp
```

Value-moving tools are hidden from MCP clients unless `MCP_ALLOW_PAYMENTS=true`.
When they are enabled, `MCP_PAYMENT_MODE` decides what a `tools/call` does:

| Mode | Behaviour |
| --- | --- |
| `approve` (default) | Creates a pending approval and returns its `approvalId`, `expiresAt` and a deterministic `summary`. Nothing moves until a human approves it with `POST /approvals/:id {"decision":"approve"}` (or denies it); an approved call executes once. |
| `direct` | Executes immediately, with spending limits still enforced. Refused on mainnet unless `MCP_FORCE_DIRECT_PAYMENTS=true`. |

## Generate Tool Schemas

```bash
npm run tools:schema
```

This generates `docs/tools.schema.json` with machine-readable tool definitions.

## Next Steps

- [Architecture](./architecture.md) - Understand the system design
- [Agent Configuration](./agent-config.md) - Configure your agent
- [Tools System](./tools.md) - Learn about the tools framework
