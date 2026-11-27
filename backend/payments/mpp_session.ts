/**
 * backend/payments/mpp_session.ts
 * MPP Session: streaming micropayments via channel-backed off-chain commits.
 *
 * **⚠ PROTOTYPE / SIMULATION — NOT FOR PRODUCTION USE**
 *
 * This module implements the off-chain bookkeeping for a payment channel but
 * does NOT deploy or interact with any on-chain escrow contract:
 *
 *   - `openChannel()` persists channel state to the database only.
 *     No escrow contract is deployed; no funds are locked on Stellar.
 *     Calling `openChannel()` on mainnet throws `SimulatedChannelError`.
 *
 *   - `commitPayment()` updates off-chain balances and signs a commitment.
 *     No Soroban transaction is submitted.
 *
 *   - `closeChannel()` / `disputeChannel()` update the local DB status and
 *     then throw `SimulatedChannelError`. No settlement transaction is ever
 *     broadcast; funds are NOT distributed on-chain.
 *
 * The intended production protocol (escrow contract open/close/dispute via
 * Soroban) is documented in docs/design/mpp-session.md.
 *
 * Protocol (intended):
 *   1. Open: Agent locks funds in an escrow contract, establishing a channel
 *   2. Commit: Each payment updates an off-chain signed commitment (no on-chain tx)
 *   3. Close: Either party submits the latest commitment to finalize the channel
 *   4. Dispute: Timeout mechanism to force-close if the other party is unresponsive
 */

import { randomUUID } from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { AgentPausedError, ValidationError } from '../errors';
import { isPaused } from '../kill_switch';
import { resolveNetworkPassphrase } from '../rpc_client';
import { createAgentSigner, Signer } from '../signer';
import { assetKeyForPaymentAsset, spendingTracker } from '../spending_tracker';
import { getStorage } from '../db/storage';
import { createLogger } from '../utils/logger';
import { toStroops } from '../utils/amount';
import { caip2Network } from '../x402/middleware';
import { emitAlert } from '../alerts';
import { dispatchWebhook } from '../webhook';

const log = createLogger('mpp-session');

export const MPP_SESSION_PROTOCOL = 'mpp-session';

/** Default timeout for disputes: 24 hours */
export const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** SACs and the assets the agent pays with use 7 decimal places. */
const DECIMALS = 7;

// ─── Types ─────────────────────────────────────────────────────────────────

export type ChannelStatus = 'Pending' | 'Active' | 'Closed' | 'Disputed' | 'Expired';

/**
 * Off-chain commitment representing the current state of a payment channel.
 * Signed by the agent (and optionally by the participant for mutual trust).
 */
export interface ChannelCommitment {
  channelId: string;
  agentBalance: string; // i128 as string
  participantBalance: string;
  nonce: number;
  signedAt: string; // ISO timestamp
  agentSignature: string; // base64 signature
  participantSignature?: string; // optional, for mutual commitment
}

/**
 * Persistent state of a payment channel.
 */
export interface ChannelState {
  id: string; // UUID
  agent: string; // G-address
  participant: string; // G-address or C-address
  asset: string; // SAC contract (C-address)
  totalAmount: string; // i128 as string
  agentBalance: string; // Current off-chain balance
  participantBalance: string;
  nonce: number; // Commitment counter
  status: ChannelStatus;
  openedAt: string; // ISO timestamp
  timeoutAt: string; // ISO timestamp
  closedAt?: string | undefined;
  /** SpendingTracker reservation holding `totalAmount` against the limit. */
  reservationId?: string | undefined;
  latestCommitment?: ChannelCommitment | undefined; // JSON-serialized
  /**
   * Spending tracker reservation ID for the total channel amount.
   * Used to release or commit the reservation when the channel closes.
   */
  reservationId?: string | undefined;
}

/**
 * Extended MPP challenge for session-based payments.
 */
