/**
 * backend/config.ts
 *
 * Production-grade, schema-validated configuration layer.
 *
 * Security guarantees:
 *   - AGENT_SECRET_KEY is NEVER included in error messages or logs.
 *   - AGENT_PUBLIC_KEY is derived from the secret key at startup;
 *     only the public key is exposed on the config object.
 *   - Invalid env causes an informative error + process.exit(1)
 *     before any network or tool code runs.
 *
 * Usage:
 *   import { config } from "./config";
 *   config.HORIZON_URL          // validated URL string
 *   config.AGENT_PUBLIC_KEY     // derived G-address, safe to log
 *   config.agentKeypair()       // call-site requests the Keypair explicitly
 */

import { z } from 'zod';
import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { Asset, Keypair, Networks } from '@stellar/stellar-sdk';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { isValidStellarContractId, isValidStellarPublicKey } from './utils/stellarSchemas';
import { toStroops, tryToStroops } from './utils/amount';

export const MAINNET_SPENDING_CAP = 10_000;

/**
 * Validates a comma-separated asset allowlist: each entry must be "XLM" or
 * "CODE:ISSUER" (code <= 12 chars, issuer a valid Ed25519 public key).
 * Shared by X402_ALLOWED_ASSETS and ESCROW_ALLOWED_TOKENS.
 */
function isValidAssetAllowlist(val: string): boolean {
  return val
    .split(',')
    .map((entry) => entry.trim())
    .every((entry) => {
      if (entry === 'XLM') return true;
      const [code, issuer, ...extra] = entry.split(':');
      return (
        extra.length === 0 &&
        !!code &&
        code.length <= 12 &&
        !!issuer &&
        isValidStellarPublicKey(issuer)
      );
    });
}

// Load .env file (no-op when running in CI / production with real env vars)
dotenv.config();

// ─── Custom Zod refinements ───────────────────────────────────────────────────

/**
 * Validates a Stellar secret key (S…, 56 chars, base32).
 * The key itself is NEVER surfaced in Zod error messages —
 * we only report structural problems.
 */
const StellarSecretKeySchema = z.string().refine(
  (val) => {
    try {
      Keypair.fromSecret(val);
      return true;
    } catch {
      return false;
    }
  },
  // Generic message — does not echo the value
  {
    message:
      'AGENT_SECRET_KEY is not a valid Stellar secret key (must start with S and be 56 chars)',
  }
);

/**
 * Stellar public key — 56-char G-address.
 * Optional: when absent it is derived from AGENT_SECRET_KEY.
 */
const StellarPublicKeySchema = z
  .string()
  .length(56, 'Must be a 56-character Stellar public key (G…)')
  .refine((val) => val.startsWith('G'), { message: 'Public key must start with G' })
  .refine((val) => isValidStellarPublicKey(val), {
    message: 'AGENT_PUBLIC_KEY must be a valid Stellar public key',
  })
  .optional();

/**
 * Spending limit: a positive decimal with up to 7 decimal places.
 * "0" is not permitted — agents must have a non-zero spending cap.
 */
const SpendingLimitSchema = z
  .string()
  .regex(
    /^[1-9]\d*(\.\d{1,7})?$/,
    "AGENT_SPENDING_LIMIT must be a positive decimal (e.g. '100' or '50.0000000')"
  )
  .default('100');

// ─── Raw environment schema ───────────────────────────────────────────────────

