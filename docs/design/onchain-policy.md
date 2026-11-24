# On-chain agent spending policy

Status: **Spike / prototype** (issue #813)
Prototype: [`contracts/agent_policy/`](https://github.com/Nodal-stellar/Nodal-AI/tree/main/contracts/agent_policy)

## Problem

Today the agent's spending cap is enforced only inside the Node process:

## Limitations

The on‑chain policy uses a tumbling (fixed) window implementation. When the current time crosses the boundary (`now >= window_start + window`) the window resets completely, allowing the full `limit` to be spent again. Consequently, an agent can spend up to **2 × limit** in a short span around the window boundary (e.g., at `t = window‑1` and `t = window+1`). The off‑chain rolling tracker uses a sliding window, so the two layers can disagree. This behavior is intentional for the prototype but should be considered when configuring limits.

- `backend/spending_tracker.ts` keeps a rolling window of payments and
  rejects anything that would exceed `AGENT_SPENDING_LIMIT` within
  `SPENDING_WINDOW_MS`.
- `SorobanInvokeTool` sums the simulated SAC transfers that debit the agent
  and checks them against the same tracker.

All of this lives in the same process that holds `AGENT_SECRET_KEY`. If the
server is compromised, or the key leaks, an attacker signs transactions
directly and the limit no longer exists. The cap is a guard against bugs and
prompt injection, not against key compromise.

**Goal:** the agent's funds cannot leave faster than _X tokens per window_
even when the attacker holds the agent key.

## Constraint: the funds must live in a contract account

A classic Stellar account (`G…`) is authorised purely by its signatures and
thresholds; the protocol has no hook for "allow this payment only if it is
under a limit". The only way to make the network evaluate a spending rule is a
**Soroban custom account** (`C…` address) whose `__check_auth` runs on every
authorisation. Consequences:

- The agent's working balance moves from the `G…` account into the contract
  account, held as SAC token balances (native XLM uses its SAC).
- All agent spends become Soroban `transfer` calls authorised by the contract
  account, signed with the agent's ed25519 key. Classic `payment` /
  `path_payment` operations cannot be used from a `C…` address.
- The `G…` key still pays transaction fees (as source account) but holds only
  enough XLM for fees, so stealing it yields at most the fee float.

## Options evaluated

### A. OpenZeppelin Stellar smart accounts

OpenZeppelin's `stellar-contracts` ships a smart-account framework built from
**context rules** (which signers may authorise which calls), **signers**
(ed25519, passkeys, delegated) and **policies** — including a _Spending
Limit_ policy (amount per period) and a _Threshold_ (m-of-n) policy.

| | |
|---|---|
| ✅ | Audited, maintained, composable; adding a passkey/multisig owner later is configuration rather than code. |
| ✅ | Context rules let us scope the agent signer to specific contracts (e.g. the token SAC and our escrow) and nothing else. |
| ✅ | Spending Limit policy is exactly the "X per window" rule. |
| ⚠️ | Requires a newer `soroban-sdk` than this repo pins (`20.x`, toolchain `1.78.0`); adopting it means a toolchain/SDK upgrade for the escrow crate too, or keeping it in a separate workspace. |
| ⚠️ | More moving parts (rule IDs, policy install/uninstall, signer registry) for a backend that currently has one key. |

### B. Custom policy account (this prototype)

A ~250-line Soroban contract implementing `CustomAccountInterface`:

- one agent ed25519 key, one `owner` address, one token, `limit`, `window`;
- `__check_auth` verifies the agent signature, walks every `Context` being
  authorised, sums value-moving token calls and rejects the transaction if
  the window total would exceed `limit`.

| | |
|---|---|
| ✅ | Works on the SDK and toolchain already pinned here; no new dependencies. |
| ✅ | Small enough to audit line by line; behaviour is fully covered by unit tests. |
| ⚠️ | Unaudited custom auth code — the highest-risk kind of contract to write ourselves. |
| ⚠️ | Single token, single signer; multi-asset limits or passkey owners need more code. |

### Recommendation

Ship **B as the prototype** to prove the model end-to-end with the stack we
already have, then **move to OpenZeppelin (A) for production** once the
contracts SDK/toolchain is upgraded. The integration surface on the backend
(funds in a `C…` account, transfers authorised by the agent key) is the same
for both, so the backend work is not wasted.

## Prototype design

### Storage

| Key | Type | Meaning |
|---|---|---|
| `AgentKey` | `BytesN<32>` | ed25519 public key of the Node agent |
| `Owner` | `Address` | separate (cold / multisig) address allowed to change policy |
| `Token` | `Address` | SAC the limit applies to |
| `Limit` | `i128` | max units per window |
| `Window` | `u64` | window length, seconds |
| `WindowStart` | `u64` | start of the current window |
| `Spent` | `i128` | amount spent in the current window |

### `__check_auth` rules

1. Verify the signature over the payload with `AgentKey` (panics otherwise).
2. For every authorised context:
   - `CreateContractHostFn` → **reject** (`ForbiddenContext`).
   - a call to the account itself → **reject**, so the agent key can never
     reconfigure its own policy.
   - a SEP-41 value-moving call (`transfer`, `transfer_from`, `approve`,
     `burn`, `burn_from`):
     - on any token other than `Token` → **reject** (deny by default);
     - otherwise add the amount argument to the transaction total
       (`approve` is counted conservatively, since it grants future spend).
   - anything else (e.g. read-only calls, escrow `release`) → allowed, no cost.
3. If the current window has elapsed (`now >= WindowStart + Window`), start a
   new window (`WindowStart = now`, `Spent = 0`).
4. If `Spent + total > Limit` → **reject** (`OverLimit`); otherwise persist the
   new `Spent`.

Because the check runs on the validator, a rejected spend fails the whole
transaction and nothing is written — exactly the guarantee the off-chain
tracker cannot give.

The window is a fixed (tumbling) window, which is cheap to store. A burst of
`2 × Limit` straddling a boundary is possible; the backend's rolling window
stays as the tighter, first line of defence, and the on-chain limit is the
hard ceiling.

### Owner operations

`set_policy(limit, window)` requires `owner.require_auth()`. `owner` should be
a different key than the agent (hardware wallet, multisig, or later an
OpenZeppelin smart account with a passkey), never stored on the server.

### Escrow interaction

Using the policy account as an escrow **depositor** works unchanged: the
escrow's `initialize` calls `token.transfer(depositor, escrow, amount)`, which
appears in the auth contexts and is counted against the limit. Releases and
refunds _into_ the account need no auth from it and are free.

## Demonstrating on-chain rejection

Unit tests (`cargo test --manifest-path contracts/agent_policy/Cargo.toml`)
call `__check_auth` the same way the host does, with real ed25519 signatures,
and assert that:

- a transfer above the limit returns `OverLimit` even though it is correctly
  signed by the agent key;
- cumulative and batched transfers inside a window are capped;
- the allowance resets after the window;
- other tokens, self-calls and foreign signatures are rejected.

Testnet walkthrough with the Stellar CLI:

```bash
# 1. Build (first run generates contracts/agent_policy/Cargo.lock)
cargo build --manifest-path contracts/agent_policy/Cargo.toml \
  --target wasm32-unknown-unknown --release

# 2. Deploy and configure: limit 10 XLM (100_000_000 stroops) per 24 h
XLM_SAC=$(stellar contract id asset --asset native --network testnet)
POLICY=$(stellar contract deploy --network testnet --source owner \
  --wasm contracts/agent_policy/target/wasm32-unknown-unknown/release/stellar_agent_policy.wasm)
stellar contract invoke --network testnet --source owner --id "$POLICY" -- init \
  --agent_key <agent ed25519 public key, hex> --owner <owner G…> \
  --token "$XLM_SAC" --limit 100000000 --window 86400

# 3. Fund the policy account
stellar contract invoke --network testnet --source owner --id "$XLM_SAC" -- transfer \
  --from <owner G…> --to "$POLICY" --amount 500000000

# 4. Agent spends 5 XLM → succeeds; then 6 XLM → simulation/submission
#    fails with Error(Contract, #4) = OverLimit, signed by the same key.
```

Step 4 is driven from the backend with a `SorobanInvokeTool` call to the SAC's
`transfer` with `from = POLICY`, where the auth entry for `POLICY` is signed
with the agent key (an `authorizeEntry` callback that produces the
`BytesN<64>` ed25519 signature over the entry's payload).

## Follow-up work

1. Backend: `PolicyAccountSigner` that signs Soroban auth entries for the
   `C…` account, and routing of agent payments through SAC `transfer` when
   `AGENT_POLICY_ACCOUNT` is configured.
2. CI: add a `test-rust` step for `contracts/agent_policy` once its
   `Cargo.lock` is committed.
3. Production: replace the prototype with an OpenZeppelin smart account
   (agent signer scoped by a context rule + Spending Limit policy) after the
   SDK/toolchain upgrade, and get it audited.

## Backend integration

Set `AGENT_POLICY_ACCOUNT` to the deployed `C…` policy account. The backend keeps the
configured `G…` agent key as the transaction fee payer, while `PolicyAccountSigner`
authorizes the Soroban authorization entries for the policy account with the same
Ed25519 key. Soroban invocations are simulated first; assembled authorization
entries are signed only after simulation and before submission.

The policy account is the source of SAC transfers from the contract invocation.
`SorobanInvokeTool` therefore attributes simulated outgoing SAC events to the
configured policy account, and the existing off-chain spending tracker continues
to reserve and record the same spend. Startup reads `get_policy` and refuses to
start when `AGENT_SPENDING_LIMIT` is higher than the on-chain `limit`. `GET
/spending` exposes an `onChain` object containing the current `spent`, `limit`,
window length, and window start when policy integration is enabled.

## Non-token call allowlist

Token value calls remain restricted to the configured SAC and the spending limit.
Every non-token contract call must match an owner-managed `(contract, fn_name)`
pair. Owners can replace the complete list with `set_allowlist`, add a pair with
`allow`, remove one with `disallow`, and inspect it with `get_allowlist`. The
contract emits `allowlist_set`, `allowlist_added`, and `allowlist_removed` events.
The public `bump` method extends instance storage TTL without changing policy.
Initialization, policy updates, allowlist changes, and successful agent
authorization checks extend the instance TTL automatically.