export interface MppSessionChallenge {
  id: string;
  realm: string;
  method: 'stellar';
  intent: 'session';
  /** For existing sessions */
  channelId?: string;
  /** For new sessions */
  newSession?: {
    asset: string;
    totalAmount: string;
    timeoutSeconds: number;
  };
  /** The `request` auth-param exactly as received; echoed back unmodified. */
  rawRequest?: string;
  expires?: string;
  description?: string;
  digest?: string;
  opaque?: string;
}

/**
 * Credential payload for MPP Session responses.
 */
export interface MppSessionCredential {
  protocol: typeof MPP_SESSION_PROTOCOL;
  challenge: MppSessionChallenge;
  payload: {
    type: 'commitment';
    commitment: ChannelCommitment;
  };
  source: string; // did:pkh:...
}

// ─── Schema Validation ───────────────────────────────────────────────────────

const NewSessionSchema = z.object({
  asset: z.string().refine(StrKey.isValidContract, 'asset must be a contract address'),
  totalAmount: z
    .string()
    .regex(/^[1-9]\d*$/, 'totalAmount must be a positive integer in base units'),
  timeoutSeconds: z.number().int().positive(),
});

const ChannelStateSchema = z.object({
  id: z.string().uuid(),
  agent: z.string().refine(StrKey.isValidEd25519PublicKey, 'agent must be a G-address'),
  participant: z
    .string()
    .refine(
      (v) => StrKey.isValidEd25519PublicKey(v) || StrKey.isValidContract(v),
      'participant must be a Stellar account or contract address'
    ),
  asset: z.string().refine(StrKey.isValidContract, 'asset must be a contract address'),
  totalAmount: z.string(),
  agentBalance: z.string(),
  participantBalance: z.string(),
  nonce: z.number().int().nonnegative(),
  status: z.enum(['Pending', 'Active', 'Closed', 'Disputed', 'Expired']),
  openedAt: z.string(),
  timeoutAt: z.string(),
  closedAt: z.string().optional(),
  reservationId: z.string().optional(),
  latestCommitment: z.any().optional(),
});

