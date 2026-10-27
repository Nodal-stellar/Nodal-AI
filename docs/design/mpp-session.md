# MPP Session: Streaming Micropayments via Channel Backed Off-Chain Commits

**Status:** Design / Spike  
**Issue:** N/A (Roadmap Sprint 2)  
**Related:** MPP Charge (Issue #777), On-chain Policy (Issue #813)

## Problem Statement

MPP Charge (`backend/payments/mpp.ts`) settles each paid HTTP request with an on-chain SEP-41 `transfer` via Stellar Asset Contract (SAC). This works well for individual payments, but for high-frequency, low-value interactions (e.g., AI token metering, per-API-call billing, real-time data streaming), the on-chain transaction cost becomes prohibitive:

- Each request requires a separate Soroban transaction (network fee + rent)
- High latency due to network confirmation (~5-10s on testnet, longer on mainnet)
- Throughput limited by Stellar's ledger time (~5s)
- Cumulative gas fees for many small payments exceed the payment value itself

**Goal:** Enable streaming micropayments where many small value transfers are committed off-chain and settled on-chain in a single batch, reducing cost and latency while maintaining security guarantees.

## Solution Overview: MPP Session

MPP Session introduces a **payment channel** abstraction for MPP Charge:

1. **Open**: Both parties lock funds in a multi-sig or escrow contract, establishing a channel with an initial balance
2. **Commit**: Each payment updates an off-chain commitment (signed by both parties) incrementally, without on-chain transaction
3. **Close**: Either party can submit the latest commitment to finalize the channel and distribute funds according to the final state

This design follows the classic bidirectional payment channel pattern, adapted for:
- MPP Charge protocol compatibility
- Soroban smart contract enforcement
- Dispute resolution through on-chain timeout
- Integration with existing Nodal AI infrastructure (spending limits, signer, storage)

## Protocol Design

### Channel State Machine

```
[Pending] ── open() ──► [Active] ── commit() × N ──► [Active]
                     │                              │
                     │  close(latest_commitment)   │
                     │                              │
                     ▼                              ▼
                  [Closed] ◄────────────────────────┘
                     │
                     │  dispute() (timeout elapsed)
                     │
                     ▼
                  [Disputed]
```

### States

| State | Description | Transitions |
|-------|-------------|-------------|
| `Pending` | Channel proposed, awaiting funding | `open()` → `Active` |
| `Active` | Channel funded, accepting commits | `commit()` → `Active`, `close()` → `Closed` |
| `Closed` | Channel settled on-chain, funds distributed | Terminal |
| `Disputed` | Channel closed via dispute mechanism | Terminal |

### Core Operations

#### 1. Open Channel

**Purpose:** Establish a payment channel with locked funds.

**Inputs:**
- `channelId`: Unique identifier (UUID)
- `participant`: Recipient address (G… or C…)
- `asset`: SAC contract address (C…)
- `totalAmount`: Total funds locked by agent (in base units)
- `timeoutSeconds`: Dispute timeout (e.g., 86400 for 24h)

**Process:**
1. Agent creates an escrow contract instance (or uses existing multi-sig)
2. Agent transfers `totalAmount` of `asset` to the escrow
3. Channel state persisted: `{ id, participant, asset, totalAmount, agentBalance, participantBalance, status: 'Active', openedAt, timeoutAt }`
4. Initial commitment signed: both parties start with full balance

**Spending Policy:**
- `totalAmount` is reserved in the rolling spending window during `open()`
- Committed only after on-chain confirmation of funding

**On-Chain Contract:**
```rust
// Pseudo-code for escrow contract
struct Channel {
    agent: Address,
    participant: Address,
    asset: Address,
    total_amount: i128,
    agent_balance: i128,
    participant_balance: i128,
    timeout: u64,
    closed: bool,
}

fn open(channel_id: BytesN<32>, agent: Address, participant: Address, asset: Address, amount: i128, timeout: u64) {
    // Deploy and fund escrow
}
```

#### 2. Commit Payment

**Purpose:** Update the off-chain commitment with a new payment incrementally.

**Inputs:**
- `channelId`: Existing channel identifier
- `amount`: Payment amount (in base units, transferred from agent to participant)
- `nonce`: Incrementing counter (prevents replay)

**Process:**
1. Agent validates:
   - Channel exists and is `Active`
   - `amount` ≤ `agentBalance` (sufficient funds)
   - `nonce` = `lastNonce + 1` (no gaps)
   - `timeoutAt` not elapsed
2. Agent updates off-chain state:
   - `agentBalance -= amount`
   - `participantBalance += amount`
   - `lastNonce = nonce`
3. Agent signs the new commitment: `sign(channelState)`
4. Agent sends signed commitment to participant (via MPP Charge response or separate endpoint)
5. Participant validates and countersigns (if required by protocol)

**Off-Chain Commitment Format:**
```typescript
interface ChannelCommitment {
  channelId: string;
  agentBalance: string;  // i128 as string
  participantBalance: string;
  nonce: number;
  signedAt: string;  // ISO timestamp
  agentSignature: string;  // base64 signature
  participantSignature?: string;  // optional, for mutual commitment
}
```

**Spending Policy:**
- Each `commit()` reserves `amount` in the rolling window
- Reservations are released when channel is closed (funds already locked in escrow)
- This prevents double-counting: escrow lock + window reservation

**Persistence:**
- Latest commitment persisted to database (keyed by `channelId`)
- Enables recovery after restart
- Enables dispute resolution

#### 3. Close Channel

**Purpose:** Finalize the channel and distribute funds according to the latest commitment.

**Inputs:**
- `channelId`: Channel identifier
- `finalCommitment`: Latest signed commitment

**Process:**
1. Agent validates:
   - Commitment signature matches agent key
   - Commitment signature matches participant (if mutual signature required)
   - Commitment nonce ≥ persisted nonce (no rollback)
2. Agent builds Soroban transaction calling escrow contract `close()`:
   - Passes final balances from commitment
   - Contract validates signatures
   - Contract transfers funds to respective parties
3. Agent submits transaction via RPC client
4. Channel state updated to `Closed`

**On-Chain Contract:**
```rust
fn close(channel_id: BytesN<32>, final_agent_balance: i128, final_participant_balance: i128, agent_sig: Signature, participant_sig: Signature) {
    let channel = load_channel(channel_id);
    require(!channel.closed, "Already closed");
    require(final_agent_balance + final_participant_balance == channel.total_amount, "Invalid balances");
    require(verify_sig(channel.agent, agent_sig), "Invalid agent signature");
    require(verify_sig(channel.participant, participant_sig), "Invalid participant signature");
    
    // Transfer funds
    asset::transfer(&channel.asset, &channel_id, &channel.agent, final_agent_balance);
    asset::transfer(&channel.asset, &channel_id, &channel.participant, final_participant_balance);
    
    channel.closed = true;
}
```

**Spending Policy:**
- Reservations for all commits are released (funds were already locked)
- Total `totalAmount` is committed to spending window once

#### 4. Dispute / Timeout

**Purpose:** Allow either party to force-close a channel if the other becomes unresponsive.

**Trigger:**
- `timeoutAt` elapsed (default 24h after open)
- Participant refuses to countersign
- Participant submits stale commitment

**Process:**
1. Agent calls escrow contract `dispute()`:
   - Passes latest persisted commitment
   - Contract validates timeout has elapsed
   - Contract distributes funds according to latest commitment (agent's last signed state)
2. Funds are returned proportionally to agent (based on agent's last balance)

**On-Chain Contract:**
```rust
fn dispute(channel_id: BytesN<32>, last_agent_balance: i128, last_participant_balance: i128, agent_sig: Signature) {
    let channel = load_channel(channel_id);
    require(!channel.closed, "Already closed");
    require(env.ledger().timestamp() > channel.timeout, "Timeout not elapsed");
    require(verify_sig(channel.agent, agent_sig), "Invalid agent signature");
    
    // Force-close with agent's last signed state
    asset::transfer(&channel.asset, &channel_id, &channel.agent, last_agent_balance);
    asset::transfer(&channel.asset, &channel_id, &channel.participant, last_participant_balance);
    
    channel.closed = true;
}
```

## Integration with MPP Charge

MPP Session extends MPP Charge with a new protocol variant:

### Challenge Format (Extended)

```typescript
interface MppSessionChallenge extends MppChargeChallenge {
  intent: 'session';
  channelId?: string;  // For existing sessions
  newSession?: {
    asset: string;
    totalAmount: string;
    timeoutSeconds: number;
  };
}
```

### Response Flow

1. **First Request:** Server responds with `402` + session challenge (`intent: 'session'`)
2. **Agent:**
   - If `channelId` provided: Load existing channel, commit payment, return commitment
   - If `newSession` provided: Open new channel, commit first payment, return commitment
3. **Server:** Validates commitment, responds with resource
4. **Subsequent Requests:** Agent continues committing to same channel
5. **Final Request:** Either party initiates close, or timeout forces dispute

### Credential Format

```typescript
interface MppSessionCredential {
  protocol: 'mpp-session';
  challenge: MppSessionChallenge;
  payload: {
    type: 'commitment';
    commitment: ChannelCommitment;
  };
  source: string;  // did:pkh:...
}
```

## Data Model

### Channel State (Persisted)

```typescript
interface ChannelState {
  id: string;  // UUID
  agent: string;  // G-address
  participant: string;  // G-address or C-address
  asset: string;  // SAC contract (C-address)
  totalAmount: string;  // i128 as string
  agentBalance: string;  // Current off-chain balance
  participantBalance: string;
  nonce: number;  // Commitment counter
  status: 'Pending' | 'Active' | 'Closed' | 'Disputed';
  openedAt: string;  // ISO timestamp
  timeoutAt: string;  // ISO timestamp
  closedAt?: string;
  latestCommitment?: ChannelCommitment;  // JSON-serialized
}
```

### Database Schema

Add to `backend/db/migrations/003_mpp_session.sql`:

```sql
CREATE TABLE IF NOT EXISTS mpp_sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  participant TEXT NOT NULL,
  asset TEXT NOT NULL,
  total_amount TEXT NOT NULL,  -- i128 as string
  agent_balance TEXT NOT NULL,
  participant_balance TEXT NOT NULL,
  nonce INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('Pending', 'Active', 'Closed', 'Disputed')),
  opened_at TEXT NOT NULL,
  timeout_at TEXT NOT NULL,
  closed_at TEXT,
  latest_commitment TEXT,  -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mpp_sessions_agent ON mpp_sessions(agent);
CREATE INDEX IF NOT EXISTS idx_mpp_sessions_status ON mpp_sessions(status);
CREATE INDEX IF NOT EXISTS idx_mpp_sessions_timeout ON mpp_sessions(timeout_at);
```

## Security Considerations

### 1. Signature Validation

- Every commitment must be signed by the agent
- Mutual signature (participant) optional but recommended for mutual trust
- Signatures cover the entire commitment state (not just balance delta)

### 2. Nonce Sequencing

- Strict increment: `nonce[i] = nonce[i-1] + 1`
- Prevents replay attacks and stale commitment submissions
- Database enforces uniqueness per channel

### 3. Timeout Protection

- Default timeout: 24 hours (configurable via `MPP_SESSION_TIMEOUT_MS`)
- After timeout, agent can force-close with last signed state
- Protects against participant inactivity

### 4. Balance Invariants

- `agentBalance + participantBalance = totalAmount` (always)
- Never negative balances
- Commitment never increases total (no money creation)

### 5. Spending Limit Integration

- `totalAmount` reserved on open
- Individual commits also reserved (released on close)
- Prevents concurrent channel opens from exceeding limit

### 6. Contract Security

- Escrow contract must validate signatures on close/dispute
- Contract must verify balance invariants
- Contract must prevent double-close
- Consider OpenZeppelin smart accounts for production (see onchain-policy.md)

## Implementation Plan

### Phase 1: Design Doc (This Document)

- [x] Define protocol and state machine
- [x] Specify data model and schema
- [x] Document security invariants
- [x] Plan integration points

### Phase 2: Spike / Prototype

**Backend Implementation:**
1. Create `backend/payments/mpp_session.ts`:
   - `MppSessionClient` class
   - `openChannel()`, `commitPayment()`, `closeChannel()`, `disputeChannel()`
   - Challenge parsing (extended from MPP Charge)
   - Commitment signing and validation
2. Create database migration `003_mpp_session.sql`
3. Add storage methods to `backend/db/storage.ts`:
   - `saveChannelState()`, `loadChannelState()`, `updateChannelState()`
   - `getActiveChannels()`, `getChannelsByTimeout()`
4. Integrate with spending tracker:
   - Reserve on open
   - Release on close
5. Integrate with signer:
   - Sign commitments with agent key

**Smart Contract (Prototype):**
1. Create `contracts/mpp_session/` (Rust):
   - Simple escrow contract with open/close/dispute
   - Signature validation
   - Balance invariant checks
2. Unit tests for contract logic

**Tests:**
1. Unit tests for protocol logic (mocked RPC)
2. Integration test: 100 commits in one session on testnet
3. Dispute scenario test
4. Timeout test

### Phase 3: Production Refinement

1. Replace prototype contract with OpenZeppelin smart account
2. Add comprehensive error handling
3. Add metrics (Prometheus: channel opens, commits, closes, disputes)
4. Add webhook events for channel lifecycle
5. Performance optimization (batch commit verification)
6. Audit and security review

## Open Questions

1. **Mutual vs. Single Signature:**
   - Should commitments require both signatures (mutual) or just agent's (unilateral)?
   - Mutual: Better security, requires participant availability
   - Unilateral: Agent can commit anytime, participant can dispute with timeout
   - **Decision:** Start with unilateral (agent-only) for prototype, add mutual option later

2. **Contract Choice:**
   - Custom escrow (prototype) vs. OpenZeppelin smart account (production)
   - **Decision:** Custom escrow for spike (matches current toolchain), migrate to OpenZeppelin for production

3. **Channel Lifetime:**
   - Should channels auto-close after timeout, or require explicit close?
   - **Decision:** Require explicit close for normal flow, dispute mechanism for timeout

4. **Maximum Commits:**
   - Is there a practical limit on number of commits per channel?
   - **Decision:** No hard limit in protocol, but test with 100 commits as acceptance criteria

5. **Asset Support:**
   - Should sessions support multiple assets, or one asset per channel?
   - **Decision:** One asset per channel (simpler, matches escrow design)

## Acceptance Criteria

1. Design document merged
2. Prototype handles 100 commits with one open/close on testnet
3. `npm run typecheck` passes
4. `npm run lint` passes
5. Relevant tests pass:
   - Unit tests for `MppSessionClient`
   - Integration test for 100-commit session
   - Dispute scenario test
   - Timeout test

## References

- MPP Charge: `backend/payments/mpp.ts`
- On-chain Policy: `docs/design/onchain-policy.md`
- SEP-41 (Stellar Asset Contract): https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md
- Payment Auth (MPP): https://paymentauth.org/draft-stellar-charge-00
- OpenZeppelin Stellar Contracts: https://github.com/OpenZeppelin/stellar-contracts