export const EnvSchema = z.object({
  // Network
  STELLAR_NETWORK: z
    .enum(['testnet', 'mainnet', 'futurenet'], {
      error: () => 'STELLAR_NETWORK must be one of: testnet | mainnet | futurenet',
    })
    .default('testnet'),

  // RPC endpoints
  HORIZON_URL: z
    .string({
      error: (issue) => (issue.input === undefined ? 'HORIZON_URL is required' : undefined),
    })
    .url('HORIZON_URL must be a valid URL (e.g. https://horizon-testnet.stellar.org)'),

  SOROBAN_RPC_URL: z
    .string({
      error: (issue) => (issue.input === undefined ? 'SOROBAN_RPC_URL is required' : undefined),
    })
    .url('SOROBAN_RPC_URL must be a valid URL (e.g. https://soroban-testnet.stellar.org)'),

  // Agent identity
  AGENT_SECRET_KEY: StellarSecretKeySchema,
  AGENT_PUBLIC_KEY: StellarPublicKeySchema,
  AGENT_SECRET_KEY_ARN: z.string().optional(),

  // Signing backend — `local` signs with the in-memory agent keypair, `vault`
  // delegates to a HashiCorp Vault transit ed25519 key (VAULT_TOKEN is
  // validated here and exposed only through getVaultToken()).
  SIGNER_BACKEND: z
    .enum(['local', 'vault'], {
      error: () => 'SIGNER_BACKEND must be one of: local | vault',
    })
    .default('local'),
  VAULT_ADDR: z.string().url('VAULT_ADDR must be a valid URL').optional(),
  VAULT_TRANSIT_MOUNT: z.string().min(1).default('transit'),
  VAULT_TRANSIT_KEY: z.string().min(1).optional(),
  // Secret used to authenticate to Vault; captured privately and never exposed on AgentConfig.
  VAULT_TOKEN: z.string().min(1).optional(),

  // x402 / PayFi asset
  X402_ASSET_CODE: z.string().min(1).max(12).default('USDC'),
  X402_ASSET_ISSUER: z
    .string({
      error: (issue) => (issue.input === undefined ? 'X402_ASSET_ISSUER is required' : undefined),
    })
    .length(56, 'X402_ASSET_ISSUER must be a 56-character Stellar address')
    .refine((val) => val.startsWith('G'), {
      message: 'X402_ASSET_ISSUER must start with G',
    })
    .refine((val) => isValidStellarPublicKey(val), {
      message: 'X402_ASSET_ISSUER is not a valid Ed25519 public key',
    }),
  // SEP-41 contract (C…) of the x402 asset — its Stellar Asset Contract (SAC).
  // Derived from X402_ASSET_CODE + X402_ASSET_ISSUER when unset (#776).
  AGENT_POLICY_ACCOUNT: z
    .string()
    .refine((val) => isValidStellarContractId(val), {
      message: 'AGENT_POLICY_ACCOUNT must be a valid contract address (C…)',
    })
    .optional(),
  X402_ASSET_CONTRACT: z
    .string()
    .refine((val) => isValidStellarContractId(val), {
      message: 'X402_ASSET_CONTRACT must be a valid contract address (C…)',
    })
    .optional(),
  ALLOWED_X402_ORIGINS: z.string().optional(),
  // Maximum amount a single x402 challenge may request. Unset = no per-challenge cap.
  X402_MAX_PRICE: z
    .string()
    .regex(
      /^(?!0+(\.0+)?$)\d+(\.\d{1,7})?$/,
      "X402_MAX_PRICE must be a positive decimal (e.g. '5' or '0.5000000')"
    )
    .optional(),
  // Comma-separated assets x402 challenges may request: "XLM" or "CODE:ISSUER".
  // Unset = any asset, but a known code must still use its configured issuer.
  X402_ALLOWED_ASSETS: z
    .string()
    .refine(isValidAssetAllowlist, {
      message: 'X402_ALLOWED_ASSETS must be a comma-separated list of "XLM" or "CODE:ISSUER"',
    })
    .optional(),

  // Comma-separated allowlist of tokens the backend will accept as an escrow
  // `token` argument, each "XLM" or "CODE:ISSUER" (#989). Unset = only native
  // XLM and the default x402 asset (X402_ASSET_CODE/ISSUER) are accepted — the
  // backend never passes an arbitrary, unverified token contract to the escrow
  // contract's initialize()/initialize_with_fee(), since a malicious token
  // can lie about transfer()/balances or re-enter.
  ESCROW_ALLOWED_TOKENS: z
    .string()
    .refine(isValidAssetAllowlist, {
      message: 'ESCROW_ALLOWED_TOKENS must be a comma-separated list of "XLM" or "CODE:ISSUER"',
    })
    .optional(),

  // Spending cap
  AGENT_SPENDING_LIMIT: SpendingLimitSchema,

  // Human-in-the-loop approval: value-moving tasks above this amount are held
  // as pending_approval until approved or denied via POST /approvals/:id.
  // Unset = no approval step. Acts as the fallback for any asset not listed
  // in APPROVAL_THRESHOLDS (#953).
  APPROVAL_THRESHOLD: z
    .string()
    .regex(
      /^(?!0+(\.0+)?$)\d+(\.\d{1,7})?$/,
      "APPROVAL_THRESHOLD must be a positive decimal (e.g. '500' or '50.0000000')"
    )
    .optional(),
  /**
   * Per-asset approval thresholds (#953), so e.g. 100 XLM and 100 of a
   * high-value asset aren't held to the same bar. Same shape as
   * SPENDING_LIMITS: comma-separated 'CODE:LIMIT' (XLM/native) or
   * 'CODE:ISSUER:LIMIT' (credit assets), e.g. 'XLM:5000,USDC:GA5Z…:500'.
   * An asset not listed here falls back to APPROVAL_THRESHOLD.
   */
  APPROVAL_THRESHOLDS: z
    .string()
    .optional()
    .refine(
      (val) => {
        if (!val) return true;
        const limitRe = /^[1-9]\d*(\.\d{1,7})?$/;
        const g56Re = /^G[A-Z2-7]{55}$/;
        for (const entry of val.split(',')) {
          const parts = entry.trim().split(':');
          if (parts.length === 2) {
            const [, limit] = parts as [string, string];
            if (!limitRe.test(limit)) return false;
          } else if (parts.length === 3) {
            const [, issuer, limit] = parts as [string, string, string];
            if (!g56Re.test(issuer)) return false;
            if (!limitRe.test(limit)) return false;
          } else {
            return false;
          }
        }
        return true;
      },
      {
        message:
          'APPROVAL_THRESHOLDS must be a comma-separated list of ' +
          "'ASSET_CODE:THRESHOLD' (for XLM/native) or " +
          "'ASSET_CODE:ISSUER:THRESHOLD' (for credit assets), " +
          "e.g. 'XLM:5000,USDC:GA5Z…:500'",
      }
    ),
  // How long a pending approval waits for a decision before it expires.
  APPROVAL_TTL_MS: z.coerce.number().int().min(1_000).default(3_600_000),

  // How often the MPP channel sweeper marks timed-out channels Expired and
  // releases their spending reservations. Defaults to 60,000 (1 minute).
  MPP_SESSION_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),

  // Counterparty policy for value-moving tasks: `allowlist` permits only the
  // listed destinations, `denylist` blocks them, `open` (default) permits any.
  PAYMENT_DESTINATION_POLICY: z
    .enum(['allowlist', 'denylist', 'open'], {
      error: () => 'PAYMENT_DESTINATION_POLICY must be one of: allowlist | denylist | open',
    })
    .default('open'),
  // Comma-separated G-addresses and/or federation names (name*domain).
  PAYMENT_DESTINATIONS: z.string().optional(),
  // File with one G-address or federation name per line; # starts a comment.
  PAYMENT_DESTINATIONS_FILE: z.string().min(1).optional(),

  // Persistence
  DB_PATH: z.string().default('./agent.db'),
  // Shared Postgres store for multi-instance deployments (#822).
  STORAGE_BACKEND: z.enum(['sqlite', 'postgres']).default('sqlite'),
  DATABASE_URL: z.string().min(1).optional(),

  // Data retention (#963): how long to keep rows in tables that otherwise
  // grow without bound. The hash-chained audit log is never pruned.
  RETENTION_DAYS_RESULTS: z.coerce.number().int().positive().default(30),
  RETENTION_DAYS_APPROVALS: z.coerce.number().int().positive().default(30),
  RETENTION_DAYS_TRIGGER_EVENTS: z.coerce.number().int().positive().default(30),
  // How often the retention job sweeps every table above (default: daily).
  RETENTION_JOB_INTERVAL_MS: z.coerce.number().int().min(1_000).default(86_400_000),

  // Logging
  NODE_ENV: z.string().min(1).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // OpenTelemetry
  OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_REDACT_TX_HASH: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  // Spending window for rate/cap computation
  SPENDING_WINDOW_MS: z.coerce.number().int().min(100).default(86_400_000),

  // Retry behaviour
  // Exponential back-off: delay = RETRY_DELAY_MS * 2^(attempt-1), capped at 30 000 ms,
  // plus ±20% random jitter. Example — MAX_RETRIES=3, RETRY_DELAY_MS=1500 →
  // delays [1500, 3000, 6000] ms (before jitter), not linear [1500, 3000, 4500].
  MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(3),

  RETRY_DELAY_MS: z.coerce.number().int().min(100).default(1500),

  // How long a cached Horizon account stays fresh. Sequence numbers and
  // balances change on every transaction the account takes part in, so this is
  // deliberately short: it exists to collapse bursts of reads, not to avoid
  // round trips generally.
  ACCOUNT_CACHE_TTL_MS: z.coerce.number().int().min(0).default(30_000),

  // Per-call RPC timeout in milliseconds.
  // Defaults to RETRY_DELAY_MS * MAX_RETRIES * 2, computed post-parse.
  RPC_TIMEOUT_MS: z.coerce.number().int().min(100).optional(),

  // TOML cache TTL in milliseconds (default: 5 minutes = 300,000 ms)
  TOML_CACHE_TTL_MS: z.coerce.number().int().min(0).default(300_000),

  // Rate limiting
  MAX_X402_PAYMENTS_PER_MINUTE: z.coerce.number().int().min(1).default(10),

  // How long a used x402 nonce is retained for replay protection before it
  // becomes eligible for eviction. Defaults to 24h, comfortably above the
  // longest plausible challenge lifetime.
  X402_NONCE_TTL_MS: z.coerce
    .number()
    .int()
    .min(1)
    .default(24 * 60 * 60 * 1_000),

  // Maximum number of tasks allowed to execute concurrently in agent.run().
  // Excess tasks are queued (bounded by QUEUE_CAPACITY) or rejected.
  MAX_CONCURRENT_TASKS: z.coerce.number().int().min(1).default(10),

  // Bounded FIFO queue for tasks submitted while at MAX_CONCURRENT_TASKS.
  // 0 (default) disables queuing — excess tasks are rejected immediately.
  QUEUE_CAPACITY: z.coerce.number().int().min(0).default(0),

  MAX_SOROBAN_FEE_STROOPS: z.coerce.number().int().min(100).default(1_000_000),

  // Ceiling on the per-operation inclusion fee chosen by estimateFee() (#790),
  // so surge pricing can never push a classic transaction's fee without bound.
  MAX_FEE_STROOPS: z.coerce.number().int().min(100).default(100_000),

  // Health check HTTP server
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /**
   * Payments above this amount (in the agent's asset) are held for human
   * approval before execution rather than submitted immediately.
   * "0" disables the threshold (all tasks execute immediately).
   * Defaults to "0" (threshold disabled).
   */
  APPROVAL_THRESHOLD: z
    .string()
    .regex(
      /^\d+(\.\d{1,7})?$/,
      "APPROVAL_THRESHOLD must be a non-negative decimal (e.g. '50' or '0')"
    )
    .default("0"),
  // Nano node RPC endpoint used by NanoPaymentTool.
  NANO_RPC_URL: z.string().url().default('http://127.0.0.1:7076'),
  // Operator-controlled exception for bypassing Nano recipient prechecks.
  NANO_ALLOW_SKIP_PRECHECK: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Nano signing seed (#975). Loaded from env or AWS Secrets Manager, never
  // from a task payload. Required at startup when NANO_ENABLED=true.
  NANO_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  NANO_SEED: z
    .string()
    .regex(/^[0-9A-Fa-f]{64}$/, 'NANO_SEED must be a 64-character hex seed')
    .optional(),
  NANO_SEED_ARN: z.string().optional(),

  // MCP server
  MCP_ALLOW_PAYMENTS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  // Bearer token required by all MCP HTTP routes. When MCP_ALLOW_PAYMENTS is
  // true the server refuses to start without this token (see issue #911).
  MCP_API_TOKEN: z.string().min(1).optional(),
  // Host/IP the MCP HTTP server binds to. Defaults to 127.0.0.1 (loopback
  // only). Set to 0.0.0.0 only when the MCP server must be reachable across
  // the network and you have external auth/firewall in place.
  MCP_HOST: z.string().default('127.0.0.1'),
  // Maximum JSON body size accepted by the MCP HTTP endpoint (in bytes).
  // Requests that exceed this limit are rejected with 413. Defaults to 1 MiB.
  MCP_MAX_BODY_BYTES: z.coerce.number().int().min(1024).default(1_048_576),

  // Triggers
  TRIGGER_ALLOW_PAYMENTS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // How long to retain deduplication event records before pruning.
  TRIGGER_EVENTS_RETENTION_MS: z.coerce
    .number()
    .int()
    .min(60_000) // minimum 1 minute
    .default(7 * 24 * 60 * 60 * 1000), // 7 days

  // Contract event listener polling interval in milliseconds.
  CONTRACT_EVENT_POLL_MS: z.coerce.number().int().min(100).optional(),

  // Webhook notifications
  WEBHOOK_URL: z.string().url().optional(),
  WEBHOOK_SECRET: z.string().min(1).optional(),

  // Alert delivery endpoints and threshold controls.
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  ALERT_SLACK_WEBHOOK_URL: z.string().url().optional(),
  ALERT_DISCORD_WEBHOOK_URL: z.string().url().optional(),
  ALERT_SPENDING_THRESHOLDS: z
    .string()
    .default('0.8,1')
    .refine(
      (value) =>
        value.split(',').every((entry) => {
          const threshold = Number(entry.trim());
          return Number.isFinite(threshold) && threshold > 0;
        }),
      'ALERT_SPENDING_THRESHOLDS must be comma-separated positive numbers'
    )
    .transform((value) =>
      [...new Set(value.split(',').map((entry) => Number(entry.trim())))].sort((a, b) => a - b)
    ),
  ALERT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
  ALERT_FAILURE_WINDOW_MS: z.coerce.number().int().min(1).default(300_000),

  // Optional fallback API key for OpenZeppelin facilitator integrations.
  OZ_API_KEY: z.string().min(1).optional(),

  /**
   * Per-asset spending limits encoded as a comma-separated string.
   * Format: "ASSET_CODE:LIMIT[,ASSET_CODE:ISSUER:LIMIT,...]"
   *
   * Examples:
   *   XLM:1000                                           – native XLM only
   *   XLM:1000,USDC:GA5Z…:500                            – XLM + USDC
   *   XLM:1000,USDC:GA5Z…:500,ALLOW_UNKNOWN:false        – deny unknown assets
   *
   * Rules:
   *   - "XLM" (no issuer) refers to the native Stellar asset.
   *   - Custom assets must include the 56-char G-address issuer.
   *   - If omitted entirely, the global AGENT_SPENDING_LIMIT applies to every asset.
   *   - Unknown assets (not listed) are DENIED by default unless
   *     SPENDING_LIMITS_ALLOW_UNKNOWN=true is also set.
   */
  SPENDING_LIMITS: z
    .string()
    .optional()
    .refine(
      (val) => {
        if (!val) return true;
        // Validate each entry is either XLM:<limit> or CODE:ISSUER:<limit>
        const entries = val.split(',');
        const limitRe = /^[1-9]\d*(\.\d{1,7})?$/;
        const g56Re = /^G[A-Z2-7]{55}$/;
        for (const entry of entries) {
          const parts = entry.trim().split(':');
          if (parts.length === 2) {
            // XLM:<limit> or CODE:<limit>
            const [, limit] = parts as [string, string];
            if (!limitRe.test(limit)) return false;
          } else if (parts.length === 3) {
            // CODE:ISSUER:<limit>
            const [, issuer, limit] = parts as [string, string, string];
            if (!g56Re.test(issuer)) return false;
            if (!limitRe.test(limit)) return false;
          } else {
            return false;
          }
        }
        return true;
      },
      {
        message:
          'SPENDING_LIMITS must be a comma-separated list of ' +
          "'ASSET_CODE:LIMIT' (for XLM/native) or " +
          "'ASSET_CODE:ISSUER:LIMIT' (for credit assets), " +
          "e.g. 'XLM:1000,USDC:GA5Z…:500'",
      }
    ),

  /** When true, assets not listed in SPENDING_LIMITS are allowed through (default: denied). */
  SPENDING_LIMITS_ALLOW_UNKNOWN: z
    .string()
    .transform((v) => v.toLowerCase() === 'true')
    .prefault('false'),
  // Bearer token for the HTTP API (/status, /spending, /metrics, /approvals,
  // /admin/*). Falls back to WEBHOOK_SECRET when unset — deprecated.
  ADMIN_API_TOKEN: z.string().min(1).optional(),
  // Kill switch: start with value-moving tasks halted (see backend/kill_switch.ts).
  PAUSED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // How often each instance re-reads the paused state from the shared storage
  // backend (#960), so a pause/resume on one instance reaches the others
  // within this bound. Only matters with multiple instances sharing one store.
  KILL_SWITCH_SYNC_INTERVAL_MS: z.coerce.number().int().min(100).default(2_000),

  // Backward-compat: sign the body only (no timestamp). Deprecated — removed next release.
  WEBHOOK_LEGACY_SIGNATURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // x402 v2 interoperability
  X402_USE_LEGACY: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
  X402_FACILITATOR_URL: z.string().url().optional(),
  /** Optional API key for the x402 facilitator (Bearer token or header value). */
  X402_FACILITATOR_API_KEY: z.string().min(1).optional(),

  // ─── LLM Provider Configuration ─────────────────────────────────────────
  // AI layer: LLM provider for the planner (optional - disabled if not set)

  // LLM provider: openai, anthropic, or mock (for testing)
  LLM_PROVIDER: z.enum(['openai', 'anthropic', 'mock']).default('mock').optional(),

  // OpenAI-compatible planner endpoint.
  LLM_ENDPOINT: z.string().url().optional(),

  // Model identifier (e.g., gpt-4o, claude-3-sonnet-20240229)
  LLM_MODEL: z.string().min(1).optional(),

  // API key for the LLM provider (secret - never logged)
  LLM_API_KEY: z.string().min(1).optional(),

  // Base URL for OpenAI-compatible APIs (useful for local models, OpenAI proxies)
  LLM_BASE_URL: z.string().url().optional(),

  // Timeout for LLM requests in milliseconds
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(60000),

  // Maximum tokens per request
  LLM_MAX_TOKENS: z.coerce.number().int().min(1).max(128000).default(4096),

  // Temperature for LLM sampling (0-2)
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),

  // AI budget limits.
  LLM_MAX_TOKENS_PER_REQUEST: z.coerce.number().int().min(1).default(8_000),
  LLM_MAX_TOKENS_PER_STEP: z.coerce.number().int().min(1).default(16_000),
  LLM_MAX_TOOL_CALL_ITERATIONS: z.coerce.number().int().min(1).default(25),
  LLM_MAX_TOKENS_PER_DAY: z.coerce.number().int().min(1).default(1_000_000),

  // Bounded in-memory AI conversation store.
  SESSION_TTL_MS: z.coerce
    .number()
    .int()
    .min(1)
    .default(30 * 60 * 1_000),
  SESSION_MAX_MESSAGES: z.coerce.number().int().min(1).default(50),
  SESSION_MAX_SESSIONS: z.coerce.number().int().min(1).default(500),
});

