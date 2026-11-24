# AI Payment Safety

An LLM, an MCP client, or an on-chain event can each cause the agent to sign a
payment. This page lists those paths, the controls available on each, and the
settings recommended for production.

Rehearse every control you rely on, on testnet and with your own configuration,
before you use it with real funds.

## The model in one paragraph

An LLM never holds the agent's key and never signs anything. It can only propose
a task, and a task runs through `PayFiAgent.run()`. The controls live there, in
ordinary code that a prompt cannot change. Treat everything an LLM produces, and
everything it reads (memos, `stellar.toml`, x402 challenges, contract events), as
untrusted input.

## Order of checks

`PayFiAgent` evaluates a value-moving task (`VALUE_MOVING_TASK_TYPES` in
`backend/agent.ts`) in this order and stops at the first refusal:

1. **Kill switch**: refuses with `AGENT_PAUSED`.
2. **Destination policy**: refuses with `POLICY_VIOLATION`.
3. **Approval**: holds the task with `PENDING_APPROVAL`.
4. **Spending limit**: reserves the amount, or refuses.
5. **The tool's own checks**: schema, simulation, x402 price and asset rules.

Approving a held task runs it again from step 1, skipping only step 3.

## Entry point × control matrix

"Agent check" means the check in [Order of checks](#order-of-checks), as it
applies to the task being run. What a check looks at depends on the task: the
destination policy, for example, needs a destination to compare.

| Entry point | Opt-in | Spending limit | Destination allowlist | Approval | Kill switch | Guardrails |
| --- | --- | --- | --- | --- | --- | --- |
| Planner: `Planner.plan()` | `LLM_ENDPOINT` | Plans reads only | Plans reads only | Plans reads only | Plans reads only | Schema validation; value-moving steps discarded |
| Planner: `executePlan()` | Library call | Agent check | Agent check | Agent check, plus the `confirm` callback | Agent check | Plan expiry; summary built from task data |
| MCP stdio: `tools/call` | `MCP_ALLOW_PAYMENTS` for funds-moving tools | Agent check | Agent check | Agent check | Agent check | Tool visibility |
| MCP HTTP: `tools/call` | As stdio, plus `MCP_API_TOKEN` | Agent check | Agent check | Agent check | Agent check | Tool visibility, bearer token, loopback bind, body size cap |
| Triggers: payment, contract event, storage change | `TRIGGER_ALLOW_PAYMENTS` for value-moving tasks | Agent check | Agent check | Agent check; set `requireApproval` on the task | Agent check | Event filter, deduplication |
| Approval decision: `POST /approvals/:id` | `ADMIN_API_TOKEN` | Re-checked | Re-checked | This is the decision | Re-checked | Executes once |

The x402 and MPP clients (`fetchPaid()`, `MppChargeClient`) are library calls that
your own code makes. They apply their own checks rather than the task pipeline
above, so call them only for endpoints you trust. See
[PayFi and x402](./payfi.md) and [MPP payments](./mpp.md).

There is no HTTP route that submits a new task. The health server lists and
decides approvals, pauses, resumes, and reports status.

### Controls and their settings

| Control | Settings | Guide |
| --- | --- | --- |
| Spending limit | `AGENT_SPENDING_LIMIT`, `SPENDING_LIMITS`, `SPENDING_LIMITS_ALLOW_UNKNOWN`, `SPENDING_WINDOW_MS` | [README](https://github.com/Nodal-stellar/Nodal-AI#spending-limit-enforcement) |
| Destination allowlist | `PAYMENT_DESTINATION_POLICY`, `PAYMENT_DESTINATIONS`, `PAYMENT_DESTINATIONS_FILE` | [Security model](./security.md) |
| Approval | `requireApproval` on a task, `APPROVAL_THRESHOLD`, `APPROVAL_TTL_MS` | [Approvals](./approvals.md) |
| Kill switch | `PAUSED`, `POST /admin/pause`, `POST /admin/resume` | [README](https://github.com/Nodal-stellar/Nodal-AI#kill-switch) |
| MCP exposure | `MCP_ALLOW_PAYMENTS`, `MCP_API_TOKEN`, `MCP_HOST` | [MCP server](./mcp.md) |
| Trigger exposure | `TRIGGER_ALLOW_PAYMENTS` | [Triggers](./triggers.md) |
| Plan confirmation | the `confirm` callback | [Planning](./planning.md) |
| x402 rules | `X402_MAX_PRICE`, `X402_ALLOWED_ASSETS`, `ALLOWED_X402_ORIGINS` | [PayFi and x402](./payfi.md) |

`backend/ai/guardrails.ts` also provides helpers that flag injection patterns in
prompts and mark tool output as untrusted. Call them from your integration when
you pass external text to a model. They are pattern matching, not a security
boundary; rely on the controls above.

## Recommended production settings

```bash
# Start paused; resume with POST /admin/resume once your checks pass.
PAUSED=true
ADMIN_API_TOKEN=<random 32+ bytes>

# Keep AI and event paths closed until you have tested them.
MCP_ALLOW_PAYMENTS=false
TRIGGER_ALLOW_PAYMENTS=false

# MCP: prefer stdio. Over HTTP, keep it on loopback and always set a token.
MCP_TRANSPORT=stdio
MCP_HOST=127.0.0.1
MCP_API_TOKEN=<random 32+ bytes, different from ADMIN_API_TOKEN>

# Limits: list every asset and deny the rest.
AGENT_SPENDING_LIMIT=100
SPENDING_LIMITS=XLM:100,USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN:50
SPENDING_LIMITS_ALLOW_UNKNOWN=false

# Only pay known counterparties.
PAYMENT_DESTINATION_POLICY=allowlist
PAYMENT_DESTINATIONS_FILE=./payment_destinations.txt

# Hold anything above a small amount for a person.
APPROVAL_THRESHOLD=10
APPROVAL_TTL_MS=900000

# x402 price and origin rules.
X402_MAX_PRICE=1
ALLOWED_X402_ORIGINS=api.example.com

# Leave off unless you use Nano payments.
NANO_ENABLED=false
```

Beyond configuration:

- **Fund the agent account with only what you can afford to lose.** The controls
  run inside the agent process and do not protect against a stolen key.
- **Connect MCP clients you trust**, and give them a dedicated agent account.
- **Always pass `confirm` to `executePlan()`.** It is optional, and plans run
  unconfirmed without it.
- **Give triggers an issuer.** Set both `assetCode` and `assetIssuer`, and usually
  `from` and `minAmount`. Set `requireApproval: true` on anything irreversible.
- **Use separate credentials** for MCP access and for approving.
- **Rehearse the kill switch.** Pause, confirm a payment fails with
  `AGENT_PAUSED`, then resume.
- **Set alerts** (`ALERT_WEBHOOK_URL`, `ALERT_SPENDING_THRESHOLDS`) and run
  `npm run audit:verify` on a schedule.

## Known limitations

- **Application-level controls.** Limits, policies, and approvals are enforced by
  the agent process. The on-chain policy account
  ([design](../design/onchain-policy.md)) is a prototype.
- **Contract calls carry no amount.** A threshold cannot evaluate a task without
  one. Use `requireApproval` for contract calls.
- **Approvals show what was asked, not why.** A person can still approve a payment
  that an injected prompt requested. Check the destination and amount against an
  independent source.
- **The MCP client's LLM is outside Nodal.** It reads tool output that can include
  text written by third parties, such as memos and `stellar.toml` contents.
- **Experimental features.** MCP, triggers, and planning may change. MPP Session is
  a prototype that moves no funds.

Report suspected vulnerabilities privately, as described in
[SECURITY.md](https://github.com/Nodal-stellar/Nodal-AI/blob/main/SECURITY.md).

## Related pages

- [MCP server](./mcp.md)
- [Triggers](./triggers.md)
- [Planning and confirmation](./planning.md)
- [Approvals](./approvals.md)
- [MPP payments](./mpp.md)
- [Security model](./security.md)
