/**
 * backend/x402/client.ts
 *
 * x402 v2 buyer-side client for Nodal AI.
 *
 * Wraps @x402/stellar's ExactStellarScheme and @x402/core's x402HTTPClient to
 * let the agent pay real x402 v2 endpoints end-to-end:
 *
 *   1. Make the initial request.
 *   2. On 402 read the PAYMENT-REQUIRED header → PaymentRequired.
 *   3. Choose a Stellar-compatible PaymentRequirements from `accepts[]`.
 *   4. Guard asset code + issuer against X402_ALLOWED_ASSETS / X402_MAX_PRICE.
 *   5. Guard the destination (payTo) against PAYMENT_DESTINATION_POLICY.
 *   6. Guard the amount against AGENT_SPENDING_LIMIT.
 *   7. Reserve the spend, sign the SAC auth entry, encode the PAYMENT header.
 *   8. Retry the request with the payment header.
 *   9. On confirmed settlement (successful PAYMENT-RESPONSE or a settlement tx
 *      hash, whatever the HTTP status) → commit the spend.
 *   10. On any failure → release the reservation.
 *
 * ## Design decisions
 *
 * ### Signer adapter
 * @x402/stellar's `ClientStellarSigner` wants SEP-43 `signAuthEntry(entryXdr,
 * {networkPassphrase})` → `Promise<string>` (base64 XDR).  Nodal's `Signer`
 * exposes `signAuthEntry(entry: xdr.SorobanAuthorizationEntry, ledger, passphrase)`
 * → `Promise<xdr.SorobanAuthorizationEntry>`.  The adapter in
 * `NodalClientStellarSigner` bridges the two: it deserialises the incoming
 * base64 XDR, calls Nodal's signer, and re-serialises the result.  The
 * `validUntilLedgerSeq` is derived by fetching the current ledger from
 * Soroban RPC and adding a small buffer (DEFAULT_AUTH_EXPIRY_LEDGERS = 50).
 *
 * ### Spend recorded only after settlement
 * `reserve()` is called *before* signing so that concurrent calls see the
 * pending spend.  `commit()` fires only when the response carries a successful
 * PAYMENT-RESPONSE settlement header.  `release()` fires on any error or on a
 * non-settlement response (e.g. a 402 retry loop that ultimately fails).
 *
 * ### Asset validation
 * `PaymentRequirements.asset` is a SEP-41 contract address (C…), not a
 * {code, issuer} tuple.  We validate it against `config.X402_ASSET_CONTRACT`
 * (and any contracts listed in the allow-list) rather than against asset codes.
 *
 * ### Network validation
 * The chosen `PaymentRequirements.network` must be the CAIP-2 identifier for
 * the agent's configured Stellar network.  Requirements on other networks are
 * filtered out before the selector runs.
 */

import { Asset, xdr } from '@stellar/stellar-sdk';

// Shared HTTP fetch helper with configurable timeout.
export interface HttpFetchOptions {
  /** Timeout in milliseconds (default from HTTP_TIMEOUT_MS env or 5000). */
  timeoutMs?: number;
  /** Additional fetch init options. */
  init?: RequestInit;
}

/**
 * Perform a fetch with an AbortSignal timeout.
 * All backend outbound HTTP calls should use this instead of raw fetch.
 */
export async function httpFetch(url: string, options: HttpFetchOptions = {}): Promise<Response> {
  // eslint-disable-next-line no-restricted-properties
  const { timeoutMs = Number(process.env.HTTP_TIMEOUT_MS) || 5000, init = {} } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timeout);
    return response;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { ExactStellarScheme } from '@x402/stellar/exact/client';
import type { ClientStellarSigner, RpcConfig } from '@x402/stellar';

import { config, MAINNET_SPENDING_CAP } from '../config';
import { createLogger } from '../utils/logger';
import { fromStroops, toStroops, tryToStroops } from '../utils/amount';
import { toCaip2 } from '../network';
import { assetKeyForPaymentAsset, spendingTracker } from '../spending_tracker';
import { PolicyViolationError } from '../errors';
import type { Signer } from '../signer';
import { resolveNetworkPassphrase, sorobanServer } from '../rpc_client';