type RawEnv = z.infer<typeof EnvSchema>;
const ApiTokenSchema = EnvSchema.pick({ ADMIN_API_TOKEN: true, WEBHOOK_SECRET: true });

// ─── Derived / enriched config type ──────────────────────────────────────────

export interface AgentConfig {
  /**
   * The Stellar network to target.
   * Enforced by EnvSchema to be one of: "testnet" | "mainnet" | "futurenet".
   * Defaults to "testnet".
   */
  readonly STELLAR_NETWORK: 'testnet' | 'mainnet' | 'futurenet';

  /**
   * The Stellar Horizon server URL.
   * Validated by EnvSchema to be a valid URL string (e.g. "https://horizon-testnet.stellar.org").
   * Required.
   */
  readonly HORIZON_URL: string;

  /**
   * The Soroban RPC server URL.
   * Validated by EnvSchema to be a valid URL string (e.g. "https://soroban-testnet.stellar.org").
   * Required.
   */
  readonly SOROBAN_RPC_URL: string;

  /**
   * Path to the SQLite database file used for audit persistence.
   * Defaults to "./agent.db". Use ":memory:" for in-process tests.
   */
  readonly DB_PATH: string;

  /**
   * Where persistent state lives. "sqlite" (default) uses DB_PATH and suits a
   * single instance; "postgres" uses DATABASE_URL and is shared by every
   * instance of a horizontally scaled deployment.
   */
  readonly STORAGE_BACKEND: 'sqlite' | 'postgres';

  /**
   * Postgres connection string. Required when STORAGE_BACKEND is "postgres".
   * Contains credentials — never logged.
   */
  readonly DATABASE_URL?: string | undefined;

  /** Days to keep persisted agent_results rows before the retention job deletes them (#963). */
  readonly RETENTION_DAYS_RESULTS: number;
  /** Days to keep decided/expired pending_approvals rows before the retention job deletes them (#963). */
  readonly RETENTION_DAYS_APPROVALS: number;
  /** Days to keep trigger_events dedupe rows before the retention job deletes them (#963). */
  readonly RETENTION_DAYS_TRIGGER_EVENTS: number;
  /** How often the retention job runs, in milliseconds. Defaults to once a day. */
  readonly RETENTION_JOB_INTERVAL_MS: number;

  /**
   * The asset code for the x402 / PayFi asset.
   * Validated by EnvSchema to be a string between 1 and 12 characters.
   * Defaults to "USDC".
   */
  /** Optional Soroban custom account used for policy-protected spending. */
  readonly AGENT_POLICY_ACCOUNT?: string | undefined;
  readonly X402_ASSET_CODE: string;

