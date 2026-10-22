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

## Generate Tool Schemas

```bash
npm run tools:schema
```

This generates `docs/tools.schema.json` with machine-readable tool definitions.

## Next Steps

- [Architecture](./architecture.md) - Understand the system design
- [Agent Configuration](./agent-config.md) - Configure your agent
- [Tools System](./tools.md) - Learn about the tools framework