const log = createLogger('x402-client');

// ─── Constants ────────────────────────────────────────────────────────────────

/** How many ledgers ahead the auth entry is valid (≈ 50 × 5 s = 250 s). */
const DEFAULT_AUTH_EXPIRY_LEDGERS = 50;

/** Largest stream request body buffered so it can be replayed on the paid retry. */
const MAX_BUFFERED_BODY_BYTES = 1024 * 1024;

// ─── Signer adapter ───────────────────────────────────────────────────────────

/**
 * Adapts Nodal's `Signer` to the `ClientStellarSigner` interface expected by
 * `@x402/stellar/exact/client`'s `ExactStellarScheme`.
 *
 * `ClientStellarSigner.signAuthEntry` receives a base64-encoded
 * `SorobanAuthorizationEntry` XDR and a `{networkPassphrase}` options object,
 * and must return the signed entry re-encoded as base64.
 *
 * `ClientStellarSigner.signTransaction` is optional and left unimplemented
 * because the Exact scheme's client role only signs auth entries; the
 * facilitator signs and submits the outer transaction.
 */
class NodalClientStellarSigner implements ClientStellarSigner {
  readonly address: string;

  constructor(private readonly signer: Signer) {
    this.address = signer.publicKey();
  }

  /**
   * Bridge between @x402/stellar's SEP-43 signAuthEntry (XDR base64 in/out)
   * and Nodal's Signer.signAuthEntry (xdr.SorobanAuthorizationEntry in/out).
   */
  async signAuthEntry(entryXdr: string, opts: { networkPassphrase: string }): Promise<string> {
    // Derive the ledger expiry: current ledger + buffer
    let validUntilLedgerSeq: number;
    try {
      const latestLedger = await sorobanServer.getLatestLedger();
      validUntilLedgerSeq = latestLedger.sequence + DEFAULT_AUTH_EXPIRY_LEDGERS;
    } catch (err) {
      // Without the current ledger any expiry we pick is wrong (0 is already
      // expired), so refuse to sign rather than hand out an unusable signature.
      log.warn('Could not fetch latest ledger for auth entry expiry; not signing');
      throw new RpcUnavailableError(
        'x402 v2: Soroban RPC is unavailable; cannot derive the auth entry expiry ledger',
        err
      );
    }

    // Deserialise the incoming base64 XDR → SorobanAuthorizationEntry
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64');

    const signed = await this.signer.signAuthEntry(
      entry,
      validUntilLedgerSeq,
      opts.networkPassphrase
    );

    // Re-serialise to base64 XDR for the @x402/stellar layer
    return signed.toXDR('base64');
  }
}

// ─── Guard helpers ────────────────────────────────────────────────────────────

/**
 * Returns the set of permitted SAC contract addresses from config.
 * Always includes `config.X402_ASSET_CONTRACT`. When `X402_ALLOWED_ASSETS` is
 * set, parses each `CODE:ISSUER` entry and derives its contract address from
 * the configured network passphrase.
 */
function allowedAssetContracts(): Set<string> {
  const contracts = new Set<string>([config.X402_ASSET_CONTRACT]);

  if (config.X402_ALLOWED_ASSETS) {
    const networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
    for (const entry of config.X402_ALLOWED_ASSETS.split(',').map((s) => s.trim())) {
      // PaymentRequirements.asset is a SAC contract id (C…), so convert each
      // "XLM" / "CODE:ISSUER" entry to its Stellar Asset Contract address.
      const [code = '', issuer] = entry.split(':');
      const asset = entry === 'XLM' ? Asset.native() : new Asset(code, issuer);
      contracts.add(asset.contractId(networkPassphrase));
    }
  }

  return contracts;
}

/**
 * Convert a PaymentRequirements amount to stroops. In x402 v2 `amount` is in
 * the token's smallest unit; the payable assets are Stellar Asset Contracts
 * wrapping classic assets, which always use 7 decimals, so one atomic unit is
 * exactly one stroop (0.01 USDC is "100000").
 */
