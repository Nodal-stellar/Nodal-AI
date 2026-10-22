# Tools System

The tools system allows you to extend the agent with new capabilities.

## Built-in Tools

Nodal AI includes a set of built-in tools for common operations:

- Stellar payment tools
- Account management
- Transaction simulation
- And more

## Creating Custom Tools

```typescript
import { z } from 'zod';

const myTool = {
  name: 'my_tool',
  description: 'Description of what this tool does',
  inputSchema: z.object({
    param1: z.string(),
    param2: z.number().optional()
  }),
  execute: async (input) => {
    // Your implementation
    return { result: 'success' };
  }
};
```

## Registering Tools

```typescript
agent.registerTools([myTool]);
```

## Tool Schemas

Generate JSON schemas for all tools:

```bash
npm run tools:schema
```

This outputs to `docs/tools.schema.json`.

## Next Steps

- [PayFi & x402](./payfi.md) - Learn about payment standards
