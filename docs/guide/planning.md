# Planning and Confirmation

::: warning Experimental
The planner is a library API. Plans generated from natural language contain
read-only steps only: `Planner.plan()` discards every value-moving step the LLM
proposes. To execute payments, build the plan yourself with `createPlan()`.
:::

Planning and executing are separate steps, so a person can see what will happen
before anything is signed.

1. `Planner.plan(text)` asks an LLM for tasks, validates each against its schema,
   and drops the ones policy does not allow.
2. `createPlan(tasks)` builds a plan from tasks your code chose.
3. `executePlan(agent, plan, { confirm })` shows the summary, waits for a yes, and
   runs the tasks in order.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `LLM_ENDPOINT` | unset | OpenAI-compatible chat completions URL; `Planner.plan()` throws without it |
| `LLM_API_KEY` | unset | Sent as a bearer token |
| `LLM_MODEL` | `gpt-4` | Model name sent to the endpoint |

The planner uses `LLM_ENDPOINT` directly. `LLM_PROVIDER` and `LLM_BASE_URL`
configure the separate provider layer in `backend/ai/` and do not affect it.

## Plan from natural language

```typescript
import { PayFiAgent } from './backend/agent';
import { Planner } from './backend/planner';

const agent = new PayFiAgent();
const planner = new Planner(agent);

const plan = await planner.plan('Show my balances and the XLM/USDC order book', {
  runReadonly: false, // true (the default) also runs the reads while planning
});
console.log(plan.summary);
```

The model must answer with bare JSON: an array of `{ type, payload }`. Anything
else throws `Failed to parse planner response`.

## Confirm and execute a payment plan

```typescript
import { createInterface } from 'readline/promises';
import { PayFiAgent } from './backend/agent';
import { createPlan, executePlan } from './backend/executor';

const agent = new PayFiAgent();
const plan = createPlan([
  { type: 'stellar_payment', payload: { destination: 'G...', amount: '5' } },
]);

const result = await executePlan(agent, plan, {
  confirm: async (summary) => {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question(`${summary}\nProceed? (yes/no) `);
    prompt.close();
    return answer === 'yes';
  },
});
console.log(result.status, result.results);
```

| Status | Meaning |
| --- | --- |
| `executed` | The tasks were dispatched; check each entry in `results` |
| `denied` | `confirm` returned false, threw, or did not answer in 5 minutes |
| `expired` | The plan was more than 5 minutes old |
| `failed` | Execution threw |

Three things to know:

- **Without `confirm`, the plan runs at once.** Always pass it.
- **`executed` does not mean every task succeeded.** Execution stops at the first
  failure or pending approval and still reports `executed`.
- **The summary is shortened.** Destinations are cut to 8 characters, and a
  `batch_payment` shows only its number of payments. Show the full payload when
  the details matter.

The `createPlan()` summary is built from the task data, not from LLM text, so a
model cannot describe a payment as something else.

## Next steps

- [Approvals](./approvals.md): a second check, inside the agent
- [AI payment safety](./ai-safety.md): planner controls
