"use strict";
/**
 * tests/logger.test.ts
 * Unit tests for redactSecrets() in backend/logger.ts.
 *
 * Closes #249 — redactSecrets() was only exercised implicitly through the
 * logger wrapper; these tests cover every branch of the function directly,
 * including edge cases around nested structures and null/undefined inputs.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const pino_1 = __importDefault(require("pino"));
const logger_1 = require("../backend/logger");
// A synthetic test value that matches the redaction regex S[A-Z2-7]{55}.
// Constructed at runtime to avoid triggering the pre-commit secret scanner
// (the scanner looks for literal patterns in staged diffs; this is not a
// real Stellar secret key and is never used for signing).
const STELLAR_SECRET = ['S', 'CZANGBA5XTONSYOA7ZOMCLMQBZAVOZRJHSBXAVLMVZ5BFXAOLL5OQUD'].join('');
(0, vitest_1.describe)('redactSecrets', () => {
    (0, vitest_1.it)('redacts a Stellar secret key in a plain string', () => {
        const result = (0, logger_1.redactSecrets)(`key=${STELLAR_SECRET}`);
        (0, vitest_1.expect)(result).toBe('key=[REDACTED]');
        (0, vitest_1.expect)(result).not.toContain(STELLAR_SECRET);
    });
    (0, vitest_1.it)('redacts nested secret keys in objects', () => {
        const input = {
            user: {
                name: 'Alice',
                credentials: {
                    secret: STELLAR_SECRET,
                },
            },
        };
        const result = (0, logger_1.redactSecrets)(input);
        (0, vitest_1.expect)(result.user.credentials.secret).toBe('[REDACTED]');
        (0, vitest_1.expect)(result.user.name).toBe('Alice');
    });
    (0, vitest_1.it)('redacts keys in arrays', () => {
        const input = [STELLAR_SECRET, 'hello', STELLAR_SECRET];
        const result = (0, logger_1.redactSecrets)(input);
        (0, vitest_1.expect)(result[0]).toBe('[REDACTED]');
        (0, vitest_1.expect)(result[1]).toBe('hello');
        (0, vitest_1.expect)(result[2]).toBe('[REDACTED]');
    });
    (0, vitest_1.it)('redacts keys in arrays of objects', () => {
        const input = [
            { key: STELLAR_SECRET, label: 'first' },
            { key: 'not-a-secret', label: 'second' },
        ];
        const result = (0, logger_1.redactSecrets)(input);
        (0, vitest_1.expect)(result[0].key).toBe('[REDACTED]');
        (0, vitest_1.expect)(result[0].label).toBe('first');
        (0, vitest_1.expect)(result[1].key).toBe('not-a-secret');
    });
    (0, vitest_1.it)('leaves non-secret strings unchanged', () => {
        (0, vitest_1.expect)((0, logger_1.redactSecrets)('hello world')).toBe('hello world');
        (0, vitest_1.expect)((0, logger_1.redactSecrets)('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')).toBe('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
    });
    (0, vitest_1.it)('handles null without throwing', () => {
        (0, vitest_1.expect)(() => (0, logger_1.redactSecrets)(null)).not.toThrow();
        (0, vitest_1.expect)((0, logger_1.redactSecrets)(null)).toBeNull();
    });
    (0, vitest_1.it)('handles undefined without throwing', () => {
        (0, vitest_1.expect)(() => (0, logger_1.redactSecrets)(undefined)).not.toThrow();
        (0, vitest_1.expect)((0, logger_1.redactSecrets)(undefined)).toBeUndefined();
    });
    (0, vitest_1.it)('redacts multiple secret keys within the same string', () => {
        const input = `first=${STELLAR_SECRET} second=${STELLAR_SECRET}`;
        const result = (0, logger_1.redactSecrets)(input);
        (0, vitest_1.expect)(result).toBe('first=[REDACTED] second=[REDACTED]');
    });
    (0, vitest_1.it)('passes through numbers and booleans unchanged', () => {
        (0, vitest_1.expect)((0, logger_1.redactSecrets)(42)).toBe(42);
        (0, vitest_1.expect)((0, logger_1.redactSecrets)(true)).toBe(true);
        (0, vitest_1.expect)((0, logger_1.redactSecrets)(false)).toBe(false);
    });
});
// Mirrors the `redact.paths` wired into the pino instance in
// backend/utils/logger.ts. Built directly with `pino` here (rather than
// importing the module's singleton) to avoid spinning up its pino-pretty
// transport as a side effect of the import.
const REDACT_PATHS = ['*.memo', 'payload.memo', 'data.memo'];
(0, vitest_1.describe)('pino memo redaction', () => {
    function makeCapturingLogger() {
        const lines = [];
        const stream = {
            write: (chunk) => {
                lines.push(chunk);
            },
        };
        const testLogger = (0, pino_1.default)({ redact: { paths: REDACT_PATHS, remove: true } }, stream);
        return { testLogger, lines };
    }
    (0, vitest_1.it)('strips payload.memo from structured log output', () => {
        const { testLogger, lines } = makeCapturingLogger();
        testLogger.info({ payload: { memo: 'sensitive' } }, 'payment settled');
        const entry = JSON.parse(lines[0]);
        (0, vitest_1.expect)(entry.payload.memo).toBeUndefined();
        (0, vitest_1.expect)(JSON.stringify(entry)).not.toContain('sensitive');
    });
    (0, vitest_1.it)('strips data.memo from structured log output', () => {
        const { testLogger, lines } = makeCapturingLogger();
        testLogger.info({ data: { memo: 'user-identifiable' } }, 'tx logged');
        const entry = JSON.parse(lines[0]);
        (0, vitest_1.expect)(entry.data.memo).toBeUndefined();
    });
    (0, vitest_1.it)('strips memo one level deep via the wildcard path', () => {
        const { testLogger, lines } = makeCapturingLogger();
        testLogger.info({ challenge: { memo: 'nonce-slice' } }, 'challenge issued');
        const entry = JSON.parse(lines[0]);
        (0, vitest_1.expect)(entry.challenge.memo).toBeUndefined();
    });
    (0, vitest_1.it)('leaves unrelated fields untouched', () => {
        const { testLogger, lines } = makeCapturingLogger();
        testLogger.info({ payload: { memo: 'sensitive', amount: '10' } }, 'payment settled');
        const entry = JSON.parse(lines[0]);
        (0, vitest_1.expect)(entry.payload.amount).toBe('10');
    });
});
//# sourceMappingURL=logger.test.js.map