function atomicAmountToStroops(amount: string): bigint {
  if (!/^\d+$/.test(amount)) throw new Error(`x402 v2: invalid payment amount "${amount}"`);
  return BigInt(amount);
}

/**
 * Map the SAC contract address a requirement pays in (`req.asset`) back to the
 * spending tracker's canonical asset key (`CODE:ISSUER` or `XLM`), so per-asset
 * SPENDING_LIMITS apply to the asset actually paid. The default x402 asset and
 * every `X402_ALLOWED_ASSETS` entry are recognised; anything else is keyed by
 * the contract address itself, which SPENDING_LIMITS_ALLOW_UNKNOWN then governs.
 */
function assetKeyForRequirement(asset: string): string {
  if (asset === config.X402_ASSET_CONTRACT) {
    return assetKey(config.X402_ASSET_CODE, config.X402_ASSET_ISSUER);
  }
  if (asset.toUpperCase() === 'XLM') return 'XLM';
  if (asset.includes(':')) {
    const [code, issuer] = asset.split(':');
    return assetKey(code!, issuer);
  }

  const networkPassphrase = {
    testnet: Networks.TESTNET,
    mainnet: Networks.PUBLIC,
    futurenet: Networks.FUTURENET,
  }[config.STELLAR_NETWORK];

  if (config.X402_ALLOWED_ASSETS) {
    for (const entry of config.X402_ALLOWED_ASSETS.split(',').map((s) => s.trim())) {
      const [code, issuer] = entry.split(':');
      const sac = entry === 'XLM' ? Asset.native() : new Asset(code!, issuer);
      if (sac.contractId(networkPassphrase) === asset) {
        return entry === 'XLM' ? 'XLM' : assetKey(code!, issuer);
      }
    }
  }

  return asset;
}

/**
 * Convert a PaymentRequirements amount to stroops. In x402 v2 `amount` is in
 * the token's smallest unit; the payable assets are Stellar Asset Contracts
 * wrapping classic assets, which always use 7 decimals, so one atomic unit is
 * exactly one stroop (0.01 USDC is "100000").
 */
function atomicAmountToStroops(amount: string): bigint {
  if (!/^\d+$/.test(amount)) throw new Error(`x402 v2: invalid payment amount "${amount}"`);
  return BigInt(amount);
}

/**
 * Guard the amount from a PaymentRequirements against AGENT_SPENDING_LIMIT and
 * the mainnet hard cap. Throws with a clear message if either is exceeded.
 */
function assertAmountWithinLimits(stroops: bigint): void {
  const amount = fromStroops(stroops);

  const limit = tryToStroops(config.AGENT_SPENDING_LIMIT);
  if (limit !== null && stroops > limit) {
    throw new Error(
      `x402 v2: amount ${amount} exceeds AGENT_SPENDING_LIMIT of ${config.AGENT_SPENDING_LIMIT}`
    );
  }

  if (config.STELLAR_NETWORK === 'mainnet' && stroops > toStroops(String(MAINNET_SPENDING_CAP))) {
    throw new Error(
      `x402 v2: amount ${amount} exceeds mainnet spending cap of ${MAINNET_SPENDING_CAP}`
    );
  }

  if (config.X402_MAX_PRICE && stroops > toStroops(config.X402_MAX_PRICE)) {
    throw new Error(`x402 v2: amount ${amount} exceeds X402_MAX_PRICE of ${config.X402_MAX_PRICE}`);
  }
}

/**
 * Guard the `payTo` address against PAYMENT_DESTINATION_POLICY.
 * Mirrors the same logic used by StellarPaymentTool / agent.ts.
 */
/**
 * Convert a PaymentRequirements amount to stroops. In x402 v2 `amount` is in
 * the token's smallest unit; the payable assets are Stellar Asset Contracts
 * wrapping classic assets, which always use 7 decimals, so one atomic unit is
 * exactly one stroop (0.01 USDC is "100000").
 */
