/**
 * tests/x402_interop.test.ts
 *
 * x402 v2 interoperability test suite.
 * Covers legacy path, v2 buyer, v2 seller middleware, flag isolation,
 * and facilitator validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { Asset, Networks } from '@stellar/stellar-sdk';
import type { Keypair } from '@stellar/stellar-sdk';
import { config, AgentConfig } from '../backend/config';
import { X402PaymentTool } from '../backend/tools/X402PaymentTool';
import { createX402Middleware } from '../backend/x402/server';
import { X402FetchClient } from '../backend/x402/client';
import { StellarPaymentTool } from '../backend/tools/StellarPaymentTool';
import Database from 'better-sqlite3';
import { _setDb } from '../backend/persistence';
import { spendingTracker } from '../backend/spending_tracker';
import { x402RateLimiter } from '../backend/x402_rate_limiter';
import type { Signer } from '../backend/signer';
import { RpcUnavailableError } from '../backend/errors';
import { sorobanServer } from '../backend/rpc_client';

// ─── Mock dependencies ────────────────────────────────────────────────────────

vi.mock('../backend/config', () => {
  const mockConfig: AgentConfig = {
    STELLAR_NETWORK: 'testnet',
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    AGENT_PUBLIC_KEY: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    agentKeypair: () =>
      ({
        publicKey: () => 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        secret: () => 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X',
      }) as unknown as Keypair,
    DB_PATH: ':memory:',
    STORAGE_BACKEND: 'sqlite' as const,
    X402_ASSET_CODE: 'USDC',
    X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    X402_ASSET_CONTRACT: 'CD5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    AGENT_SPENDING_LIMIT: '100',
    APPROVAL_TTL_MS: 3600000,
    MPP_SESSION_SWEEP_INTERVAL_MS: 60_000,
    PAYMENT_DESTINATION_POLICY: 'open' as const,
    PAYMENT_DESTINATIONS: [],
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
    ALLOWED_X402_ORIGINS: undefined,
    X402_MAX_PRICE: undefined,
    X402_ALLOWED_ASSETS: undefined,
    AGENT_SECRET_KEY_ARN: undefined,
    SIGNER_BACKEND: 'local' as const,
    VAULT_TRANSIT_MOUNT: 'transit',
    VAULT_TRANSIT_KEY: undefined,
    SPENDING_WINDOW_MS: 86400000,
    ACCOUNT_CACHE_TTL_MS: 30000,
    RPC_TIMEOUT_MS: 6000,
    TOML_CACHE_TTL_MS: 300000,
    MAX_X402_PAYMENTS_PER_MINUTE: 10,
    X402_NONCE_TTL_MS: 86400000,
    RETENTION_DAYS_RESULTS: 30,
    RETENTION_DAYS_APPROVALS: 30,
    RETENTION_DAYS_TRIGGER_EVENTS: 30,
    RETENTION_JOB_INTERVAL_MS: 86400000,
    MAX_SOROBAN_FEE_STROOPS: 1000000,
    MAX_FEE_STROOPS: 100000,
    MAX_CONCURRENT_TASKS: 10,
    QUEUE_CAPACITY: 0,
    MCP_ALLOW_PAYMENTS: false,
    MCP_TRANSPORT: 'stdio' as const,
    MCP_PORT: 3001,
    MCP_HOST: '127.0.0.1',
    MCP_MAX_BODY_BYTES: 1_048_576,
    TRIGGER_ALLOW_PAYMENTS: false,
    HEALTH_PORT: 3000,
    NANO_ENABLED: false,
    OTEL_REDACT_TX_HASH: false,
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    ALERT_SPENDING_THRESHOLDS: [0.8, 1],
    ALERT_FAILURE_THRESHOLD: 5,
    ALERT_FAILURE_WINDOW_MS: 300_000,
    LLM_MAX_TOKENS_PER_REQUEST: 8_000,
    LLM_MAX_TOKENS_PER_STEP: 16_000,
    LLM_MAX_TOOL_CALL_ITERATIONS: 25,
    LLM_MAX_TOKENS_PER_DAY: 1_000_000,
    SESSION_TTL_MS: 1_800_000,
    SESSION_MAX_MESSAGES: 50,
    SESSION_MAX_SESSIONS: 500,
    WEBHOOK_URL: undefined,
    WEBHOOK_SECRET: undefined,
    ADMIN_API_TOKEN: undefined,
    WEBHOOK_LEGACY_SIGNATURE: false,
    PAUSED: false,
    LLM_PROVIDER: 'mock' as const,
    LLM_MODEL: undefined,
    LLM_BASE_URL: undefined,
    LLM_TIMEOUT_MS: 60000,
    LLM_MAX_TOKENS: 4096,
    LLM_TEMPERATURE: 0.7,
    // New x402 v2 config fields
    X402_USE_LEGACY: false,
    X402_FACILITATOR_URL: 'https://facilitator.example.com',
    SPENDING_LIMITS_MAP: new Map<string, string>(),
    SPENDING_LIMITS_ALLOW_UNKNOWN: false,
    NANO_RPC_URL: 'http://127.0.0.1:7076',
    NANO_ENABLED: false,
  };

  return {
    config: mockConfig,
    getNanoSeed: () => undefined,
  };
});

vi.mock('../backend/signer', () => ({
  createAgentSigner: () => ({
    publicKey: () => 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  }),
  Signer: class {},
}));

vi.mock('../backend/rpc_client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withRetry: (fn: () => Promise<unknown>) => fn(),
  sorobanServer: { getLatestLedger: vi.fn() },
  horizonServer: {
    ledgers: vi.fn().mockReturnValue({
      ledger: vi.fn().mockReturnValue({
        call: vi.fn().mockResolvedValue({ closed_at: new Date().toISOString() }),
      }),
    }),
    transactions: vi.fn().mockReturnValue({
      transaction: vi.fn().mockReturnValue({
        call: vi.fn().mockResolvedValue({ memo: '', _hash: '' }),
      }),
    }),
    operations: vi.fn().mockReturnValue({
      forTransaction: vi.fn().mockReturnValue({
        call: vi.fn().mockResolvedValue({ records: [] }),
      }),
    }),
  },
}));

vi.mock('../backend/tools/StellarPaymentTool', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  StellarPaymentTool: vi.fn().mockImplementation(function () {
    return {
      execute: vi.fn().mockResolvedValue({ txHash: 'legacy_tx_hash', ledger: 99 }),
    };
  }),
}));

// The seam X402FetchClient talks through: signing and header encoding belong to
// the x402 packages, the guards and the spend accounting under test are ours.
const { httpClient, stellarSigners } = vi.hoisted(() => ({
  // Signer adapters handed to ExactStellarScheme, one per X402FetchClient.
  stellarSigners: [] as Array<{
    signAuthEntry: (entryXdr: string, opts: { networkPassphrase: string }) => Promise<string>;
  }>,
  httpClient: {
    getPaymentRequiredResponse: vi.fn(),
    createPaymentPayload: vi.fn(),
    encodePaymentSignatureHeader: vi.fn(),
    processPaymentResult: vi.fn(),
  },
}));

vi.mock('@x402/core/client', () => ({
  x402Client: class {
    register(): this {
      return this;
    }
  },
  x402HTTPClient: class {
    constructor() {
      return httpClient;
    }
  },
}));

vi.mock('@x402/stellar/exact/client', () => ({
  ExactStellarScheme: class {
    constructor(signer: (typeof stellarSigners)[number]) {
      stellarSigners.push(signer);
    }
  },
}));

// ─── Helper functions ─────────────────────────────────────────────────────────

/** The real config module, past this file's vi.mock. */
function realConfig(): Promise<typeof import('../backend/config')> {
  return vi.importActual<typeof import('../backend/config')>('../backend/config');
}