  /**
   * The 56-character G-address of the issuer for the x402 / PayFi asset.
   * Validated by EnvSchema to be a 56-character Stellar public key starting with G.
   * Required.
   */
  readonly X402_ASSET_ISSUER: string;

  /**
   * The SEP-41 contract address (C…) of the x402 asset's Stellar Asset Contract.
   * Classic operations (trustlines, payments) use X402_ASSET_ISSUER (G…); Soroban
   * and x402 payment requirements use this contract address. Derived from
   * X402_ASSET_CODE + X402_ASSET_ISSUER and the network passphrase when unset; an
   * explicit value must match that derivation.
   */
  readonly X402_ASSET_CONTRACT: string;

  /**
   * The spending limit for the agent.
   * Validated by EnvSchema to be a positive decimal with up to 7 decimal places.
   * "0" is not permitted. Defaults to "100".
   */
  readonly AGENT_SPENDING_LIMIT: string;

  /**
   * Amount above which a value-moving task is held as `pending_approval` until
   * an operator approves or denies it. Optional — when unset no task is held.
   * Used as the fallback for any asset not listed in APPROVAL_THRESHOLDS_MAP.
   */
  readonly APPROVAL_THRESHOLD?: string | undefined;

  /**
   * Parsed form of APPROVAL_THRESHOLDS (#953): asset key ("XLM" or
   * "CODE:ISSUER", matching backend/spending_tracker.ts's assetKey()) to its
   * threshold. Empty when APPROVAL_THRESHOLDS is unset.
   */
  readonly APPROVAL_THRESHOLDS_MAP: ReadonlyMap<string, string>;

  /**
   * How long (ms) a pending approval waits for a decision before it expires and
   * its spending reservation is released. Defaults to 3,600,000 (1 hour).
   */
  readonly APPROVAL_TTL_MS: number;

  /**
   * MPP channel sweep interval in milliseconds. The sweeper marks channels
   * past their `timeoutAt` as `Expired` and releases their reservations.
   * Defaults to 60,000 (1 minute).
   */
  readonly MPP_SESSION_SWEEP_INTERVAL_MS: number;

  /**
   * Counterparty policy enforced for every value-moving task.
   * "allowlist" permits only PAYMENT_DESTINATIONS, "denylist" rejects them and
   * "open" (default) permits any destination.
   */
  readonly PAYMENT_DESTINATION_POLICY: 'allowlist' | 'denylist' | 'open';

  /**
   * G-addresses and federation names the destination policy applies to, merged
   * from PAYMENT_DESTINATIONS and PAYMENT_DESTINATIONS_FILE.
   */
  readonly PAYMENT_DESTINATIONS: readonly string[];

  /**
   * The maximum number of retry attempts for transient network/RPC calls.
   * Validated by EnvSchema to be an integer between 1 and 10.
   * Defaults to 3.
   */
  readonly MAX_RETRIES: number;

  /**
   * The base delay in milliseconds for exponential back-off retries.
   * Validated by EnvSchema to be an integer of at least 100.
   * Defaults to 1500.
   */
  readonly RETRY_DELAY_MS: number;

  /**
   * Derived 56-character Stellar public key (G-address) for the agent.
   * Derived automatically from AGENT_SECRET_KEY, safe to log.
   */
  readonly AGENT_PUBLIC_KEY: string;

  /**
   * Returns the agent Keypair on demand.
   * Deliberately a function rather than a property so that callers are explicit
   * about accessing the secret key, preventing accidental printing/leakage.
   * The secret key is held securely in closure and never placed on the public config object.
   *
   * @example
   * ```typescript
   * // Safely sign a transaction using the derived keypair
   * const tx = new TransactionBuilder(account, ...)
   *   // ... add operations ...
   *   .build();
   * tx.sign(config.agentKeypair());
   * ```
   *
   * @example
   * ```typescript
   * // Tools receive a Signer, never the secret key
   * const tool = new StellarPaymentTool(new KeypairSigner(config.agentKeypair()));
   * ```
   */
  readonly agentKeypair: () => Keypair;
  readonly ALLOWED_X402_ORIGINS?: string | undefined;
  /**
   * Maximum amount a single x402 challenge may request. Challenges above it are rejected.
   * Optional — when unset only AGENT_SPENDING_LIMIT applies.
   */
  readonly X402_MAX_PRICE?: string | undefined;
  /**
   * Comma-separated allow-list of assets an x402 challenge may request, each "XLM" or
   * "CODE:ISSUER". Optional — when unset any asset is accepted, but a challenge for a
   * known code (X402_ASSET_CODE) must use its configured issuer.
   */
  readonly X402_ALLOWED_ASSETS?: string | undefined;

  /**
   * Comma-separated allowlist of tokens the backend will accept as an escrow
   * `token` argument, each "XLM" or "CODE:ISSUER". Optional — when unset,
   * only native XLM and the default x402 asset (X402_ASSET_CODE/ISSUER) are
   * accepted (#989).
   */
  readonly ESCROW_ALLOWED_TOKENS?: string | undefined;
  readonly AGENT_SECRET_KEY_ARN?: string | undefined;

  /**
   * When true, use the legacy x402 payment flow (SHA-256(nonce)[0:28] memo).
   * When false (default), use x402 v2 with official @x402/stellar package and SEP-41.
   */
  readonly X402_USE_LEGACY: boolean;
  /**
   * Optional facilitator URL for x402 v2 verification/settlement.
   * When set, the buyer and seller flows use this facilitator.
   */
  readonly X402_FACILITATOR_URL?: string | undefined;
  /**
   * Optional API key for the x402 facilitator.
   * Sent as `Authorization: Bearer <key>` on every facilitator request.
   */
  readonly X402_FACILITATOR_API_KEY?: string | undefined;

  /**
   * Which signing backend `createSigner()` returns.
   * "local" (default) signs with agentKeypair(); "vault" signs with a
   * HashiCorp Vault transit key so the signing key never leaves Vault.
   */
  readonly SIGNER_BACKEND: 'local' | 'vault';
  /** Vault server address. Required when SIGNER_BACKEND is "vault". */
  readonly VAULT_ADDR?: string | undefined;
  /** Mount path of the Vault transit secrets engine. Defaults to "transit". */
  readonly VAULT_TRANSIT_MOUNT: string;
  /** Name of the Vault transit ed25519 key. Required when SIGNER_BACKEND is "vault". */
  readonly VAULT_TRANSIT_KEY?: string | undefined;

  /**
   * OpenTelemetry collector endpoint.
   * Optional — when set, the agent exports traces/spans to this OTLP-compatible endpoint.
   * Validated by EnvSchema to be a valid URL string.
   */
  readonly OTLP_ENDPOINT?: string | undefined;
  /** Whether transaction hashes are omitted from exported traces. Defaults to false. */
  readonly OTEL_REDACT_TX_HASH: boolean;

  /** Runtime environment name used to select logger output. Defaults to development. */
  readonly NODE_ENV: string;
  /** Pino verbosity. Defaults to info. */
  readonly LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
  /** Alert webhook destinations; each is optional and URL-validated. */
  readonly ALERT_WEBHOOK_URL?: string | undefined;
  readonly ALERT_SLACK_WEBHOOK_URL?: string | undefined;
  readonly ALERT_DISCORD_WEBHOOK_URL?: string | undefined;
  /** Spending-limit fractions that trigger alerts. Defaults to [0.8, 1]. */
  readonly ALERT_SPENDING_THRESHOLDS: readonly number[];
  /** Consecutive task failures before an alert is raised. Defaults to 5. */
  readonly ALERT_FAILURE_THRESHOLD: number;
  /** Failure alert rolling window in milliseconds. Defaults to 300,000. */
  readonly ALERT_FAILURE_WINDOW_MS: number;

  /**
   * Spending window in milliseconds for rate/cap computation.
   * Defines the time window over which spending is tracked and enforced.
   * Validated by EnvSchema to be a positive integer.
   * Defaults to 86,400,000 (24 hours).
   */
  readonly SPENDING_WINDOW_MS: number;
  /**
   * Time-to-live, in milliseconds, for a cached Horizon account record.
   * Defaults to 30,000. Set to 0 to disable caching entirely.
   */
  readonly ACCOUNT_CACHE_TTL_MS: number;
  /**
   * Per-call RPC timeout in milliseconds.
   * Defaults to RETRY_DELAY_MS * MAX_RETRIES * 2 when RPC_TIMEOUT_MS env var is absent.
   */
  readonly RPC_TIMEOUT_MS: number;

  /**
   * Cache TTL in milliseconds for Stellar TOML requests.
   * Defaults to 300,000 (5 minutes).
   */
  readonly TOML_CACHE_TTL_MS: number;