function atomicAmountToStroops(amount: string): bigint {
  if (!/^\d+$/.test(amount)) throw new Error(`x402 v2: invalid payment amount "${amount}"`);
  return BigInt(amount);
}

/**
 * Refuses a resource URL whose hostname is not in `ALLOWED_X402_ORIGINS`.
 * Unset (default) means any origin is allowed.
 */
function assertOriginAllowed(url: URL): void {
  if (!config.ALLOWED_X402_ORIGINS) return;

  const allowedOrigins = new Set(config.ALLOWED_X402_ORIGINS.split(',').map((o) => o.trim()));
  if (!allowedOrigins.has(url.hostname)) {
    throw new Error(`x402 v2: untrusted resource origin: ${url.hostname}`);
  }
}

function assertPayToAllowed(payTo: string, selfAddress: string): void {
  if (payTo === selfAddress) {
    throw new Error("x402 v2: payTo cannot be the agent's own address");
  }

  const policy = config.PAYMENT_DESTINATION_POLICY;
  if (policy === 'open') return;

  const listed = new Set(config.PAYMENT_DESTINATIONS.map((d) => d.toLowerCase()));
  const isListed = listed.has(payTo.toLowerCase());
  if (policy === 'allowlist' ? !isListed : isListed) {
    throw new PolicyViolationError(
      `x402 v2: payTo ${payTo} is not permitted by the ${policy} payment destination policy`
    );
  }
}

/** Hosts allowed over plain HTTP outside mainnet (local development). */
const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Normalise an ALLOWED_X402_ORIGINS entry to a full origin
 * (`scheme://host[:port]`). Bare hostnames mean the default HTTPS origin.
 */
