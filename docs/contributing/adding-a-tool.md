# How to Add a New Tool to Nodal AI

This guide walks you through the step-by-step process of implementing, registering, and testing a new tool in the Nodal AI agent framework.

---

## Architecture Overview

Tools in Nodal AI are modular classes located in `backend/tools/` that execute discrete PayFi actions (e.g. transfers, swaps, Soroban contract interactions, identity lookups, or payment streams).

Every tool follows these core conventions:
1. **Zod Parameter Validation**: Strict validation for all parameters.
2. **Standard Result Format**: Returns an object conforming to `AgentResult` (`{ success: boolean, data?: unknown, error?: string }`).
3. **Structured Logging**: Emits structured log events using `createLogger()`.
4. **Error Handling**: Uses domain errors from `backend/errors.ts` (e.g. `ValidationError`, `HorizonError`, `ContractError`).

---

## Step 1: Generate Scaffolding

Use the built-in tool generator to scaffold the tool implementation and its test file:

```bash
npm run new-tool <ToolName>
```

Example:
```bash
npm run new-tool CustodyTransfer
```

This automatically creates:
- `backend/tools/CustodyTransferTool.ts`
- `tests/custody_transfer.test.ts`

---

## Step 2: Define Parameter Schema

Open your tool file in `backend/tools/` and define the Zod schema for your parameters:

```typescript
import { z } from 'zod';

export const CustodyTransferParamsSchema = z.object({
  vaultAddress: z.string().min(1, 'Vault address is required'),
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'Amount must be a numeric string'),
  memo: z.string().max(28, 'Memo text cannot exceed 28 bytes').optional(),
});

export type CustodyTransferParams = z.infer<typeof CustodyTransferParamsSchema>;
```

---

## Step 3: Implement Tool Logic

Implement the `execute` method inside your tool class:

```typescript
import { createLogger } from '../utils/logger';
import { ValidationError } from '../errors';

const logger = createLogger('custody-transfer');

export class CustodyTransferTool {
  async execute(params: CustodyTransferParams): Promise<{ success: boolean; data: Record<string, unknown> }> {
    const validated = CustodyTransferParamsSchema.parse(params);
    logger.info('Executing custody transfer', { vault: validated.vaultAddress, amount: validated.amount });

    try {
      // Connect to horizonServer or sorobanServer and execute transaction
      return {
        success: true,
        data: {
          txHash: 'sample_transaction_hash',
          vault: validated.vaultAddress,
        },
      };
    } catch (err) {
      logger.error('Failed to execute custody transfer', { error: String(err) });
      throw err;
    }
  }
}
```

---

## Step 4: Register the Tool in the Agent

Wire your new tool into `backend/agent.ts`:

1. **Add to `TaskType` union:**
   ```typescript
   export type TaskType =
     | 'stellar_payment'
     | 'soroban_invoke'
     | 'custody_transfer' // <--- Add your task type here
     | ...;
   ```

2. **Instantiate tool in `PayFiAgent`:**
   ```typescript
   import { CustodyTransferTool } from './tools/CustodyTransferTool';

   export class PayFiAgent {
     private custodyTransferTool: CustodyTransferTool;

     constructor(options: AgentOptions = {}) {
       // ...
       this.custodyTransferTool = new CustodyTransferTool();
     }
   }
   ```

3. **Add case to `executeTask()`:**
   ```typescript
   case 'custody_transfer':
     return this.custodyTransferTool.execute(task.params as any);
   ```

---

## Step 5: Write Comprehensive Tests

Open `tests/<tool_name>.test.ts` and write tests for:
- Valid parameter parsing
- Invalid parameter rejection
- Successful execution
- Error handling paths

Run your tests:
```bash
npm test -- tests/custody_transfer.test.ts
```

---

## Step 6: Verify Code Quality

Ensure the entire project compiles cleanly and passes all checks:

```bash
npm run typecheck    # TypeScript compilation
npm run lint         # ESLint style checking
npm test             # All test suites
npm run format:check # Prettier code formatting
```