  /**
   * Maximum number of x402 payments allowed per 60-second sliding window.
   * Defaults to 10. Prevents rapid-fire calls from exhausting the agent balance.
   */
  readonly MAX_X402_PAYMENTS_PER_MINUTE: number;

  /**
   * How long (ms) a used x402 nonce is kept for replay protection before it can
   * be evicted. Defaults to 86_400_000 (24 hours). A used nonce only needs to
   * outlive its challenge, so anything past this window is dead weight that
   * would otherwise grow the store without bound.
   */
  readonly X402_NONCE_TTL_MS: number;

  /**
   * Maximum Soroban transaction fee in stroops (1 stroop = 0.0000001 XLM).
   * Defaults to 1_000_000 (0.1 XLM). Prevents resource-inflated fee attacks.
   */
  readonly MAX_SOROBAN_FEE_STROOPS: number;

  /**
   * Parsed per-asset spending limits.
   * Key: canonical asset key — "XLM" for native, or "CODE:ISSUER" for credit assets.
   * Value: the limit as a string (e.g. "500.0000000").
   * Empty map means only the global AGENT_SPENDING_LIMIT is used.
   */
  readonly SPENDING_LIMITS_MAP: ReadonlyMap<string, string>;

  /**
   * When true, assets not listed in SPENDING_LIMITS_MAP are allowed through.
   * When false (default), unlisted assets are denied.
   */
  readonly SPENDING_LIMITS_ALLOW_UNKNOWN: boolean;

  /**
   * Maximum per-operation inclusion fee in stroops that estimateFee() will
   * bid, including on a fee-bump surge retry. Defaults to 100_000 (0.01 XLM).
   */
  readonly MAX_FEE_STROOPS: number;

  /**
   * Maximum number of tasks allowed to execute concurrently in agent.run().
   * Additional tasks submitted while this many are in flight are rejected.
   * Defaults to 10.
   */
  readonly MAX_CONCURRENT_TASKS: number;
  /**
   * Bounded FIFO queue capacity for tasks submitted while at MAX_CONCURRENT_TASKS.
   * Defaults to 0 (no queuing — excess tasks are rejected immediately).
   */
  readonly QUEUE_CAPACITY: number;
  /**
   * When true, value-moving tools are exposed via MCP. Defaults to false.
   */
  readonly MCP_ALLOW_PAYMENTS: boolean;
  /**
   * MCP transport: "stdio" or "http". Defaults to "stdio".
   */
  readonly MCP_TRANSPORT: 'stdio' | 'http';
  /**
   * Port for MCP HTTP server. Defaults to 3001.
   */
  readonly MCP_PORT: number;
  /**
   * Bearer token required on all MCP HTTP routes. When MCP_ALLOW_PAYMENTS is
   * true the server refuses to start if this is unset. See issue #911.
   */
  readonly MCP_API_TOKEN?: string | undefined;
  /**
   * Host the MCP HTTP server binds to. Defaults to "127.0.0.1" (loopback).
   * Set to "0.0.0.0" only if external auth/firewall is in place.
   */
  readonly MCP_HOST: string;
  /**
   * Maximum JSON body size (bytes) accepted by the MCP HTTP endpoint.
   * Requests exceeding this limit receive a 413 response. Defaults to 1 MiB.
   */
  readonly MCP_MAX_BODY_BYTES: number;

  /**
   * When true, value-moving triggers (e.g., stellar_payment, multisig_payment)
   * can be created and executed. When false (default), attempting to create
   * a value-moving trigger throws an error.
   */
  readonly TRIGGER_ALLOW_PAYMENTS: boolean;

  /**
   * How long (ms) to retain deduplication event records before pruning.
   * Prevents unbounded growth of the trigger_events table.
   * Defaults to 7 days (604,800,000 ms).
   */
  readonly TRIGGER_EVENTS_RETENTION_MS: number;

  /**
   * Port for the health-check HTTP server.
   * Validated by EnvSchema to be an integer between 1 and 65535.
   * Defaults to 3000.
   */
  readonly HEALTH_PORT: number;

  /**
   * Comma-separated allowlist of exact origins the health server's CORS
   * preflight handling accepts. Optional — unset means no CORS (#966).
   */
  readonly CORS_ALLOWED_ORIGINS?: string | undefined;

  /** LLM request budget in tokens. Defaults to 8,000. */
  readonly LLM_MAX_TOKENS_PER_REQUEST: number;
  /** Per-step LLM token budget. Defaults to 16,000. */
  readonly LLM_MAX_TOKENS_PER_STEP: number;
  /** Maximum planner tool-call iterations. Defaults to 25. */
  readonly LLM_MAX_TOOL_CALL_ITERATIONS: number;
  /** Rolling daily LLM token budget. Defaults to 1,000,000. */
  readonly LLM_MAX_TOKENS_PER_DAY: number;
  /** In-memory session idle TTL in milliseconds. Defaults to 30 minutes. */
  readonly SESSION_TTL_MS: number;
  /** Maximum conversation messages retained per session. Defaults to 50. */
  readonly SESSION_MAX_MESSAGES: number;
  /** Maximum concurrent in-memory sessions. Defaults to 500. */
  readonly SESSION_MAX_SESSIONS: number;

  /** Nano node RPC endpoint (default local HTTP; HTTPS required on mainnet). */
  readonly NANO_RPC_URL: string;
  /** Whether operators allow Nano payments to bypass recipient prechecks. */
  readonly NANO_ALLOW_SKIP_PRECHECK: boolean;
  /** Whether the nano_payment task is enabled (requires NANO_SEED or NANO_SEED_ARN). */
  readonly NANO_ENABLED: boolean;
  readonly NANO_SEED_ARN?: string | undefined;
  readonly CONTRACT_EVENT_POLL_MS?: number | undefined;
  readonly WEBHOOK_URL?: string | undefined;
  readonly WEBHOOK_SECRET?: string | undefined;
  /**
   * Payments above this amount are held for human approval before execution.
   * "0" means threshold is disabled — all tasks execute immediately.
   * Defaults to "0".
   */
  readonly APPROVAL_THRESHOLD: string;
   * Bearer token required by the HTTP API. Separate from WEBHOOK_SECRET so
   * leaking one does not compromise the other. When unset WEBHOOK_SECRET is
   * accepted in its place (deprecated).
   */
  readonly ADMIN_API_TOKEN?: string | undefined;
  /**
   * When true, X-Nodal-Signature is HMAC(body) instead of HMAC(`${timestamp}.${body}`).
   * Backward-compatibility flag for one release. Defaults to false.
   */
  readonly WEBHOOK_LEGACY_SIGNATURE: boolean;
  /**
   * When true the agent starts paused: value-moving tasks fail with
   * errorType AGENT_PAUSED until resumed via POST /admin/resume. Defaults to false.
   */
  readonly PAUSED: boolean;
  /**
   * How often (ms) each instance re-reads the paused state from the shared
   * storage backend, so a pause/resume on one instance is picked up by every
   * other instance sharing that store within this bound (#960). Defaults to 2000.
   */
  readonly KILL_SWITCH_SYNC_INTERVAL_MS: number;

  // ─── LLM Provider Configuration ─────────────────────────────────────────

  /**
   * LLM provider to use for the AI planner.
   * Optional - when not set, the AI layer is disabled.
   * Values: "openai", "anthropic", "mock"
   */
  readonly LLM_PROVIDER?: 'openai' | 'anthropic' | 'mock' | undefined;

  /**
   * Model identifier for the LLM provider.
   * Examples: "gpt-4o", "claude-3-sonnet-20240229"
   * Optional - each provider has its own default if not specified.
   */
  readonly LLM_MODEL?: string | undefined;

  /** OpenAI-compatible planner endpoint. */
  readonly LLM_ENDPOINT?: string | undefined;

  /**
   * Base URL for OpenAI-compatible APIs.
   * Useful for local models (Ollama, LM Studio) or proxy services.
   * Only applies when LLM_PROVIDER is "openai".
   */
  readonly LLM_BASE_URL?: string | undefined;

  /**
   * Timeout for LLM requests in milliseconds.
   * Defaults to 60,000 (1 minute).
   */
  readonly LLM_TIMEOUT_MS: number;

  /**
   * Maximum tokens to request from the LLM per response.
   * Defaults to 4,096.
   */
  readonly LLM_MAX_TOKENS: number;

