# Release an Escrow When a Payment Arrives

This walkthrough runs `scripts/examples/trigger_escrow_release.ts` on testnet. A
seller locks 5 XLM in an escrow contract. When the buyer's token payment reaches
the agent, a trigger releases the escrow to the buyer. A variant holds the release
until a person approves it.

::: warning Verification status
The script has **not been run on testnet** yet. The output below shows the lines
it prints, with placeholders instead of real hashes. See
[Record a run](#record-a-run).
:::

## Who does what

| Party | Role in the escrow | Key |
| --- | --- | --- |
| Seller | Depositor: locks 5 XLM | Throwaway, created by the script |
| Buyer | Recipient: pays 25 DEMOUSD, receives the XLM | Throwaway |
| Agent | Arbiter: receives the payment, releases the escrow | `AGENT_SECRET_KEY` |
| Issuer | Issues the demo asset | Throwaway |

The contract requires the depositor, recipient, and arbiter to differ.

## Prerequisites

- A funded testnet account for the agent
- Node.js 22+ and a Rust toolchain to build the contract

Build the escrow contract:

```bash
bash scripts/build_escrow_wasm.sh
```

Add to `.env`:

```bash
STELLAR_NETWORK=testnet
HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
AGENT_SECRET_KEY=S...
X402_ASSET_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5

# soroban_invoke is a value-moving task type.
TRIGGER_ALLOW_PAYMENTS=true

CONTRACT_WASM_PATH=contracts/escrow/target/wasm32-unknown-unknown/release/stellar_payfi_escrow.wasm
```

Leave `PAUSED` unset. The script refuses to run on any network but testnet.

## Run it

```bash
npx ts-node scripts/examples/trigger_escrow_release.ts
```

### Step 1: Accounts and asset

The script funds the three throwaway accounts with Friendbot, adds a trustline
from the agent and the buyer to `DEMOUSD`, and issues 25 DEMOUSD to the buyer.

### Step 2: Escrow

The seller deploys the contract, restricts it to native XLM with
`set_allowed_tokens`, and calls `initialize`, which locks 5 XLM for one hour.

### Step 3: Trigger

```typescript
const trigger = await manager.createTrigger({
  source: 'payment',
  filter: {
    assetCode: 'DEMOUSD',
    assetIssuer: issuer.publicKey(),
    from: buyer.publicKey(),
    minAmount: '25.0000000',
  },
  task: {
    type: 'soroban_invoke',
    payload: { contractId, method: 'release', args, simulateOnly: false },
  },
});
```

The issuer matters. Anyone can issue a token called `DEMOUSD`, so before creating
the trigger the script checks that the filter rejects the same code from a random
issuer, and stops if it does not.

### Step 4: Payment

The buyer sends 25 DEMOUSD to the agent. The script starts listening for the
contract's `released` event before paying, so it cannot miss the release.

### Step 5: Release

The script finds the payment on Horizon, matches it against the filter, claims it
in the deduplication table, disables the trigger, and runs its task. It then waits
for the `released` event and confirms `released=true` with `get_state`.

### Expected output

```text
Step 1: Funding throwaway accounts and issuing the demo asset...
   Asset  : DEMOUSD:<issuer>
   Seller : <seller>
   Buyer  : <buyer>
   Agent  : <agent>

Step 2: Deploying the escrow and locking 5 XLM...
   Contract   : <contract id>
   Initialize : <tx hash>

Step 3: Creating the payment trigger...
   Trigger  : trig_<id>
   Approval : not required

Step 4: Buyer pays 25.0000000 DEMOUSD to the agent...
   Payment : <tx hash>

Step 5: Waiting for the trigger to fire...
   Matched payment <tx hash>; firing trig_<id>
   Release : <tx hash>
   Observed the "released" event and released=true.

Done: payment received → trigger fired → escrow released to the buyer.
```

The agent's structured log lines appear in between.

## Approval variant

```bash
npx ts-node scripts/examples/trigger_escrow_release.ts --approval
```

The trigger's task now carries `requireApproval: true`. When the payment arrives,
the release is held instead of executed:

```text
   Release held as pending_approval until <time>; nothing has moved.
   Approval <id>. Type "approve" or "deny":
```

- **approve**: the release runs, and the script confirms it as above.
- **deny**, any other answer, or no interactive terminal: the script confirms that
  the escrow is still locked. The seller can refund it after expiry.

The example uses `requireApproval` because a contract call carries no amount for
`APPROVAL_THRESHOLD` to compare. Decide at the prompt, in the process that holds
the approval.

## Why the script does some things itself

| What | Why |
| --- | --- |
| Polls Horizon instead of calling `TriggerManager.start()` | The built-in listener delivers payments that carry an `x402:` memo; this one is an ordinary payment |
| Encodes contract arguments with `jsonSafeScVal` and restores them in middleware | Triggers and approvals are stored as JSON, which cannot hold `xdr.ScVal` |
| Deploys with the Stellar SDK | The seller, not the agent, deploys and pays for the contract |
| Passes no topic filter to the event listener | The listener compares topics as strings, but the SDK returns `xdr.ScVal` |

Do not also call `manager.start()`: the two use different deduplication keys.

## Before using this pattern for real

- **The payment stays with the agent.** This example does not forward it to the
  seller.
- **The filter and the approval are what guard the release.** The escrowed funds
  belong to the contract, not to the agent account.
- **A matched event is claimed before the task runs.** If the release fails, it is
  not retried automatically.
- **The escrow can expire** while an approval waits. Keep `APPROVAL_TTL_MS`
  shorter than the escrow's remaining time.

## Record a run

Run both variants and replace the expected output with real
output. Include the commit, the date, and testnet links for the initialize,
payment, and release transactions, and remove the verification notice. For the
approval variant, record one denial and one approval.

## Next steps

- [Triggers](../guide/triggers.md)
- [Approvals](../guide/approvals.md)
- [AI payment safety](../guide/ai-safety.md)