function futureIso(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function createValidChallenge(overrides: Record<string, unknown> = {}): any {
  return {
    resource: 'https://api.example.com/data',
    amount: '1.5000000',
    assetCode: 'USDC',
    assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    payTo: 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57',
    nonce: randomUUID(),
    expiresAt: futureIso(),
    ...overrides,
  };
}

const PAID_URL = 'https://api.example.com/data';
const EURC_ISSUER = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2';
const EURC_KEY = `EURC:${EURC_ISSUER}`;
const USDC_KEY = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/** Temporarily override mutable config fields for one test. */
async function withConfig(
  overrides: Partial<Record<keyof AgentConfig, unknown>>,
  fn: () => Promise<void>
): Promise<void> {
  const mutable = config as unknown as Record<string, unknown>;
  const original: Record<string, unknown> = {};
  for (const key of Object.keys(overrides)) original[key] = mutable[key];
  Object.assign(mutable, overrides);
  try {
    await fn();
  } finally {
    Object.assign(mutable, original);
  }
}
const AGENT_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function requirement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: 'exact',
    network: 'stellar:testnet',
    asset: config.X402_ASSET_CONTRACT,
    amount: '15000000', // atomic units: 1.5 USDC at 7 decimals
    payTo: createValidChallenge().payTo,
    ...overrides,
  };
}