  /**
   * Temperature for LLM sampling (0-2).
   * Higher values produce more creative outputs, lower values are more deterministic.
   * Defaults to 0.7.
   */
  readonly LLM_TEMPERATURE: number;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export function formatValidationErrors(errors: z.ZodError): string {
  return errors.issues
    .map((issue) => {
      const rawField = issue.path.join('.') || 'unknown';
      // Redact any path element that looks like a secret key — path may contain
      // raw values (e.g., when a secret key is used as a Zod path segment).
      const field =
        issue.path.map((p) => String(p).replace(/S[A-Z2-7]{55}/g, '[REDACTED]')).join('.') ||
        rawField;
      // Redact any value that looks like a secret key in the human-readable message
      const message = issue.message.replace(/S[A-Z2-7]{55}/g, '[REDACTED]');
      return `  • ${field}: ${message}`;
    })
    .join('\n');
}

/**
 * Loads, parses, and validates environment variables against the Zod schema.
 * Enforces spending caps, derivations, and network rules at startup.
 *
 * @returns The fully validated, read-only configuration instance.
 */
async function fetchSecretFromArn(arn: string): Promise<string> {
  const arnParts = arn.split(':');
  const region = arnParts.length > 3 && arnParts[3] ? arnParts[3] : 'us-east-1';
  const client = new SecretsManagerClient({ region });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) {
    throw new Error('No SecretString found in secret');
  }
  return res.SecretString;
}

