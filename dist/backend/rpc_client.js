"use strict";
/**
 * backend/rpc_client.ts
 * Thin wrapper around Horizon + Soroban RPC with retry logic.
 * All network calls route through here — centralised observability point.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sorobanServer = exports.horizonServer = exports.TimeoutError = void 0;
exports.DEFAULT_IS_RETRYABLE = DEFAULT_IS_RETRYABLE;
exports.withRetry = withRetry;
exports.loadAccount = loadAccount;
exports.submitTransaction = submitTransaction;
exports.simulateSorobanTx = simulateSorobanTx;
exports.prepareSorobanTx = prepareSorobanTx;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const zod_1 = require("zod");
const config_1 = require("./config");
const xdr_1 = require("./types/xdr");
// ─── Timeout error ────────────────────────────────────────────────────────────
class TimeoutError extends Error {
    constructor(ms) {
        super(`Transaction Timeout: request did not complete within ${ms}ms`);
        this.name = "TimeoutError";
    }
}
exports.TimeoutError = TimeoutError;
const SUBMIT_TIMEOUT_MS = 30_000;
// ─── Exponential back-off retry ─────────────────────────────────────────────
/**
 * Returns false for deterministic failures (ZodError, TypeError) that will
 * never succeed on retry, true for transient errors worth retrying.
 */
function DEFAULT_IS_RETRYABLE(err) {
    if (err instanceof zod_1.ZodError)
        return false;
    if (err instanceof TypeError)
        return false;
    return true;
}
async function withRetry(fn, retries = config_1.config.MAX_RETRIES, delayMs = config_1.config.RETRY_DELAY_MS, isRetryable = DEFAULT_IS_RETRYABLE, maxDelayMs = 30_000) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            if (!isRetryable(err)) {
                throw err;
            }
            lastErr = err;
            console.warn(`  Attempt ${attempt}/${retries} failed:`, err.message);
            if (attempt < retries) {
                // True exponential back-off: 1500 → 3000 → 6000 ms for RETRY_DELAY_MS=1500
                const exponential = delayMs * Math.pow(2, attempt - 1);
                const capped = Math.min(exponential, maxDelayMs);
                // ±20% jitter to prevent thundering herd across simultaneous agent instances
                const jitter = Math.random() * 0.2 * capped;
                await new Promise((r) => setTimeout(r, capped + jitter));
            }
        }
    }
    throw lastErr;
}
// ─── Horizon client ──────────────────────────────────────────────────────────
exports.horizonServer = new stellar_sdk_1.Horizon.Server(config_1.config.HORIZON_URL, {
    allowHttp: config_1.config.STELLAR_NETWORK !== "mainnet",
});
async function loadAccount(publicKey) {
    return withRetry(() => exports.horizonServer.loadAccount(publicKey), config_1.config.MAX_RETRIES, config_1.config.RETRY_DELAY_MS, DEFAULT_IS_RETRYABLE);
}
async function submitTransaction(tx) {
    // Guard: validate XDR encoding before initiating any network call
    (0, xdr_1.validateXDR)(tx.toEnvelope().toXDR("base64"));
    return withRetry(() => {
        const controller = new AbortController();
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                controller.abort();
                reject(new TimeoutError(SUBMIT_TIMEOUT_MS));
            }, SUBMIT_TIMEOUT_MS);
        });
        return Promise.race([
            exports.horizonServer.submitTransaction(tx),
            timeoutPromise,
        ]).finally(() => clearTimeout(timeoutId));
    });
}
// ─── Soroban RPC client ───────────────────────────────────────────────────────
exports.sorobanServer = new stellar_sdk_1.rpc.Server(config_1.config.SOROBAN_RPC_URL, {
    allowHttp: config_1.config.STELLAR_NETWORK !== "mainnet",
});
/**
 * Simulate a Soroban transaction BEFORE broadcasting.
 * Returns the simulation result — callers MUST check for errors.
 */
async function simulateSorobanTx(tx) {
    return withRetry(() => exports.sorobanServer.simulateTransaction(tx), config_1.config.MAX_RETRIES, config_1.config.RETRY_DELAY_MS, DEFAULT_IS_RETRYABLE);
}
/**
 * Prepare (simulate + assemble) a Soroban transaction.
 * Throws if simulation indicates failure — safe guard before broadcast.
 */
async function prepareSorobanTx(tx) {
    const simResult = await simulateSorobanTx(tx);
    if (stellar_sdk_1.rpc.Api.isSimulationError(simResult)) {
        throw new Error(`Soroban simulation failed: ${simResult.error}`);
    }
    return stellar_sdk_1.rpc.assembleTransaction(tx, simResult).build();
}
//# sourceMappingURL=rpc_client.js.map