# Approvals

An approval holds a value-moving task until a person accepts or refuses it. The
task is stored as `pending_approval`, its amount is reserved against the spending
window, and nothing is signed until it is approved.

## How the decision is made

`PayFiAgent` evaluates each value-moving task in this order:

1. **Paused?** Refuse with `AGENT_PAUSED`.
2. **Destination not permitted?** Refuse with `POLICY_VIOLATION`.
3. **Already approved?** Skip to step 6.
4. **`requireApproval: true` on the task?** Hold it, whatever the amount.
5. **Amount above the threshold?** Hold it. An amount exactly equal to the
   threshold is not held. Amounts compare as whole stroops, never as floats.
6. **Reserve the amount** against the spending limit, then run the tool.

A threshold needs an amount to compare. For tasks without one, such as a contract
call, use `requireApproval`.

| Outcome | What happens |
| --- | --- |
| Approved | The reservation is released and the task runs again through steps 1, 2 and 6 |
| Denied | The reservation is released; the task never runs |
| Expired | Same as denied, after `APPROVAL_TTL_MS` |
| Approved twice | The second call returns the current state and does not run the task again |

Because an approved task runs through the checks again, an approval cannot
override the kill switch, the allowlist, or a spending limit.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `APPROVAL_THRESHOLD` | see `.env.example` | Amount above which a task is held |
| `APPROVAL_THRESHOLDS` | unset | Per-asset thresholds, `CODE:AMOUNT` or `CODE:ISSUER:AMOUNT` |
| `APPROVAL_TTL_MS` | `3600000` | How long an approval waits before it expires |
| `ADMIN_API_TOKEN` | unset | Bearer token for `POST /approvals/:id`. Deciding over HTTP needs this, or the deprecated `WEBHOOK_SECRET` fallback |

Test your approval settings on testnet before relying on them.

## Hold a task

```typescript
import { PayFiAgent } from './backend/agent';
import { ErrorType } from './backend/errors';

const agent = new PayFiAgent();
const result = await agent.run({
  type: 'stellar_payment',
  payload: { destination: 'G...', amount: '5' },
  requireApproval: true,
});

if (result.errorType === ErrorType.PendingApproval) {
  const { approvalId, expiresAt } = result.data as { approvalId: string; expiresAt: string };
  console.log(`Waiting for a decision on ${approvalId} until ${expiresAt}`);
}
```

## Decide a task

Over HTTP, against the process that held the task:

```bash
curl -s http://127.0.0.1:3000/approvals \
  -H "Authorization: Bearer $ADMIN_API_TOKEN"

curl -s -X POST "http://127.0.0.1:3000/approvals/$APPROVAL_ID" \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approve"}'
```

Or in code:

```typescript
await agent.approve(approvalId, 'alice');
agent.deny(approvalId, 'alice');
```

## Next steps

- [AI payment safety](./ai-safety.md): which paths approvals cover
- [Triggers](./triggers.md): approval-gated automation
