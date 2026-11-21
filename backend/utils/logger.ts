/**
 * backend/utils/logger.ts
 * Singleton Pino logger. Import `logger` or use `createLogger` for component-scoped child loggers.
 * Set LOG_LEVEL env var to control verbosity (default: "info").
 * Set NODE_ENV=production to emit raw JSON; otherwise prettified output is used.
 *
 * When MCP_TRANSPORT=stdio, stdout is the exclusive JSON-RPC channel.
 * All log output is routed to stderr (fd 2) in that mode so log lines never
 * corrupt the protocol stream.
 */

import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

/** True when the process is acting as an MCP stdio server. */
const isMCPStdio = process.env.MCP_TRANSPORT === 'stdio' || process.env.MCP_TRANSPORT === undefined;

// Transaction memos (e.g. the nonce slices X402PaymentTool writes) can carry
// caller-supplied, potentially user-identifiable strings, so they're stripped
// from structured log output regardless of nesting depth.
// Stellar secret keys (S followed by 55 base32 chars) are also redacted so
// they never reach log output, matching the legacy backend/logger.ts behavior.
export const REDACT_PATHS = [
  '*.memo',
  'payload.memo',
  'data.memo',
  'secret',
  'secretKey',
  '*.secret',
  '*.secretKey',
  'payload.secret',
  'payload.secretKey',
  'data.secret',
  'data.secretKey',
];

// Matches Stellar secret keys (S + 55 base32 chars) anywhere in a string value.
const STELLAR_SECRET_KEY_REGEX = /S[A-Z2-7]{55}/g;

/**
 * Recursively redacts Stellar secret keys from string values so the Pino
 * logger preserves the legacy logger's secret-key scrubbing behavior.
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(STELLAR_SECRET_KEY_REGEX, '[REDACTED]');
  }
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactSecrets(val);
    }
    return result;
  }
  return value;
}

// In stdio MCP mode stdout is the JSON-RPC channel, so all log output must go
// to stderr.  pino-pretty's transport worker also needs `destination: 2` so it
// does not open its own stdout handle.
const pinoOptions: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: REDACT_PATHS,
    remove: true,
  },
  hooks: {
    logMethod(args, method) {
      const redacted = args.map(redactSecrets);
      return method.apply(this, redacted as Parameters<typeof method>);
    },
  },
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        ...(isMCPStdio && { destination: 2 }),
      },
    },
  }),
};

export const logger = isMCPStdio && !isDev
  ? pino(pinoOptions, pino.destination(2))
  : pino(pinoOptions);

/**
 * Returns a child logger pre-tagged with `component` and an optional `correlationId`.
 * Use this at the top of each module: `const log = createLogger("orchestrator")`.
 */
export function createLogger(component: string, correlationId?: string) {
  return logger.child({
    component,
    ...(correlationId !== undefined && { correlationId }),
  });
}

/** Generates a UUID v4 to correlate all log entries for a single transaction flow. */
export function generateCorrelationId(): string {
  return crypto.randomUUID();
}