function parseConfigAndDerive(
  env: NodeJS.ProcessEnv = process.env,
  { announce = true }: { announce?: boolean } = {}
): AgentConfig {
  const result = EnvSchema.safeParse(env);

  if (!result.success) {
    // Print structured errors — secret values are never echoed
    process.stderr.write(
      `\n❌ [Config] Invalid environment — fix the following before starting:\n` +
        formatValidationErrors(result.error) +
        `\n\nSee .env for reference.\n\n`
    );
    process.exit(1);
  }

  const raw: RawEnv = result.data;

  // ── Mainnet HTTPS enforcement ──────────────────────────────────────────────
  // On mainnet, all RPC endpoints MUST use HTTPS to prevent credential/data
  // exposure over unencrypted connections. Testnet and futurenet permit HTTP
  // for local devnets and CI environments.
  if (raw.STELLAR_NETWORK === 'mainnet') {
    const httpsErrors: string[] = [];
    if (!raw.HORIZON_URL.startsWith('https://')) {
      httpsErrors.push(`  • HORIZON_URL: must use HTTPS on mainnet (got: ${raw.HORIZON_URL})`);
    }
    if (!raw.SOROBAN_RPC_URL.startsWith('https://')) {
      httpsErrors.push(
        `  • SOROBAN_RPC_URL: must use HTTPS on mainnet (got: ${raw.SOROBAN_RPC_URL})`
      );
    }
    if (!raw.NANO_RPC_URL.startsWith('https://')) {
      httpsErrors.push(`  • NANO_RPC_URL: must use HTTPS on mainnet (got: ${raw.NANO_RPC_URL})`);
    }
    if (httpsErrors.length > 0) {
      process.stderr.write(
        `\n❌ [Config] Mainnet requires HTTPS for all RPC endpoints:\n` +
          httpsErrors.join('\n') +
          `\n\nSee .env.example for reference.\n\n`
      );
      process.exit(1);
    }
  }

  // ── Postgres storage needs a connection string ─────────────────────────────
  if (raw.STORAGE_BACKEND === 'postgres' && !raw.DATABASE_URL) {
    process.stderr.write('❌ [Config] DATABASE_URL is required when STORAGE_BACKEND=postgres.\n');
    process.exit(1);
  }

  // ── Derive public key from secret ──────────────────────────────────────────
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(raw.AGENT_SECRET_KEY);
  } catch {
    process.stderr.write('❌ [Config] Failed to derive keypair from AGENT_SECRET_KEY.\n');
    process.exit(1);
  }

  const derivedPublicKey = keypair.publicKey();

  // If AGENT_PUBLIC_KEY was explicitly provided, cross-check it matches
  if (raw.AGENT_PUBLIC_KEY && raw.AGENT_PUBLIC_KEY !== derivedPublicKey) {
    process.stderr.write(
      `❌ [Config] AGENT_PUBLIC_KEY does not match the key derived from AGENT_SECRET_KEY.\n` +
        `   Provided : ${raw.AGENT_PUBLIC_KEY}\n` +
        `   Derived  : ${derivedPublicKey}\n`
    );
    process.exit(1);
  }

  // ── Mainnet safety guard ───────────────────────────────────────────────────
  if (raw.STELLAR_NETWORK === 'mainnet') {
    const limitStroops = tryToStroops(raw.AGENT_SPENDING_LIMIT);
    if (limitStroops !== null && limitStroops > toStroops(String(MAINNET_SPENDING_CAP))) {
      process.stderr.write(
        `❌ [Config] AGENT_SPENDING_LIMIT (${raw.AGENT_SPENDING_LIMIT}) exceeds ` +
          `the mainnet safety cap of ${MAINNET_SPENDING_CAP.toLocaleString('en-US')}. Lower it or explicitly override.\n`
      );
      process.exit(1);
    }
  }

  // ── Parse per-asset spending limits ────────────────────────────────────────
  const spendingLimitsMap = new Map<string, string>();
  if (raw.SPENDING_LIMITS) {
    for (const entry of raw.SPENDING_LIMITS.split(',')) {
      const parts = entry.trim().split(':');
      if (parts.length === 2) {
        // "NATIVE:1000" or "XLM:1000" — native/code only
        const [code, limit] = parts as [string, string];
        spendingLimitsMap.set(code.toUpperCase(), limit);
      } else if (parts.length === 3) {
        // "USDC:GA5Z…:500" — credit asset with issuer
        const [code, issuer, limit] = parts as [string, string, string];
        spendingLimitsMap.set(`${code.toUpperCase()}:${issuer}`, limit);
      }
    }
  }

  // ── Parse per-asset approval thresholds (#953) ─────────────────────────────
  const approvalThresholdsMap = new Map<string, string>();
  if (raw.APPROVAL_THRESHOLDS) {
    for (const entry of raw.APPROVAL_THRESHOLDS.split(',')) {
      const parts = entry.trim().split(':');
      if (parts.length === 2) {
        const [code, threshold] = parts as [string, string];
        approvalThresholdsMap.set(code.toUpperCase(), threshold);
      } else if (parts.length === 3) {
        const [code, issuer, threshold] = parts as [string, string, string];
        approvalThresholdsMap.set(`${code.toUpperCase()}:${issuer}`, threshold);
      }
    }
  }

  // ── Parse named approver tokens (#954) ─────────────────────────────────────
  const approverTokensMap = new Map<string, string>();
  if (raw.APPROVER_TOKENS) {
    for (const entry of raw.APPROVER_TOKENS.split(',')) {
      const [name, hash] = entry.trim().split(':') as [string, string];
      approverTokensMap.set(name, hash.toLowerCase());
    }
  }

  // ── HTTP API auth guard ────────────────────────────────────────────────────
  // /status and /spending expose payment history and spending data. Without a
  // token the server would serve them to anyone, so mainnet refuses to start;
  // testnet and futurenet keep open mode but warn once at startup.
  if (!raw.ADMIN_API_TOKEN && !raw.WEBHOOK_SECRET) {
    if (raw.STELLAR_NETWORK === 'mainnet') {
      process.stderr.write(
        `❌ [Config] ADMIN_API_TOKEN is required on mainnet — the HTTP API would otherwise ` +
          `serve payment history and spending data without authentication.\n`
      );
      process.exit(1);
    }
    process.stderr.write(
      `⚠️  [Config] ADMIN_API_TOKEN is not set — /status, /spending and /metrics are ` +
        `unauthenticated (allowed on ${raw.STELLAR_NETWORK} only).\n`
    );
  } else if (!raw.ADMIN_API_TOKEN) {
    process.stderr.write(
      `⚠️  [Config] Using WEBHOOK_SECRET as the HTTP API token is deprecated — set a ` +
        `separate ADMIN_API_TOKEN so the webhook signing secret is not also an API password.\n`
    );
  }

  // ── MCP HTTP security guard ─────────────────────────────────────────────────
  // MCP_ALLOW_PAYMENTS=true exposes value-moving tools over HTTP. Refusing to
  // start without a bearer token prevents an open endpoint from draining the
  // agent account. See issue #911.
  if (raw.MCP_ALLOW_PAYMENTS && raw.MCP_TRANSPORT === 'http' && !raw.MCP_API_TOKEN) {
    process.stderr.write(
      `❌ [Config] MCP_API_TOKEN is required when MCP_ALLOW_PAYMENTS=true and ` +
        `MCP_TRANSPORT=http. ` +
        `An unauthenticated HTTP MCP endpoint with payment tools enabled would ` +
        `allow anyone who can reach the port to move funds from the agent account.\n`
    );
    process.exit(1);
  }

  // ── Payment destination policy ─────────────────────────────────────────────
  const paymentDestinations = (raw.PAYMENT_DESTINATIONS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (raw.PAYMENT_DESTINATIONS_FILE) {
    let contents: string;
    try {
      contents = readFileSync(raw.PAYMENT_DESTINATIONS_FILE, 'utf8');
    } catch {
      process.stderr.write(
        `❌ [Config] Could not read PAYMENT_DESTINATIONS_FILE (${raw.PAYMENT_DESTINATIONS_FILE}).\n`
      );
      process.exit(1);
    }
    for (const line of contents.split(/\r?\n/)) {
      const entry = line.replace(/#.*/, '').trim();
      if (entry) paymentDestinations.push(entry);
    }
  }
  const invalidDestinations = paymentDestinations.filter(
    (entry) => !isValidStellarPublicKey(entry) && !/^[^*\s]+\*[^*\s]+\.[^*\s]+$/.test(entry)
  );
  if (invalidDestinations.length > 0) {
    process.stderr.write(
      `❌ [Config] Payment destinations must be G-addresses or federation names (name*domain):\n` +
        invalidDestinations.map((entry) => `  • ${entry}`).join('\n') +
        `\n`
    );
    process.exit(1);
  }

  // ── x402 asset contract (C…) vs classic issuer (G…) (#776) ─────────────────
  const networkPassphrase = {
    testnet: Networks.TESTNET,
    mainnet: Networks.PUBLIC,
    futurenet: Networks.FUTURENET,
  }[raw.STELLAR_NETWORK];
  const x402AssetContract = (
    raw.X402_ASSET_CODE === 'XLM'
      ? Asset.native()
      : new Asset(raw.X402_ASSET_CODE, raw.X402_ASSET_ISSUER)
  ).contractId(networkPassphrase);
  if (raw.X402_ASSET_CONTRACT && raw.X402_ASSET_CONTRACT !== x402AssetContract) {
    process.stderr.write(
      `❌ [Config] X402_ASSET_CONTRACT is not the Stellar Asset Contract for ` +
        `${raw.X402_ASSET_CODE}${raw.X402_ASSET_CODE === 'XLM' ? '' : `:${raw.X402_ASSET_ISSUER}`} ` +
        `on ${raw.STELLAR_NETWORK}.\n` +
        `   Provided : ${raw.X402_ASSET_CONTRACT}\n` +
        `   Derived  : ${x402AssetContract}\n` +
        `   X402_ASSET_ISSUER is the classic issuer (G…); X402_ASSET_CONTRACT is the SAC (C…). ` +
        `Unset X402_ASSET_CONTRACT to derive it.\n`
    );
    process.exit(1);
  }

  // ── Build the config object — secret key stays in closure only ────────────
  const {
    AGENT_SECRET_KEY: _secret,
    ALLOWED_X402_ORIGINS,
    AGENT_SECRET_KEY_ARN,
    SPENDING_LIMITS: _rawLimits,
    APPROVAL_THRESHOLDS: _rawApprovalThresholds,
    APPROVER_TOKENS: _rawApproverTokens,
    OTLP_ENDPOINT,
    WEBHOOK_URL,
    WEBHOOK_SECRET,
    APPROVAL_THRESHOLD,
    DATABASE_URL,
    LLM_API_KEY: llmApiKey,
    VAULT_TOKEN: vaultToken,
    OZ_API_KEY: ozApiKey,
    NANO_SEED: nanoSeed, // Secret - exposed only through getNanoSeed()
    ...rest
  } = raw;

  if (raw.NANO_ENABLED && !nanoSeed) {
    process.stderr.write('❌ [Config] NANO_ENABLED=true requires NANO_SEED or NANO_SEED_ARN.\n');
    process.exit(1);
  }
  _nanoSeed = nanoSeed;
  _llmApiKey = llmApiKey;
  _vaultToken = vaultToken;
  _ozApiKey = ozApiKey;

  const rpcTimeoutMs = raw.RPC_TIMEOUT_MS ?? raw.RETRY_DELAY_MS * raw.MAX_RETRIES * 2;

  // Derive the keypair once at startup. agentKeypair returns this cached instance
  // on every call, avoiding repeated Ed25519 derivation.
  const _keypair = Keypair.fromSecret(_secret);

  const cfg: AgentConfig = {
    ...rest,
    AGENT_PUBLIC_KEY: derivedPublicKey,
    RPC_TIMEOUT_MS: rpcTimeoutMs,
    MAX_X402_PAYMENTS_PER_MINUTE: raw.MAX_X402_PAYMENTS_PER_MINUTE,
    X402_NONCE_TTL_MS: raw.X402_NONCE_TTL_MS,
    MAX_SOROBAN_FEE_STROOPS: raw.MAX_SOROBAN_FEE_STROOPS,
    APPROVAL_THRESHOLD,
    ...(ALLOWED_X402_ORIGINS && { ALLOWED_X402_ORIGINS }),
    ...(AGENT_SECRET_KEY_ARN && { AGENT_SECRET_KEY_ARN }),
    ...(OTLP_ENDPOINT && { OTLP_ENDPOINT }),
    ...(WEBHOOK_URL && { WEBHOOK_URL }),
    ...(WEBHOOK_SECRET && { WEBHOOK_SECRET }),
    SPENDING_LIMITS_MAP: spendingLimitsMap,
    APPROVAL_THRESHOLDS_MAP: approvalThresholdsMap,
    APPROVER_TOKENS_MAP: approverTokensMap,
    SPENDING_LIMITS_ALLOW_UNKNOWN: raw.SPENDING_LIMITS_ALLOW_UNKNOWN,
    PAYMENT_DESTINATIONS: paymentDestinations,
    X402_ASSET_CONTRACT: x402AssetContract,
    ...(raw.AGENT_POLICY_ACCOUNT ? { AGENT_POLICY_ACCOUNT: raw.AGENT_POLICY_ACCOUNT } : {}),
    ...(ALLOWED_X402_ORIGINS ? { ALLOWED_X402_ORIGINS } : {}),
    ...(AGENT_SECRET_KEY_ARN ? { AGENT_SECRET_KEY_ARN } : {}),
    ...(OTLP_ENDPOINT ? { OTLP_ENDPOINT } : {}),
    ...(WEBHOOK_URL ? { WEBHOOK_URL } : {}),
    ...(WEBHOOK_SECRET ? { WEBHOOK_SECRET } : {}),
    ...(DATABASE_URL ? { DATABASE_URL } : {}),
    ...(raw.CONTRACT_EVENT_POLL_MS !== undefined
      ? { CONTRACT_EVENT_POLL_MS: raw.CONTRACT_EVENT_POLL_MS }
      : {}),
    // LLM configuration - all have defaults
    LLM_TIMEOUT_MS: raw.LLM_TIMEOUT_MS ?? 60_000,
    LLM_MAX_TOKENS: raw.LLM_MAX_TOKENS ?? 4096,
    LLM_TEMPERATURE: raw.LLM_TEMPERATURE ?? 0.7,
    ...(raw.LLM_PROVIDER ? { LLM_PROVIDER: raw.LLM_PROVIDER } : {}),
    ...(raw.LLM_MODEL ? { LLM_MODEL: raw.LLM_MODEL } : {}),
    ...(raw.LLM_BASE_URL ? { LLM_BASE_URL: raw.LLM_BASE_URL } : {}),
    // Secret is captured in closure; never on the object
    agentKeypair: () => _keypair,
  };

  if (!announce) return cfg;

  // Startup banner — only safe fields
  process.stdout.write(
    `✅ [Config] Environment validated\n` +
      `   Network        : ${cfg.STELLAR_NETWORK}\n` +
      `   Horizon        : ${cfg.HORIZON_URL}\n` +
      `   Soroban        : ${cfg.SOROBAN_RPC_URL}\n` +
      `   Agent pubkey   : ${cfg.AGENT_PUBLIC_KEY}\n` +
      `   Spending limit : ${cfg.AGENT_SPENDING_LIMIT} ${cfg.X402_ASSET_CODE}\n` +
      `   Max retries    : ${cfg.MAX_RETRIES}\n`
  );

  // Add LLM info to banner if configured
  if (cfg.LLM_PROVIDER) {
    process.stdout.write(
      `   LLM provider   : ${cfg.LLM_PROVIDER}${cfg.LLM_MODEL ? ` (${cfg.LLM_MODEL})` : ''}\n`
    );
  }

  return cfg;
}

function loadConfigSync(): AgentConfig {
  assertSecretConfigCompatibility();
  if (process.env.AGENT_SECRET_KEY_ARN) {
    throw new Error('Cannot load configuration synchronously when AGENT_SECRET_KEY_ARN is set.');
  }
  return parseConfigAndDerive();
}

let _nanoSeed: string | undefined;
let _llmApiKey: string | undefined;
let _vaultToken: string | undefined;
let _ozApiKey: string | undefined;

/** The Nano signing seed from NANO_SEED / NANO_SEED_ARN, if configured. */
export function getNanoSeed(): string | undefined {
  return _nanoSeed;
}

/** Returns the Vault token without exposing it on the public config object. */
export function getVaultToken(): string | undefined {
  return _vaultToken;
}

/** Returns the OpenZeppelin API key without exposing it on the public config object. */
export function getOZApiKey(): string | undefined {
  return _ozApiKey;
}

/** Read the HTTP API token per request while validating any runtime rotation. */
export function getAdminApiToken(): string | undefined {
  const result = ApiTokenSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(
      `Invalid HTTP API token configuration:\n${formatValidationErrors(result.error)}`
    );
  }
  return result.data.ADMIN_API_TOKEN || result.data.WEBHOOK_SECRET || undefined;
}