const CommitmentSchema = z.object({
  channelId: z.string().uuid(),
  agentBalance: z.string(),
  participantBalance: z.string(),
  nonce: z.number().int().nonnegative(),
  signedAt: z.string(),
  agentSignature: z.string(),
  participantSignature: z.string().optional(),
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function fromBaseUnits(amount: string): string {
  const value = BigInt(amount);
  const scale = 10n ** BigInt(DECIMALS);
  return `${value / scale}.${(value % scale).toString().padStart(DECIMALS, '0')}`;
}

// Strict parse (#734): rejects malformed amounts and more than DECIMALS (7) places
// instead of silently truncating them.
function toBaseUnits(amount: string): string {
  return toStroops(amount).toString();
}

/**
 * The agent's spending policy, as applied to channel operations.
 * Reserves the total amount in the rolling window (committed on close).
 * Limit enforcement — AGENT_SPENDING_LIMIT, per-asset SPENDING_LIMITS, the
 * mainnet cap and the window total — lives in {@link SpendingTracker.reserve},
 * which compares in BigInt stroops rather than floating-point math.
 */
function reserveChannelSpend(amount: string, asset: string): string {
  if (isPaused()) {
    throw new AgentPausedError('Agent is paused; MPP session operations are halted');
  }
  return spendingTracker.reserve(amount, assetKeyForPaymentAsset(asset));
}

/**
 * Verify that balances are invariant: agent + participant = total.
 */
function verifyBalanceInvariant(
  agentBalance: string,
  participantBalance: string,
  totalAmount: string
): void {
  const total = BigInt(agentBalance) + BigInt(participantBalance);
  if (total !== BigInt(totalAmount)) {
    throw new ValidationError(
      `Balance invariant violated: ${agentBalance} + ${participantBalance} != ${totalAmount}`
    );
  }
}

/**
 * Generate a signature over a commitment payload.
 */
function signCommitment(commitment: ChannelCommitment, signer: Signer): string {
  const payload = JSON.stringify({
    channelId: commitment.channelId,
    agentBalance: commitment.agentBalance,
    participantBalance: commitment.participantBalance,
    nonce: commitment.nonce,
    signedAt: commitment.signedAt,
  });
  const payloadBytes = Buffer.from(payload, 'utf8');
  const signature = signer.sign(payloadBytes);
  return Buffer.from(signature).toString('base64');
}

/**
 * Verify a signature over a commitment payload.
 */
function verifyCommitmentSignature(
  commitment: ChannelCommitment,
  signature: string,
  publicKey: string
): boolean {
  try {
    const payload = JSON.stringify({
      channelId: commitment.channelId,
      agentBalance: commitment.agentBalance,
      participantBalance: commitment.participantBalance,
      nonce: commitment.nonce,
      signedAt: commitment.signedAt,
    });
    const payloadBytes = Buffer.from(payload, 'utf8');
    const signatureBytes = Buffer.from(signature, 'base64');
    const keypair = Keypair.fromPublicKey(publicKey);
    return keypair.verify(payloadBytes, signatureBytes);
  } catch {
    return false;
  }
}

// ─── Storage Methods ───────────────────────────────────────────────────────

/**
 * Save channel state to persistent storage.
 */
async function saveChannelState(state: ChannelState): Promise<void> {
  const storage = getStorage();
  await storage.saveMppSession(state.id, JSON.stringify(state));
  log.debug({ channelId: state.id, status: state.status }, 'Saved channel state');
}

/**
 * Load channel state from persistent storage.
 */
async function loadChannelState(channelId: string): Promise<ChannelState | undefined> {
  const storage = getStorage();
  const value = await storage.loadMppSession(channelId);
  if (!value) return undefined;
  const state = JSON.parse(value) as ChannelState;
  return ChannelStateSchema.parse(state);
}

/**
 * Update channel status and persist.
 */
async function updateChannelStatus(
  channelId: string,
  status: ChannelStatus,
  closedAt?: string
): Promise<void> {
  const state = await loadChannelState(channelId);
  if (!state) {
    throw new ValidationError(`Channel ${channelId} not found`);
  }
  state.status = status;
  if (closedAt) state.closedAt = closedAt;
  await saveChannelState(state);
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class MppSessionClient {
  readonly protocol = MPP_SESSION_PROTOCOL;
  private signer: Signer;
  private network: string;
  private networkPassphrase: string;

  constructor(signer: Signer = createAgentSigner()) {
    this.signer = signer;
    this.network = caip2Network(config.STELLAR_NETWORK);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  /**
   * Open a new payment channel.
   *
   * @param participant - Recipient address (G… or C…)
   * @param asset - SAC contract address (C…)
   * @param totalAmount - Total funds to lock (in base units)
   * @param timeoutSeconds - Dispute timeout (default: 86400)
   * @returns Channel state with initial commitment
   */
  async openChannel(
    participant: string,
    asset: string,
    totalAmount: string,
    timeoutSeconds: number = 86400
  ): Promise<ChannelState> {
    if (config.STELLAR_NETWORK === 'mainnet') {
      throw new SimulatedChannelError(
        'MPP Session channels are not supported on mainnet. ' +
          'The channel protocol is a prototype: no escrow contract is deployed ' +
          'and close/dispute operations do not submit on-chain transactions. ' +
          'Set STELLAR_NETWORK=testnet or wait for the production implementation.'
      );
    }

    const agent = this.signer.publicKey();
    const totalDecimal = fromBaseUnits(totalAmount);
    const reservationId = reserveChannelSpend(totalDecimal, asset);

    const channelId = randomUUID();
    const now = new Date();
    const openedAt = now.toISOString();
    const timeoutAt = new Date(now.getTime() + timeoutSeconds * 1000).toISOString();

    const state: ChannelState = {
      id: channelId,
      agent,
      participant,
      asset,
      totalAmount,
      agentBalance: totalAmount,
      participantBalance: '0',
      nonce: 0,
      status: 'Active',
      openedAt,
      timeoutAt,
      reservationId,
    };

    // Create initial commitment
    const commitment: ChannelCommitment = {
      channelId,
      agentBalance: totalAmount,
      participantBalance: '0',
      nonce: 0,
      signedAt: openedAt,
      agentSignature: '',
    };
    commitment.agentSignature = signCommitment(commitment, this.signer);
    state.latestCommitment = commitment;

    await saveChannelState(state);

    log.info(
      { channelId, participant, asset, totalAmount: totalDecimal, timeoutSeconds },
      'MPP session opened (prototype: no on-chain escrow deployed)'
    );

    // TODO(production): deploy/fund the escrow contract on-chain before returning.
    // See docs/design/mpp-session.md § "Open Channel" for the intended flow.

    return state;
  }

  /**
   * Commit a payment to an existing channel.
   *
   * @param channelId - Channel identifier
   * @param amount - Payment amount (in base units, from agent to participant)
   * @returns Updated commitment
   */
  async commitPayment(channelId: string, amount: string): Promise<ChannelCommitment> {
    const state = await loadChannelState(channelId);
    if (!state) {
      throw new ValidationError(`Channel ${channelId} not found`);
    }
    if (state.status !== 'Active') {
      throw new ValidationError(`Channel ${channelId} is not active (status: ${state.status})`);
    }

    const now = new Date();
    if (now.getTime() >= new Date(state.timeoutAt).getTime()) {
      throw new ValidationError(`Channel ${channelId} has timed out`);
    }

    const amountBigInt = BigInt(amount);
    const agentBalanceBigInt = BigInt(state.agentBalance);
    const participantBalanceBigInt = BigInt(state.participantBalance);

    if (amountBigInt > agentBalanceBigInt) {
      throw new ValidationError(
        `Insufficient balance: requested ${amount}, available ${state.agentBalance}`
      );
    }

    // Update balances
    const newAgentBalance = (agentBalanceBigInt - amountBigInt).toString();
    const newParticipantBalance = (participantBalanceBigInt + amountBigInt).toString();
    const newNonce = state.nonce + 1;

    // Verify invariant
    verifyBalanceInvariant(newAgentBalance, newParticipantBalance, state.totalAmount);

    // Create new commitment
    const commitment: ChannelCommitment = {
      channelId,
      agentBalance: newAgentBalance,
      participantBalance: newParticipantBalance,
      nonce: newNonce,
      signedAt: now.toISOString(),
      agentSignature: '',
    };
    commitment.agentSignature = signCommitment(commitment, this.signer);

    // Update state
    state.agentBalance = newAgentBalance;
    state.participantBalance = newParticipantBalance;
    state.nonce = newNonce;
    state.latestCommitment = commitment;
    await saveChannelState(state);

    log.debug(
      { channelId, amount: fromBaseUnits(amount), newAgentBalance: fromBaseUnits(newAgentBalance) },
      'MPP session payment committed'
    );

    return commitment;
  }

  /**
   * Close a channel by submitting the latest commitment on-chain.
   *
   * **⚠ Prototype / simulation only.**
   * This method is not yet implemented. It updates the local channel status to
   * `Closed` but does **not** submit any Soroban transaction to the escrow
   * contract. No funds move on-chain. See `docs/design/mpp-session.md` for the
   * intended production flow.
   *
   * @throws {SimulatedChannelError} always — the on-chain settlement step is not implemented.
   */
  async closeChannel(channelId: string, finalCommitment?: ChannelCommitment): Promise<never> {
    const state = await loadChannelState(channelId);
    if (!state) {
      throw new ValidationError(`Channel ${channelId} not found`);
    }
    if (state.status !== 'Active') {
      throw new ValidationError(`Channel ${channelId} is not active (status: ${state.status})`);
    }

    const commitment = finalCommitment || state.latestCommitment;
    if (!commitment) {
      throw new ValidationError(`No commitment available for channel ${channelId}`);
    }

    // Validate commitment signature
    if (!verifyCommitmentSignature(commitment, commitment.agentSignature, state.agent)) {
      throw new ValidationError('Invalid agent signature on commitment');
    }

    // Verify nonce is not stale
    if (commitment.nonce < state.nonce) {
      throw new ValidationError(
        `Stale commitment: nonce ${commitment.nonce} < current ${state.nonce}`
      );
    }

    // Update local state so the channel is not reused.
    await updateChannelStatus(channelId, 'Closed', new Date().toISOString());

    // Commit exactly the participant's final balance (the amount they actually received)
    // and release the remainder back to the spending window.
    const participantBalanceStr = fromBaseUnits(commitment.participantBalance);
    log.info(
      {
        channelId,
        totalAmount: commitment.agentBalance,
        participantBalance: commitment.participantBalance,
      },
      'MPP session close: committing participant balance, releasing remainder'
    );

    spendingTracker.commit(reservationId);
    // Commit only what the participant actually received
    spendingTracker.record(participantBalanceStr);
    // Release the rest (agent's balance) back to the window
    spendingTracker.release(reservationId);

    log.warn(
      { channelId },
      'MPP session close attempted but on-chain settlement is not implemented (prototype)'
    );

    // TODO(production): build and submit a Soroban transaction calling
    //   escrow.close(channelId, finalAgentBalance, finalParticipantBalance, agentSig)
    // then return the real tx hash.
    // See docs/design/mpp-session.md § "Close Channel".
    throw new SimulatedChannelError(
      `Channel ${channelId} state set to Closed locally, but no on-chain settlement transaction ` +
        'was submitted. The MPP Session channel protocol is a prototype and does not deploy or ' +
        'interact with an escrow contract. Treat this channel as unsettled.'
    );
  }

  /**
   * Dispute a channel (force-close after timeout).
   *
   * **⚠ Prototype / simulation only.**
   * This method is not yet implemented. It updates the local channel status to
   * `Disputed` but does **not** submit any Soroban transaction to the escrow
   * contract. No funds are returned on-chain. See `docs/design/mpp-session.md`
   * for the intended production flow.
   *
   * @throws {SimulatedChannelError} always — the on-chain dispute step is not implemented.
   */
  async disputeChannel(channelId: string): Promise<never> {
    const state = await loadChannelState(channelId);
    if (!state) {
      throw new ValidationError(`Channel ${channelId} not found`);
    }
    if (state.status !== 'Active') {
      throw new ValidationError(`Channel ${channelId} is not active (status: ${state.status})`);
    }

    const now = new Date();
    if (now.getTime() < new Date(state.timeoutAt).getTime()) {
      throw new ValidationError(`Channel ${channelId} has not timed out yet`);
    }

    if (!state.latestCommitment) {
      throw new ValidationError(`No commitment available for channel ${channelId}`);
    }

    // Update local state so the channel is not reused.
    await updateChannelStatus(channelId, 'Disputed', new Date().toISOString());

    log.warn(
      { channelId },
      'MPP session dispute: releasing full reservation (no on-chain settlement occurred)'
    );

    // Release the full reservation since no actual settlement happened.
    // The spending was never committed on-chain.
    if (state.reservationId) {
      spendingTracker.release(state.reservationId);
    }

    // TODO(production): build and submit a Soroban transaction calling
    //   escrow.dispute(channelId, lastAgentBalance, lastParticipantBalance, agentSig)
    // after verifying the timeout has elapsed on-chain, then return the real tx hash.
    // See docs/design/mpp-session.md § "Dispute / Timeout".
    throw new SimulatedChannelError(
      `Channel ${channelId} state set to Disputed locally, but no on-chain dispute transaction ` +
        'was submitted. The MPP Session channel protocol is a prototype and does not deploy or ' +
        'interact with an escrow contract. Treat this channel as unsettled.'
    );
  }

  /**
   * Load a channel's current state.
   */
  async getChannel(channelId: string): Promise<ChannelState | undefined> {
    return loadChannelState(channelId);
  }

  /**
   * Get the latest commitment for a channel.
   */
  async getLatestCommitment(channelId: string): Promise<ChannelCommitment | undefined> {
    const state = await loadChannelState(channelId);
    return state?.latestCommitment;
  }
}

// ─── Expiry sweeper ─────────────────────────────────────────────────────────

/** States the sweeper may expire; terminal states are left alone. */
const EXPIRABLE_STATUSES: ReadonlySet<ChannelStatus> = new Set(['Pending', 'Active']);

/** Default sweep cadence: once a minute. */
export const DEFAULT_MPP_SESSION_SWEEP_INTERVAL_MS = 60_000;

/**
 * Mark every channel whose `timeoutAt` has passed as `Expired`, release the
 * spending reservation held at open, and raise an event plus an operator
 * alert. Returns the channels this call expired.
 *
 * `commitPayment` already refuses payments on timed-out channels; without the
 * sweeper those channels would sit in `Active` forever, pinning their
 * reservation against the spending limit.
 */
export async function sweepExpiredChannels(now: Date = new Date()): Promise<ChannelState[]> {
  const records = await getStorage().listMppSessions();
  const expired: ChannelState[] = [];

  for (const record of records) {
    let state: ChannelState;
    try {
      state = ChannelStateSchema.parse(JSON.parse(record.state));
    } catch (err) {
      log.warn(
        { channelId: record.channelId, error: String(err) },
        'Skipping malformed MPP session record'
      );
      continue;
    }
    if (!EXPIRABLE_STATUSES.has(state.status)) continue;
    if (new Date(state.timeoutAt).getTime() > now.getTime()) continue;

    state.status = 'Expired';
    state.closedAt = now.toISOString();
    await saveChannelState(state);
    expired.push(state);

    releaseChannelReservation(state);
    notifyChannelExpired(state);
  }

  if (expired.length > 0) {
    log.info(
      { count: expired.length, channelIds: expired.map((s) => s.id) },
      'Expired MPP channels swept'
    );
  }
  return expired;
}

/**
 * Free the reservation `openChannel` took against the spending limit. Best
 * effort: the reservation may already have aged out of the window, in which
 * case there is nothing left to release.
 */
function releaseChannelReservation(state: ChannelState): void {
  if (!state.reservationId) return;
  try {
    spendingTracker.release(state.reservationId);
  } catch (err) {
    log.warn(
      { channelId: state.id, reservationId: state.reservationId, error: String(err) },
      'Could not release MPP channel reservation'
    );
  }
}

/** Emit the lifecycle webhook event and the operator alert for an expiry. */
function notifyChannelExpired(state: ChannelState): void {
  const timestamp = new Date().toISOString();
  const details = {
    channelId: state.id,
    participant: state.participant,
    asset: state.asset,
    totalAmount: state.totalAmount,
    timeoutAt: state.timeoutAt,
  };
  void emitAlert({
    type: 'channel_expired',
    severity: 'warning',
    message: `MPP payment channel expired: ${state.id}`,
    details,
    timestamp,
  });
  void dispatchWebhook({
    event: 'mpp.channel_expired',
    ...details,
    openedAt: state.openedAt,
    timestamp,
  });
}

/**
 * Run {@link sweepExpiredChannels} every `intervalMs` until the returned stop
 * function is called. The timer is unref'd so it never keeps the process alive
 * on its own.
 */
export function startMppSessionSweeper(
  intervalMs: number = config.MPP_SESSION_SWEEP_INTERVAL_MS ??
    DEFAULT_MPP_SESSION_SWEEP_INTERVAL_MS
): () => void {
  const timer = setInterval(() => {
    sweepExpiredChannels().catch((err) =>
      log.error({ error: String(err) }, 'MPP channel sweep failed')
    );
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
