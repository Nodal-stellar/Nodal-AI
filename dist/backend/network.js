"use strict";
/**
 * backend/network.ts
 *
 * Rate-limit aware network handler for Horizon/Soroban RPC calls.
 * Detects HTTP 429 responses, extracts Retry-After, and pauses outbound traffic.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isThrottled = isThrottled;
exports.handleRateLimitResponse = handleRateLimitResponse;
exports.withBackoffGuard = withBackoffGuard;
exports.getBackoffStatus = getBackoffStatus;
const logger_1 = require("./utils/logger");
const log = (0, logger_1.createLogger)('network');
const globalBackoff = {
    active: false,
    until: 0,
    retryAfterSeconds: 0,
    queue: [],
    generation: 0,
};
// ─── Public API ────────────────────────────────────────────────────
/**
 * Check whether the network is currently throttled.
 * Callers should check this before making outbound calls.
 */
function isThrottled() {
    if (!globalBackoff.active)
        return false;
    if (Date.now() >= globalBackoff.until) {
        clearBackoff();
        return false;
    }
    return true;
}
/**
 * Notify the network layer that a 429 response was received.
 * Extracts the Retry-After header value and activates the backoff lock.
 *
 * @param retryAfterHeader - Value of the Retry-After header (seconds), or a fallback.
 */
function handleRateLimitResponse(retryAfterHeader) {
    let waitSeconds = 30; // default fallback
    if (retryAfterHeader) {
        const parsed = parseInt(retryAfterHeader, 10);
        if (!isNaN(parsed) && parsed > 0) {
            waitSeconds = parsed;
        }
    }
    globalBackoff.active = true;
    globalBackoff.retryAfterSeconds = waitSeconds;
    globalBackoff.until = Date.now() + waitSeconds * 1000;
    globalBackoff.generation += 1;
    const generation = globalBackoff.generation;
    log.warn(`[Network] Rate limit reached. Throttling outbound traffic for ${waitSeconds} seconds.`);
    // Schedule auto-clear when the backoff expires. The generation is captured
    // here so that if a newer backoff activation supersedes this one before
    // this timer fires, the stale timer becomes a no-op instead of clearing
    // (and draining the queue of) the newer, still-active backoff.
    const remaining = globalBackoff.until - Date.now();
    setTimeout(() => {
        clearBackoff(generation);
    }, remaining);
}
/**
 * If throttled, enqueue the callback to be called when the lock clears.
 * If not throttled, executes immediately.
 */
async function withBackoffGuard(fn) {
    if (!isThrottled()) {
        return fn();
    }
    // Enqueue and wait for lock to clear. The generation is captured at
    // enqueue time so a callback that outlives its own backoff activation
    // (superseded by a newer one before it gets drained) is rejected instead
    // of running under a since-changed backoff state.
    const enqueuedGeneration = globalBackoff.generation;
    return new Promise((resolve, reject) => {
        globalBackoff.queue.push(() => {
            if (globalBackoff.generation !== enqueuedGeneration) {
                reject(new Error('Backoff superseded before queued callback could run'));
                return;
            }
            fn().then(resolve).catch(reject);
        });
    });
}
/**
 * Returns the current backoff status for telemetry/monitoring.
 */
function getBackoffStatus() {
    return {
        active: globalBackoff.active,
        retryAfterSeconds: globalBackoff.retryAfterSeconds,
        queueSize: globalBackoff.queue.length,
    };
}
// ─── Internal ──────────────────────────────────────────────────────
function clearBackoff(generation) {
    if (generation !== undefined && generation !== globalBackoff.generation) {
        // A newer backoff activation has superseded this timer; skip clearing.
        return;
    }
    globalBackoff.active = false;
    globalBackoff.retryAfterSeconds = 0;
    globalBackoff.until = 0;
    log.info('[Network] Rate limit lock cleared — resuming normal traffic.');
    // Drain the queued callbacks
    const pending = globalBackoff.queue.splice(0);
    for (const cb of pending) {
        try {
            cb();
        }
        catch (err) {
            log.error({ error: err.message }, '[Network] Error executing queued callback');
        }
    }
}
//# sourceMappingURL=network.js.map