function assertSecretConfigCompatibility(): void {
  if (process.env.NANO_SEED && process.env.NANO_SEED_ARN) {
    process.stderr.write('❌ [Config] Cannot specify both NANO_SEED and NANO_SEED_ARN.\n');
    process.exit(1);
  }
  if (process.env.AGENT_SECRET_KEY && process.env.AGENT_SECRET_KEY_ARN) {
    process.stderr.write(
      '❌ [Config] Cannot specify both AGENT_SECRET_KEY and AGENT_SECRET_KEY_ARN.\n'
    );
    process.exit(1);
  }
}

export async function loadConfig(): Promise<AgentConfig> {
  assertSecretConfigCompatibility();

  if (process.env.AGENT_SECRET_KEY_ARN) {
    try {
      const arn = process.env.AGENT_SECRET_KEY_ARN;
      const secret = await fetchSecretFromArn(arn);
      let parsedSecret = secret;
      try {
        const json = JSON.parse(secret);
        if (json && typeof json === 'object' && !Array.isArray(json)) {
          const candidate = json.AGENT_SECRET_KEY;
          if (typeof candidate === 'string') {
            parsedSecret = candidate;
          } else {
            const firstValue = Object.values(json).find(
              (value): value is string => typeof value === 'string'
            );
            if (firstValue) {
              parsedSecret = firstValue;
            }
          }
        }
      } catch {
        // Not a JSON object, use raw string
      }
      process.env.AGENT_SECRET_KEY = parsedSecret;
    } catch (err: any) {
      process.stderr.write(
        `❌ [Config] Failed to fetch secret from AWS Secrets Manager (ARN: ${process.env.AGENT_SECRET_KEY_ARN}): ${err.message}\n`
      );
      process.exit(1);
    }
  }

  if (process.env.NANO_SEED_ARN) {
    try {
      process.env.NANO_SEED = (await fetchSecretFromArn(process.env.NANO_SEED_ARN)).trim();
    } catch (err: any) {
      process.stderr.write(
        `❌ [Config] Failed to fetch NANO_SEED_ARN from AWS Secrets Manager: ${err.message}\n`
      );
      process.exit(1);
    }
  }

  return parseConfigAndDerive();
}

let _config: AgentConfig | null = null;
let _configError: Error | null = null;

// Synchronous default initialization if AGENT_SECRET_KEY is defined directly
if (process.env.AGENT_SECRET_KEY && process.env.AGENT_SECRET_KEY_ARN) {
  // Both set — record as error immediately so configPromise rejects and
  // the proxy throws the right message before awaiting.
  _configError = new Error('Cannot specify both AGENT_SECRET_KEY and AGENT_SECRET_KEY_ARN.');
  process.stderr.write(
    '❌ [Config] Cannot specify both AGENT_SECRET_KEY and AGENT_SECRET_KEY_ARN.\n'
  );
} else if (
  process.env.AGENT_SECRET_KEY &&
  !process.env.AGENT_SECRET_KEY_ARN &&
  !process.env.NANO_SEED_ARN
) {
  try {
    _config = loadConfigSync();
  } catch (err: any) {
    _configError = err;
  }
}

function ensureConfigPromise(): Promise<AgentConfig> {
  if (_config) return Promise.resolve(_config);
  if (_configError) return Promise.reject(_configError);
  if (!__configPromise) {
    __configPromise = (async () => {
      try {
        _config = await loadConfig();
        return _config;
      } catch (err: any) {
        _configError = err;
        throw err;
      }
    })();
  }
  return __configPromise;
}

let __configPromise: Promise<AgentConfig> | null = null;

export const configPromise = {
  then: <TResult1 = AgentConfig, TResult2 = never>(
    onfulfilled?: ((value: AgentConfig) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ) => ensureConfigPromise().then(onfulfilled, onrejected),
  catch: <TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ) => ensureConfigPromise().catch(onrejected),
  finally: (onfinally?: (() => void) | null) => ensureConfigPromise().finally(onfinally),
} as PromiseLike<AgentConfig>;

// ─── LLM Provider Helper ───────────────────────────────────────────────────

/**
 * Gets the validated LLM API key from private config state.
 * The key is NEVER exposed on the config object - call this function directly.
 * @returns The LLM API key or undefined if not configured
 */
export function getLLMApiKey(): string | undefined {
  return _llmApiKey;
}

/**
 * Creates an LLM provider from the current configuration.
 * Returns undefined if LLM_PROVIDER is not set.
 *
 * Usage:
 *   const provider = createLLMProvider();
 *   if (provider) {
 *     const response = await provider.generate(messages, options);
 *   }
 */
export function createLLMProvider():
  ReturnType<typeof import('./ai/providers').createLLMProvider> | undefined {
  const providerType = config.LLM_PROVIDER;
  const apiKey = getLLMApiKey();

  if (!providerType) {
    return undefined;
  }

  // Lazy require to avoid a circular dependency (ai/providers imports config).
  const { createLLMProvider: createProvider } =
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('./ai/providers') as typeof import('./ai/providers');

  return createProvider({
    provider: providerType,
    // Empty selects each provider's own default model (`config.model || defaultModel`).
    model: config.LLM_MODEL ?? '',
    apiKey: apiKey || '',
    ...(config.LLM_BASE_URL ? { baseUrl: config.LLM_BASE_URL } : {}),
    timeoutMs: config.LLM_TIMEOUT_MS,
    maxRetries: 3,
  });
}

/**
 * Testnet defaults served when the process has no Stellar configuration at all
 * (#689) — e.g. docs generation, or a module imported only for its types.
 *
 * Built from EnvSchema's own defaults with a throwaway keypair, so it never
 * holds a real key and cannot drift from the schema. Built on first use.
 */
const FALLBACK_CONFIG: AgentConfig = new Proxy({} as AgentConfig, {
  get(_target, prop, receiver) {
    _fallbackConfig ??= parseConfigAndDerive(
      {
        ...process.env,
        STELLAR_NETWORK: 'testnet',
        HORIZON_URL: 'https://horizon-testnet.stellar.org',
        SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
        X402_ASSET_CODE: 'USDC',
        X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        AGENT_SECRET_KEY: Keypair.random().secret(),
        AGENT_SPENDING_LIMIT: '100',
        AGENT_SECRET_KEY_ARN: undefined,
        SIGNER_BACKEND: 'local',
        VAULT_TOKEN: undefined,
        OZ_API_KEY: undefined,
        NANO_ENABLED: 'false',
        NANO_SEED: undefined,
        NANO_SEED_ARN: undefined,
      },
      { announce: false }
    );
    return Reflect.get(_fallbackConfig, prop, receiver);
  },
});
let _fallbackConfig: AgentConfig | undefined;

export const config = new Proxy({} as AgentConfig, {
  get(target, prop, receiver) {
    if (_configError) {
      throw _configError;
    }
    if (!_config) {
      const hasAnyEnvConfig = Object.keys(process.env).some((key) =>
        ['HORIZON_URL', 'SOROBAN_RPC_URL', 'AGENT_SECRET_KEY', 'X402_ASSET_ISSUER'].includes(key)
      );

      if (!hasAnyEnvConfig) {
        return Reflect.get(FALLBACK_CONFIG, prop, receiver);
      }

      try {
        _config = loadConfigSync();
      } catch (err: any) {
        _configError = err;
        throw err;
      }
    }
    return Reflect.get(_config, prop, receiver);
  },
});

/**
 * Hardcoded spending limit (safety cap) for transactions on Stellar mainnet.
 * Any single operation/payment attempting to exceed this value will be blocked
 * by the spending limit assertion before submission.
 */
// ─── Compile-time encapsulation guard ────────────────────────────────────────
// AgentConfig intentionally omits AGENT_SECRET_KEY so it is never accessible
// on the config object. The line below causes a deliberate TS2551 compile error
// (suppressed by @ts-expect-error) to prove the property does not exist on the type.
// @ts-expect-error — TS2551: Property 'AGENT_SECRET_KEY' does not exist on 'AgentConfig'
declare const _configTypeGuard: AgentConfig['AGENT_SECRET_KEY'];