function normalizeOrigin(entry: string): string {
  const withScheme = entry.includes('://') ? entry : `https://${entry}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return entry;
  }
}

/**
 * Guard the resource URL before any request is made: it must be HTTPS (plain
 * HTTP only for localhost off mainnet) and, when ALLOWED_X402_ORIGINS is set,
 * its full origin (scheme, host and port) must be listed.
 */
function assertOriginAllowed(url: URL): void {
  if (url.protocol !== 'https:') {
    const devLocalhost =
      url.protocol === 'http:' &&
      LOCALHOST_HOSTNAMES.has(url.hostname) &&
      config.STELLAR_NETWORK !== 'mainnet';
    if (!devLocalhost) {
      throw new Error(`x402 v2: refusing non-HTTPS resource origin: ${url.origin}`);
    }
  }

  if (config.ALLOWED_X402_ORIGINS) {
    const allowedOrigins = new Set(
      config.ALLOWED_X402_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0)
        .map(normalizeOrigin)
    );
    if (!allowedOrigins.has(url.origin)) {
      throw new Error(`x402 v2: untrusted resource origin: ${url.origin}`);
    }
  }
}

// ─── Request body replay ──────────────────────────────────────────────────────

/**
 * The probe and the paid retry send the same `init`. A `ReadableStream` body is
 * consumed by the probe, so it is read into memory up front (capped at
 * MAX_BUFFERED_BODY_BYTES) and both requests send the buffered bytes. Other
 * body types (string, Buffer/ArrayBuffer, Blob, FormData, URLSearchParams) are
 * replayable and passed through unchanged.
 */
async function toReplayableInit(init?: RequestInit): Promise<RequestInit | undefined> {
  const body = init?.body;
  if (!(body instanceof ReadableStream)) return init;

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BUFFERED_BODY_BYTES) {
      await reader.cancel();
      throw new Error(
        `x402 v2: stream request body exceeds ${MAX_BUFFERED_BODY_BYTES} bytes; ` +
          `pass a string, Buffer or FormData body instead`
      );
    }
    chunks.push(value);
  }

  const buffered = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffered.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // `duplex` is only meaningful for stream bodies.
  const replayable: RequestInit & { duplex?: string } = { ...init, body: buffered };
  delete replayable.duplex;
  return replayable;
}

// ─── Requirement selection ────────────────────────────────────────────────────

/**
 * Choose the first PaymentRequirements entry from `accepts` that:
 *  - uses the `"exact"` scheme
 *  - targets the agent's CAIP-2 network
 *  - requests an asset the agent is configured to pay
 *
 * Returns `undefined` when no compatible option exists.
 */
function selectRequirements(
  accepts: PaymentRequirements[],
  agentNetwork: string,
  allowed: Set<string>
): PaymentRequirements | undefined {
  for (const req of accepts) {
    if (req.scheme !== 'exact') continue;
    if (req.network !== agentNetwork && req.network !== 'stellar:*') continue;

    // req.asset is a SAC contract address (C…); `allowed` holds the SAC ids of
    // the default asset and every asset listed in X402_ALLOWED_ASSETS.
    if (allowed.has(req.asset) || allowed.has(req.asset.toUpperCase())) return req;

    // Fallback: accept the default asset contract on this network.
    if (req.asset === config.X402_ASSET_CONTRACT) return req;
  }
  return undefined;
}

// ─── Main client class ────────────────────────────────────────────────────────

/**
 * Result returned by `X402FetchClient.fetch()`.
 */
export interface X402FetchResult {
  /** The final HTTP response (200 on success, original non-402 status otherwise). */
  response: Response;
  /**
   * Settlement details from the PAYMENT-RESPONSE header, when the server
   * confirmed the payment.  `undefined` when no payment was required or the
   * server did not return a settlement header.
   */
  settlement?: SettleResponse | undefined;
}

/**
 * x402 v2 buyer client.
 *
 * Construct once and reuse across requests; the underlying `x402Client` is
 * stateless between calls (schemes are registered once at construction).
 *
 * @example
 * ```typescript
 * import { X402FetchClient } from './backend/x402/client';
 * import { createAgentSigner } from './backend/signer';
 *
 * const client = new X402FetchClient(createAgentSigner());
 * const { response, settlement } = await client.fetch('https://api.example.com/paid');
 * const data = await response.json();
 * ```
 */
export class X402FetchClient {
  private readonly httpClient: x402HTTPClient;
  private readonly agentAddress: string;
  private readonly agentNetwork: string;
  private readonly allowed: Set<string>;

  constructor(signer: Signer) {
    this.agentAddress = signer.publicKey();
    this.agentNetwork = toCaip2(config.STELLAR_NETWORK);
    this.allowed = allowedAssetContracts();

    const stellarSigner = new NodalClientStellarSigner(signer);
    const rpcConfig: RpcConfig = { url: config.SOROBAN_RPC_URL };

    const scheme = new ExactStellarScheme(stellarSigner, rpcConfig);

    const client = new x402Client().register('stellar:*', scheme);
    this.httpClient = new x402HTTPClient(client);
  }

  /**
   * Fetch `url` with automatic x402 v2 payment handling.
   *
   * If the server returns 402 with a compatible PAYMENT-REQUIRED header, this
   * method:
   *   1. Selects a Stellar-compatible PaymentRequirements from `accepts`.
   *   2. Runs all spending/policy guards before touching the signer.
   *   3. Reserves the spend against the rolling window.
   *   4. Signs the SAC auth entry and encodes the PAYMENT header.
   *   5. Retries the original request with the PAYMENT header attached.
   *   6. Commits the spend on 200 + settlement; releases on any failure.
   *
   * Non-402 responses are returned as-is (no payment attempted).
   * A 402 that contains no Stellar-compatible option throws immediately
   * without touching the signer or the spending window.
   *
   * @param url - Target URL.
   * @param init - Optional RequestInit forwarded to both the probe and paid requests.
   *   Bodies should be string, Buffer or FormData; a `ReadableStream` body is
   *   buffered (up to 1 MiB) so the paid retry can resend it.
   * @returns The final response and optional settlement details.
   */
  async fetch(url: string | URL, init?: RequestInit): Promise<X402FetchResult> {
    const urlStr = url instanceof URL ? url.toString() : url;
    const replayInit = await toReplayableInit(init);

    // ── 0. Origin guard (before any request leaves the agent) ────────────────
    assertOriginAllowed(new URL(urlStr));

    // ── 1. Probe request ─────────────────────────────────────────────────────
    const probeResponse = await globalThis.fetch(urlStr, replayInit);

    if (probeResponse.status !== 402) {
      return { response: probeResponse };
    }

    // ── 2. Parse payment requirements from PAYMENT-REQUIRED header ───────────
    let paymentRequired: PaymentRequired;
    try {
      paymentRequired = this.httpClient.getPaymentRequiredResponse(
        (name) => probeResponse.headers.get(name),
        await probeResponse
          .clone()
          .json()
          .catch(() => undefined)
      );
    } catch (err) {
      throw new Error(
        `x402 v2: failed to parse PAYMENT-REQUIRED header from ${urlStr}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // ── 3. Select a compatible requirement ───────────────────────────────────
    const chosen = selectRequirements(paymentRequired.accepts, this.agentNetwork, this.allowed);

    if (!chosen) {
      const networks = [...new Set(paymentRequired.accepts.map((r) => r.network))].join(', ');
      const assets = [...new Set(paymentRequired.accepts.map((r) => r.asset))].join(', ');
      throw new Error(
        `x402 v2: no compatible payment option for ${urlStr}. ` +
          `Server accepts networks [${networks}], assets [${assets}]. ` +
          `Agent is on ${this.agentNetwork} with asset contract ${config.X402_ASSET_CONTRACT}.`
      );
    }

    // ── 4. Pre-payment guards (before reserving or signing) ──────────────────
    const amountStroops = atomicAmountToStroops(chosen.amount);
    assertAmountWithinLimits(amountStroops);
    assertPayToAllowed(chosen.payTo, this.agentAddress);

    // ── 5. Reserve spend ─────────────────────────────────────────────────────
    const reservationId = spendingTracker.reserve(
      chosen.amount,
      assetKeyForPaymentAsset(chosen.asset)
    );

    let paymentPayload;
    try {
      // ── 6. Sign the SAC auth entry and build the payment payload ───────────
      paymentPayload = await this.httpClient.createPaymentPayload(paymentRequired);
    } catch (err) {
      spendingTracker.release(reservationId);
      // Keep the typed error so the caller can tell an RPC outage (retryable)
      // from other signing failures.
      if (err instanceof RpcUnavailableError) throw err;
      throw new Error(
        `x402 v2: failed to create payment payload for ${urlStr}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // ── 7. Encode PAYMENT header and retry ────────────────────────────────────
    const paymentHeaders = this.httpClient.encodePaymentSignatureHeader(paymentPayload);

    const paidResponse = await globalThis.fetch(urlStr, {
      ...replayInit,
      headers: {
        ...(replayInit?.headers as Record<string, string> | undefined),
        ...paymentHeaders,
      },
    });

    // ── 8. Read settlement header and commit / release spend ─────────────────
    let settlement: SettleResponse | undefined;
    try {
      const { settleResponse } = await this.httpClient.processPaymentResult(
        paymentPayload,
        (name) => paidResponse.headers.get(name),
        paidResponse.status
      );
      settlement = settleResponse;
    } catch {
      // processPaymentResult failing is non-fatal; we already have the response.
    }

    // Funds leave once the facilitator settles, even if the resource server
    // then errors, so commit on settlement independent of the HTTP status.
    const settled = settlement?.success === true || !!settlement?.transaction;

    if (settled) {
      spendingTracker.commit(reservationId);
      log.info(
        { url: urlStr, amount: chosen.amount, asset: chosen.asset, network: chosen.network },
        'x402 v2 payment settled'
      );
      if (paidResponse.status !== 200) {
        log.warn(
          { url: urlStr, status: paidResponse.status, transaction: settlement?.transaction },
          'x402 v2 payment settled but the paid request did not return 200; spend committed'
        );
      }
    } else {
      spendingTracker.release(reservationId);
      if (paidResponse.status !== 200) {
        log.warn(
          { url: urlStr, status: paidResponse.status },
          'x402 v2 paid request did not return 200; spend released'
        );
      }
    }

    return { response: paidResponse, settlement };
  }
}
