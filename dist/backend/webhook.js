"use strict";
/**
 * backend/webhook.ts
 * Fire-and-forget webhook dispatcher called after every agent task.
 * Signs the payload with HMAC-SHA256 if WEBHOOK_SECRET is set.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signPayload = signPayload;
exports.verifyWebhookSignature = verifyWebhookSignature;
exports.isRetryableWebhookError = isRetryableWebhookError;
exports.dispatchWebhook = dispatchWebhook;
const crypto_1 = __importStar(require("crypto"));
const axios_1 = __importDefault(require("axios"));
const config_1 = require("./config");
const logger_1 = require("./utils/logger");
const network_1 = require("./network");
const log = (0, logger_1.createLogger)('webhook');
function signPayload(payload, secret) {
    return (0, crypto_1.createHmac)('sha256', secret).update(payload).digest('hex');
}
function verifyWebhookSignature(payload, sig, secret) {
    if (typeof sig !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sig))
        return false;
    const expected = Buffer.from(signPayload(payload, secret), 'hex');
    const received = Buffer.from(sig, 'hex');
    if (expected.length !== received.length)
        return false;
    return crypto_1.default.timingSafeEqual(expected, received);
}
function isRetryableWebhookError(errOrStatus) {
    let status;
    if (typeof errOrStatus === 'number') {
        status = errOrStatus;
    }
    else if (errOrStatus && typeof errOrStatus === 'object') {
        const httpErr = errOrStatus;
        status = httpErr.response?.status ?? httpErr.status;
    }
    if (status !== undefined) {
        if (status >= 200 && status < 300)
            return false;
        if (status === 429)
            return true;
        if (status >= 400 && status < 500)
            return false;
        if (status >= 500 && status < 600)
            return true;
    }
    // Connection errors, network drops, or unclassified errors default to retryable
    return true;
}
async function dispatchWebhook(result, options) {
    if (!config_1.config.WEBHOOK_URL)
        return;
    const maxAttempts = options?.maxAttempts ?? 3;
    const initialDelayMs = options?.initialDelayMs ?? 1000;
    const body = JSON.stringify(result);
    const headers = { 'Content-Type': 'application/json' };
    if (config_1.config.WEBHOOK_SECRET) {
        headers['X-Nodal-Signature'] = signPayload(body, config_1.config.WEBHOOK_SECRET);
    }
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await axios_1.default.post(config_1.config.WEBHOOK_URL, body, { headers });
            const status = response?.status;
            if (status !== undefined && (status < 200 || status >= 300)) {
                const error = Object.assign(new Error(`Webhook responded with status ${status}`), {
                    status,
                    response,
                });
                throw error;
            }
            log.info({ taskType: result.taskType }, 'Webhook delivered');
            return;
        }
        catch (err) {
            lastError = err;
            const httpErr = (err && typeof err === 'object' ? err : {});
            const status = httpErr.response?.status ?? httpErr.status;
            if (status === 429) {
                const retryAfter = httpErr.response?.headers?.['retry-after'];
                (0, network_1.handleRateLimitResponse)(retryAfter);
            }
            if (!isRetryableWebhookError(err)) {
                log.warn({
                    taskType: result.taskType,
                    status,
                    attempt,
                    error: err instanceof Error ? err.message : String(err),
                }, 'Webhook delivery failed (non-retryable)');
                return;
            }
            log.warn({
                taskType: result.taskType,
                status,
                attempt,
                maxAttempts,
                error: err instanceof Error ? err.message : String(err),
            }, 'Webhook delivery attempt failed');
            if (attempt < maxAttempts) {
                const delay = initialDelayMs * Math.pow(2, attempt - 1);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }
    log.warn({
        taskType: result.taskType,
        attempts: maxAttempts,
        error: lastError instanceof Error ? lastError.message : String(lastError),
    }, 'Webhook delivery failed after max retries');
}
//# sourceMappingURL=webhook.js.map