/** The server answers 402 to the probe, then `paidStatus` to the paid retry. */
function stubPaidServer(paidStatus = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response('{}', { status: 402 }))
    .mockResolvedValueOnce(new Response('{}', { status: paidStatus }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function buyer(): X402FetchClient {
  return new X402FetchClient({ publicKey: () => AGENT_ADDRESS } as unknown as Signer);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('x402 v2 Interoperability', () => {
  let originalX402_USE_LEGACY: string | undefined;
  let originalX402_FACILITATOR_URL: string | undefined;

  beforeAll(() => {
    originalX402_USE_LEGACY = process.env.X402_USE_LEGACY;
    originalX402_FACILITATOR_URL = process.env.X402_FACILITATOR_URL;
  });

  afterAll(() => {
    if (originalX402_USE_LEGACY !== undefined) {
      process.env.X402_USE_LEGACY = originalX402_USE_LEGACY;
    } else {
      delete process.env.X402_USE_LEGACY;
    }
    if (originalX402_FACILITATOR_URL !== undefined) {
      process.env.X402_FACILITATOR_URL = originalX402_FACILITATOR_URL;
    } else {
      delete process.env.X402_FACILITATOR_URL;
    }
  });

  let mockExecute: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Reset to v2 default
    process.env.X402_USE_LEGACY = '0';
    process.env.X402_FACILITATOR_URL = 'https://facilitator.example.com';

    _setDb(new Database(':memory:'));
    x402RateLimiter.clear();
    spendingTracker._resetForTests();

    mockExecute = vi.fn().mockResolvedValue({ txHash: 'legacy_tx_hash_123', ledger: 101 });
    vi.mocked(StellarPaymentTool).mockImplementation(function () {
      return { execute: mockExecute } as unknown as StellarPaymentTool;
    });

    httpClient.getPaymentRequiredResponse.mockReturnValue({ accepts: [requirement()] });
    httpClient.createPaymentPayload.mockResolvedValue({ payload: 'signed' });
    httpClient.encodePaymentSignatureHeader.mockReturnValue({ 'X-PAYMENT': 'signed' });
    httpClient.processPaymentResult.mockResolvedValue({ settleResponse: { success: true } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Legacy path (X402_USE_LEGACY=1)', () => {
    it('should use legacy SHA-256 memo flow when flag is enabled', async () => {
      // Set legacy mode
      process.env.X402_USE_LEGACY = '1';

      const { X402PaymentTool } = await import('../backend/tools/X402PaymentTool');
      const tool = new X402PaymentTool();

      const challenge = createValidChallenge();

      const result = await tool.respond(challenge);

      expect(result.protocol).toBe('x402');
      expect(result.txHash).toBe('legacy_tx_hash_123');
      expect(result.network).toBe('stellar:testnet');
      expect(mockExecute).toHaveBeenCalled();
    });

    it('should reject challenges with expired expiresAt', async () => {
      process.env.X402_USE_LEGACY = '1';

      const { X402PaymentTool } = await import('../backend/tools/X402PaymentTool');
      const tool = new X402PaymentTool();

      const challenge = createValidChallenge({
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });

      await expect(tool.respond(challenge)).rejects.toThrow('x402 challenge expired');
    });
  });

  // v2 buying goes through agent.fetchPaid() -> X402FetchClient. The plan in
  // .agents/tasks/plan.md proposed X402PaymentTool.respondV2(), but that was
  // never built; these tests used to target it and could not run.
  describe('V2 buyer path (X402_USE_LEGACY=0)', () => {
    it('pays a 402 with the signed header and commits the spend on settlement', async () => {
      const fetchMock = stubPaidServer();

      const { response, settlement } = await buyer().fetch(PAID_URL);

      expect(response.status).toBe(200);
      expect(settlement?.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]![1].headers).toEqual({ 'X-PAYMENT': 'signed' });
      expect(spendingTracker.total()).toBeCloseTo(1.5);
    });

    it('chooses the exact-scheme offer on the agent network from accepts', async () => {
      httpClient.getPaymentRequiredResponse.mockReturnValue({
        accepts: [
          requirement({ network: 'stellar:pubnet', amount: '90000000' }),
          requirement({ scheme: 'upto', amount: '80000000' }),
          requirement({ amount: '20000000' }),
        ],
      });
      stubPaidServer();

      await buyer().fetch(PAID_URL);

      expect(spendingTracker.total()).toBeCloseTo(2);
    });

    it('refuses a 402 with no compatible offer, before signing or reserving', async () => {
      httpClient.getPaymentRequiredResponse.mockReturnValue({
        accepts: [requirement({ network: 'stellar:pubnet' })],
      });
      stubPaidServer();

      await expect(buyer().fetch(PAID_URL)).rejects.toThrow(/no compatible payment option/);

      expect(httpClient.createPaymentPayload).not.toHaveBeenCalled();
      expect(spendingTracker.total()).toBe(0);
    });

    it('rejects a 402 that carries no valid v2 challenge', async () => {
      httpClient.getPaymentRequiredResponse.mockImplementation(() => {
        throw new Error('no PAYMENT-REQUIRED header');
      });
      stubPaidServer();

      await expect(buyer().fetch(PAID_URL)).rejects.toThrow(/failed to parse PAYMENT-REQUIRED/);

      expect(httpClient.createPaymentPayload).not.toHaveBeenCalled();
    });

    it('refuses to pay its own address', async () => {
      httpClient.getPaymentRequiredResponse.mockReturnValue({
        accepts: [requirement({ payTo: AGENT_ADDRESS })],
      });
      stubPaidServer();

      await expect(buyer().fetch(PAID_URL)).rejects.toThrow(/own address/);

      expect(httpClient.createPaymentPayload).not.toHaveBeenCalled();
    });

    it('reserves 0.01 USDC for an atomic 100000 requirement under a 1 USDC limit', async () => {
      const mutable = config as unknown as { AGENT_SPENDING_LIMIT: string };
      const original = mutable.AGENT_SPENDING_LIMIT;
      mutable.AGENT_SPENDING_LIMIT = '1';
      try {
        // 0.01 USDC at 7 decimals
        httpClient.getPaymentRequiredResponse.mockReturnValue({
          accepts: [requirement({ amount: '100000' })],
        });
        stubPaidServer();

        const { settlement } = await buyer().fetch(PAID_URL);

        expect(settlement?.success).toBe(true);
        expect(spendingTracker.total()).toBe(0.01);
      } finally {
        mutable.AGENT_SPENDING_LIMIT = original;
      }
    });

    it('rejects an atomic amount above AGENT_SPENDING_LIMIT', async () => {
      httpClient.getPaymentRequiredResponse.mockReturnValue({
        accepts: [requirement({ amount: '1000000001' })], // 100.0000001 USDC
      });
      stubPaidServer();

      await expect(buyer().fetch(PAID_URL)).rejects.toThrow(/exceeds AGENT_SPENDING_LIMIT/);

      expect(httpClient.createPaymentPayload).not.toHaveBeenCalled();
      expect(spendingTracker.total()).toBe(0);
    });

    describe('X402_ALLOWED_ASSETS', () => {
      const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
      const EURC_CONTRACT = new Asset('EURC', ISSUER).contractId(Networks.TESTNET);
      const XLM_CONTRACT = Asset.native().contractId(Networks.TESTNET);
      const mutable = config as unknown as { X402_ALLOWED_ASSETS: string | undefined };

      afterEach(() => {
        mutable.X402_ALLOWED_ASSETS = undefined;
      });

      it('selects a second allowed CODE:ISSUER asset by its SAC contract id', async () => {
        mutable.X402_ALLOWED_ASSETS = `EURC:${ISSUER}`;
        httpClient.getPaymentRequiredResponse.mockReturnValue({
          accepts: [requirement({ asset: EURC_CONTRACT })],
        });
        stubPaidServer();

        const { settlement } = await buyer().fetch(PAID_URL);

        expect(settlement?.success).toBe(true);
        expect(httpClient.createPaymentPayload).toHaveBeenCalled();
      });

      it('maps XLM to the native SAC', async () => {
        mutable.X402_ALLOWED_ASSETS = 'XLM';
        httpClient.getPaymentRequiredResponse.mockReturnValue({
          accepts: [requirement({ asset: XLM_CONTRACT })],
        });
        stubPaidServer();

        const { settlement } = await buyer().fetch(PAID_URL);

        expect(settlement?.success).toBe(true);
      });

      it('still refuses an asset that is not on the allowlist', async () => {
        mutable.X402_ALLOWED_ASSETS = 'XLM';
        httpClient.getPaymentRequiredResponse.mockReturnValue({
          accepts: [requirement({ asset: EURC_CONTRACT })],
        });
        stubPaidServer();

        await expect(buyer().fetch(PAID_URL)).rejects.toThrow(/no compatible payment option/);
        expect(httpClient.createPaymentPayload).not.toHaveBeenCalled();
      });
    });

    it('releases the reservation when the paid request does not settle', async () => {
      httpClient.processPaymentResult.mockRejectedValue(new Error('no settlement header'));
      stubPaidServer(500);

      const { response } = await buyer().fetch(PAID_URL);

      expect(response.status).toBe(500);
      expect(spendingTracker.total()).toBe(0);
    });

    // #924: settlement, not the HTTP status, decides whether money left.
    it('commits the spend when settlement succeeded but the server returned 500', async () => {
      httpClient.processPaymentResult.mockResolvedValue({
        settleResponse: { success: true, transaction: 'abc123' },
      });
      stubPaidServer(500);

      const { response } = await buyer().fetch(PAID_URL);

      expect(response.status).toBe(500);
      expect(spendingTracker.total()).toBeCloseTo(1.5);
    });

    it('releases the reservation when no settlement is reported', async () => {
      httpClient.processPaymentResult.mockResolvedValue({ settleResponse: undefined });
      stubPaidServer(200);

      await buyer().fetch(PAID_URL);

      expect(spendingTracker.total()).toBe(0);
    });

    it('releases the reservation when signing fails', async () => {
      httpClient.createPaymentPayload.mockRejectedValue(new Error('signer offline'));
      stubPaidServer();

      await expect(buyer().fetch(PAID_URL)).rejects.toThrow(/failed to create payment payload/);

      expect(spendingTracker.total()).toBe(0);
    });

    // #926: a stream body is consumed by the probe, so it must be buffered.
    it('pays a POST with a stream body and delivers the body on the paid retry', async () => {
      const fetchMock = stubPaidServer();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"query":'));
          controller.enqueue(new TextEncoder().encode('"weather"}'));
          controller.close();
        },
      });

      const { response } = await buyer().fetch(PAID_URL, {
        method: 'POST',
        body,
        duplex: 'half',
      } as RequestInit);

      expect(response.status).toBe(200);
      const decode = (b: unknown): string => new TextDecoder().decode(b as Uint8Array);
      expect(decode(fetchMock.mock.calls[0]![1].body)).toBe('{"query":"weather"}');
      expect(decode(fetchMock.mock.calls[1]![1].body)).toBe('{"query":"weather"}');
      expect(fetchMock.mock.calls[1]![1].method).toBe('POST');
      expect(spendingTracker.total()).toBeCloseTo(1.5);
    });

    // #921: the reservation is keyed by the asset actually paid.
    it('reserves a payment in another allowed asset under that asset key', async () => {
      httpClient.getPaymentRequiredResponse.mockReturnValue({
        accepts: [requirement({ asset: EURC_KEY })],
      });
      stubPaidServer();

      await withConfig(
        {
          X402_ALLOWED_ASSETS: EURC_KEY,
          SPENDING_LIMITS_MAP: new Map([
            [USDC_KEY, '100'],
            [EURC_KEY, '100'],
          ]),
        },
        async () => {
          await buyer().fetch(PAID_URL);
        }
      );

      expect(spendingTracker.totalForAsset(EURC_KEY)).toBe(15_000_000n);
      expect(spendingTracker.totalForAsset(USDC_KEY)).toBe(0n);
    });

    it('denies an asset missing from SPENDING_LIMITS unless unknown assets are allowed', async () => {
      httpClient.getPaymentRequiredResponse.mockReturnValue({
        accepts: [requirement({ asset: EURC_KEY })],
      });

      await withConfig(
        {
          X402_ALLOWED_ASSETS: EURC_KEY,
          SPENDING_LIMITS_MAP: new Map([[USDC_KEY, '100']]),
          SPENDING_LIMITS_ALLOW_UNKNOWN: false,
        },
        async () => {
          stubPaidServer();
          await expect(buyer().fetch(PAID_URL)).rejects.toThrow(/SPENDING_LIMITS_ALLOW_UNKNOWN/);
          expect(httpClient.createPaymentPayload).not.toHaveBeenCalled();
        }
      );

      await withConfig(
        {
          X402_ALLOWED_ASSETS: EURC_KEY,
          SPENDING_LIMITS_MAP: new Map([[USDC_KEY, '100']]),
          SPENDING_LIMITS_ALLOW_UNKNOWN: true,
        },
        async () => {
          stubPaidServer();
          await buyer().fetch(PAID_URL);
        }
      );

      expect(spendingTracker.totalForAsset(EURC_KEY)).toBe(15_000_000n);
    });

    it('needs no facilitator: settlement is the seller side of the protocol', async () => {
      const mutable = config as unknown as { X402_FACILITATOR_URL: string | undefined };
      const original = mutable.X402_FACILITATOR_URL;
      mutable.X402_FACILITATOR_URL = undefined;
      try {
        stubPaidServer();
        const { settlement } = await buyer().fetch(PAID_URL);
        expect(settlement?.success).toBe(true);
      } finally {
        mutable.X402_FACILITATOR_URL = original;
      }
    });
  });

  describe('V2 seller middleware (Express)', () => {
    let app: any;

    beforeEach(() => {
      app = {
        use: vi.fn(),
        get: vi.fn(),
        post: vi.fn(),
      };
    });

    it('should create middleware that returns v2 challenges when X402_USE_LEGACY=false', async () => {
      delete process.env.X402_USE_LEGACY; // Use default (false)

      const { createX402Middleware } = await import('../backend/x402/server');
      const middleware = createX402Middleware();

      expect(middleware).toBeDefined();
    });

    it('should create legacy middleware that returns JSON when X402_USE_LEGACY=true', async () => {
      process.env.X402_USE_LEGACY = '1';

      const { createX402Middleware } = await import('../backend/x402/server');
      const middleware = createX402Middleware();

      expect(middleware).toBeDefined();
    });
  });

  describe('Flag isolation', () => {
    it('should respect X402_USE_LEGACY flag in config', async () => {
      const { EnvSchema } = await realConfig();

      expect(EnvSchema.shape.X402_USE_LEGACY.parse('0')).toBe(false);
      expect(EnvSchema.shape.X402_USE_LEGACY.parse('1')).toBe(true);
    });

    it('should have X402_USE_LEGACY default to false', async () => {
      delete process.env.X402_USE_LEGACY;

      const { config } = await import('../backend/config');
      expect(config.X402_USE_LEGACY).toBe(false);
    });
  });

  describe('Facilitator URL validation', () => {
    it('should validate X402_FACILITATOR_URL as valid URL', async () => {
      const { EnvSchema } = await realConfig();

      expect(EnvSchema.shape.X402_FACILITATOR_URL.safeParse('not-a-url').success).toBe(false);
    });

    it('should accept valid URL for X402_FACILITATOR_URL', async () => {
      process.env.X402_FACILITATOR_URL = 'https://facilitator.example.com';

      const { config } = await import('../backend/config');
      expect(config.X402_FACILITATOR_URL).toBe('https://facilitator.example.com');
    });

    it('should allow X402_FACILITATOR_URL to be optional', async () => {
      const { EnvSchema } = await realConfig();

      expect(EnvSchema.shape.X402_FACILITATOR_URL.parse(undefined)).toBeUndefined();
    });
  });

  describe('Integration with agent.ts dispatch', () => {
    it('routes agent.fetchPaid() through the v2 client', async () => {
      const clientFetch = vi
        .spyOn(X402FetchClient.prototype, 'fetch')
        .mockResolvedValue({ response: new Response('{}', { status: 200 }) });

      const { PayFiAgent } = await import('../backend/agent');
      const agent = new PayFiAgent();
      const { response } = await agent.fetchPaid(PAID_URL);
      agent.destroy();

      expect(response.status).toBe(200);
      expect(clientFetch).toHaveBeenCalledWith(PAID_URL, undefined);
    });
  });
});
