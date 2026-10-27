/**
 * backend/payments/mpp_session.ts
 * MPP Session: streaming micropayments via channel-backed off-chain commits.
 *
 * MPP Session extends MPP Charge with a payment channel abstraction, enabling
 * many small value transfers to be committed off-chain and settled on-chain
 * in a single batch. This reduces transaction costs and latency for high-frequency
 * interactions (e.g., AI token metering, per-API-call billing).
 *
 * Protocol:
 *   1. Open: Agent locks funds in an escrow contract, establishing a channel
 *   2. Commit: Each payment updates an off-chain signed commitment (no on-chain tx)
 *   3. Close: Either party submits the latest commitment to finalize the channel
 *   4. Dispute: Timeout mechanism to force-close if the other party is unresponsive
 *
 * Design doc: docs/design/mpp-session.md
 */

import { randomUUID } from 'crypto';
import {
  Address,
  BASE_FEE,
  Keypair,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config, MAINNET_SPENDING_CAP } from '../config';
import { AgentPausedError, PolicyViolationError, ValidationError } from '../errors';
import { isPaused } from '../kill_switch';
import { loadAccount, prepareSorobanTx, resolveNetworkPassphrase } from '../rpc_client';
import { createAgentSigner, Signer } from '../signer';
import { spendingTracker } from '../spending_tracker';
import { getStorage } from '../db/storage';
import { createLogger } from '../utils/logger';
import { caip2Network } from '../x402/middleware';

const log = createLogger('mpp-session');

export const MPP_SESSION_PROTOCOL = 'mpp-session';

/** Default timeout for disputes: 24 hours */
export const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** SACs and the assets the agent pays with use 7 decimal places. */
const DECIMALS = 7;

// ─── Types ─────────────────────────────────────────────────────────────────

export type ChannelStatus = 'Pending' | 'Active' | 'Closed' | 'Disputed';

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
  closedAt?: string;
  latestCommitment?: ChannelCommitment; // JSON-serialized
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
  totalAmount: z.string().regex(/^[1-9]\d*$/, 'totalAmount must be a positive integer in base units'),
  timeoutSeconds: z.number().int().positive(),
});

const ChannelStateSchema = z.object({
  id: z.string().uuid(),
  agent: z.string().refine(StrKey.isValidEd25519PublicKey, 'agent must be a G-address'),
  participant: z.string().refine(
    (v) => StrKey.isValidEd25519PublicKey(v) || StrKey.isValidContract(v),
    'participant must be a Stellar account or contract address'
  ),
  asset: z.string().refine(StrKey.isValidContract, 'asset must be a contract address'),
  totalAmount: z.string(),
  agentBalance: z.string(),
  participantBalance: z.string(),
  nonce: z.number().int().nonnegative(),
  status: z.enum(['Pending', 'Active', 'Closed', 'Disputed']),
  openedAt: z.string(),
  timeoutAt: z.string(),
  closedAt: z.string().optional(),
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

function toBaseUnits(amount: string): string {
  const [whole, fraction = '0'] = amount.split('.');
  const padded = fraction.padEnd(DECIMALS, '0').slice(0, DECIMALS);
  return (BigInt(whole) * 10n ** BigInt(DECIMALS) + BigInt(padded)).toString();
}

/**
 * The agent's spending policy, as applied to channel operations.
 * Reserves the total amount in the rolling window (committed on close).
 */
function reserveChannelSpend(amount: string): string {
  if (isPaused()) {
    throw new AgentPausedError('Agent is paused; MPP session operations are halted');
  }
  const parsed = parseFloat(amount);
  if (parsed > parseFloat(config.AGENT_SPENDING_LIMIT)) {
    throw new PolicyViolationError(
      `MPP session total of ${amount} exceeds AGENT_SPENDING_LIMIT of ${config.AGENT_SPENDING_LIMIT}`
    );
  }
  if (config.STELLAR_NETWORK === 'mainnet' && parsed > MAINNET_SPENDING_CAP) {
    throw new PolicyViolationError(
      `MPP session total of ${amount} exceeds mainnet spending cap of ${MAINNET_SPENDING_CAP}`
    );
  }
  return spendingTracker.reserve(amount);
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
    const agent = this.signer.publicKey();
    const totalDecimal = fromBaseUnits(totalAmount);
    const reservationId = reserveChannelSpend(totalDecimal);

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
      'MPP session opened'
    );

    // Note: In production, this would deploy/fund the escrow contract on-chain.
    // For the prototype, we skip the on-chain deployment and only persist state.

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
   * @param channelId - Channel identifier
   * @param finalCommitment - Latest signed commitment
   * @returns Transaction hash (in production)
   */
  async closeChannel(channelId: string, finalCommitment?: ChannelCommitment): Promise<string> {
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

    // In production, this would build and submit a Soroban transaction to the escrow contract.
    // For the prototype, we just update the status.

    await updateChannelStatus(channelId, 'Closed', new Date().toISOString());

    // Release the spending reservation (funds were locked on open)
    // Note: In a real implementation, we'd track the reservation ID from openChannel
    // For now, we skip this in the prototype

    log.info({ channelId, finalAgentBalance: commitment.agentBalance }, 'MPP session closed');

    // Return a mock transaction hash for the prototype
    return 'a'.repeat(64);
  }

  /**
   * Dispute a channel (force-close after timeout).
   *
   * @param channelId - Channel identifier
   * @returns Transaction hash (in production)
   */
  async disputeChannel(channelId: string): Promise<string> {
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

    // In production, this would build and submit a dispute transaction to the escrow contract.
    // For the prototype, we just update the status.

    await updateChannelStatus(channelId, 'Disputed', new Date().toISOString());

    log.info({ channelId }, 'MPP session disputed');

    // Return a mock transaction hash for the prototype
    return 'b'.repeat(64);
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
