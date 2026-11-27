/**
 * backend/sdk.ts
 *
 * Public API for the `nodal-ai` npm package.
 *
 * This module is the entry point for library consumers:
 *   import { PayFiAgent } from 'nodal-ai';
 *
 * It deliberately excludes the process entrypoint concerns (SIGTERM handlers,
 * db.migrate(), hard-kill timers) that live in backend/index.ts. That file
 * remains the internal server bootstrap; this file is what ships in the package.
 *
 * @module nodal-ai
 */

// ─── Core agent ───────────────────────────────────────────────────────────────

export { PayFiAgent, spendingTracker, VALUE_MOVING_TASK_TYPES } from './agent';

export type {
  AgentTask,
  AgentResult,
  AgentResultData,
  AgentEvents,
  BuiltinTaskType,
  TaskType,
  TaskPayloadMap,
  TaskResultMap,
  Plan,
  TaskMiddleware,
} from './agent';

// ─── Configuration ────────────────────────────────────────────────────────────

export { EnvSchema, formatValidationErrors, MAINNET_SPENDING_CAP } from './config';

export type { AgentConfig } from './config';

// ─── Errors ────────────────────────────────────────────────────────��──────────

export {
  ErrorType,
  StructuredError,
  InsufficientFundsError,
  NetworkTimeoutError,
  ValidationError,
  RateLimitError,
  UnauthorizedError,
  ContractError,
  TransactionFailureError,
  ConfigError,
  SimulationBudgetError,
  AgentPausedError,
  AgentShuttingDownError,
  PolicyViolationError,
  DestinationNotFoundError,
  MissingTrustlineError,
  MemoRequiredError,
  sanitizeCause,
  getErrorType,
} from './errors';

// ─── Signer ───────────────────────────────────────────────────────────────────

export { KeypairSigner, createAgentSigner } from './signer';

export type { Signer } from './signer';

// ─── Persistence ─────────────────────────────────────────────────────────────

export type { AuditEntry, PendingApproval } from './persistence';

// ─── Spending tracker ─────────────────────────────────────────────────────────

export { assetKey, assetKeyForPaymentAsset } from './spending_tracker';

// ─── Utilities ────────────────────────────────────────────────────────────────

export { createLogger, generateCorrelationId } from './utils/logger';

export { toStroops, tryToStroops, stroopsToString, STROOPS_PER_UNIT } from './utils/amount';
