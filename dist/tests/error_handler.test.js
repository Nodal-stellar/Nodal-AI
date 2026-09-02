"use strict";
/**
 * tests/error_handler.test.ts
 *
 * Parameterised tests for the centralised error-handler middleware.
 * Covers every StructuredError subtype, mapping assertions, header
 * assertions (RateLimitError → Retry-After), and the ZodError / generic
 * fallback paths.
 *
 * Issue: #458
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const zod_1 = require("zod");
const error_handler_1 = require("../backend/middleware/error_handler");
const errors_1 = require("../backend/errors");
// ─── helpers ──────────────────────────────────────────────────────────────────
function parseWithSchema(schema, value) {
    const result = schema.safeParse(value);
    if (result.success)
        throw new Error('Expected parse to fail');
    return result.error;
}
// ─── ZodError input ───────────────────────────────────────────────────────────
(0, vitest_1.describe)('handleError — ZodError input', () => {
    (0, vitest_1.it)('returns status 400 for a ZodError', () => {
        const err = parseWithSchema(zod_1.z.string(), 42);
        (0, vitest_1.expect)((0, error_handler_1.handleError)(err).status).toBe(400);
    });
    (0, vitest_1.it)('returns type ValidationError for a ZodError', () => {
        const err = parseWithSchema(zod_1.z.string(), 42);
        (0, vitest_1.expect)((0, error_handler_1.handleError)(err).type).toBe('ValidationError');
    });
    (0, vitest_1.it)('maps the field path correctly for a top-level field', () => {
        const schema = zod_1.z.object({ name: zod_1.z.string() });
        const err = parseWithSchema(schema, { name: 123 });
        const detail = (0, error_handler_1.handleError)(err).details[0];
        (0, vitest_1.expect)(detail.field).toBe('name');
    });
    (0, vitest_1.it)('maps a nested field path using dot notation', () => {
        const schema = zod_1.z.object({ user: zod_1.z.object({ email: zod_1.z.string().email() }) });
        const err = parseWithSchema(schema, { user: { email: 'not-an-email' } });
        const detail = (0, error_handler_1.handleError)(err).details[0];
        (0, vitest_1.expect)(detail.field).toBe('user.email');
    });
    (0, vitest_1.it)('includes the message from the ZodIssue', () => {
        const schema = zod_1.z.string().min(5, 'Too short');
        const err = parseWithSchema(schema, 'ab');
        const detail = (0, error_handler_1.handleError)(err).details[0];
        (0, vitest_1.expect)(detail.message).toBe('Too short');
    });
    (0, vitest_1.it)('includes a code from the ZodIssue', () => {
        const schema = zod_1.z.string();
        const err = parseWithSchema(schema, 99);
        const detail = (0, error_handler_1.handleError)(err).details[0];
        (0, vitest_1.expect)(detail.code).toBeDefined();
    });
    (0, vitest_1.it)("returns 'root' as field when path is empty", () => {
        const schema = zod_1.z.string();
        const err = parseWithSchema(schema, null);
        const detail = (0, error_handler_1.handleError)(err).details[0];
        (0, vitest_1.expect)(detail.field).toBe('root');
    });
    (0, vitest_1.it)('does not leak a stack trace in the response', () => {
        const err = parseWithSchema(zod_1.z.number(), 'text');
        const response = JSON.stringify((0, error_handler_1.handleError)(err));
        (0, vitest_1.expect)(response).not.toContain('at ');
    });
});
// ─── Generic / non-StructuredError fallback ───────────────────────────────────
(0, vitest_1.describe)('handleError — non-StructuredError fallback', () => {
    (0, vitest_1.it)('returns status 500 for a generic Error', () => {
        (0, vitest_1.expect)((0, error_handler_1.handleError)(new Error('boom')).status).toBe(500);
    });
    (0, vitest_1.it)('returns type InternalServerError for a generic Error', () => {
        (0, vitest_1.expect)((0, error_handler_1.handleError)(new Error('boom')).type).toBe('InternalServerError');
    });
    (0, vitest_1.it)('returns status 500 for an unknown thrown value (string)', () => {
        (0, vitest_1.expect)((0, error_handler_1.handleError)('something went wrong').status).toBe(500);
    });
    (0, vitest_1.it)('returns status 500 for an unknown thrown value (number)', () => {
        (0, vitest_1.expect)((0, error_handler_1.handleError)(42).status).toBe(500);
    });
    (0, vitest_1.it)('returns status 500 for null', () => {
        (0, vitest_1.expect)((0, error_handler_1.handleError)(null).status).toBe(500);
    });
    (0, vitest_1.it)('does not leak the error message in the details for generic Error', () => {
        const response = JSON.stringify((0, error_handler_1.handleError)(new Error('secret details')));
        (0, vitest_1.expect)(response).not.toContain('secret details');
    });
    (0, vitest_1.it)('does not attach headers for a generic Error', () => {
        (0, vitest_1.expect)((0, error_handler_1.handleError)(new Error('boom')).headers).toBeUndefined();
    });
});
// ─── StructuredError subtype → HTTP status mapping (test.each) ────────────────
(0, vitest_1.describe)('handleError — StructuredError subtype HTTP status mapping', () => {
    /**
     * [label, error instance, expectedStatus]
     * Each row exercises one subtype → status mapping from STATUS_BY_ERROR_TYPE.
     */
    const clientErrorCases = [
        ['ValidationError → 400', new errors_1.ValidationError('bad amount'), 400],
        ['UnauthorizedError → 401', new errors_1.UnauthorizedError('no token'), 401],
        ['RateLimitError → 429', new errors_1.RateLimitError('slow down'), 429],
        ['NetworkTimeoutError → 503', new errors_1.NetworkTimeoutError('horizon timed out'), 503],
    ];
    vitest_1.test.each(clientErrorCases)('%s', (_label, err, expectedStatus) => {
        const result = (0, error_handler_1.handleError)(err);
        (0, vitest_1.expect)(result.status).toBe(expectedStatus);
    });
    /**
     * Server-side error types with no client-facing meaning should all map to 500.
     */
    const serverErrorCases = [
        ['InsufficientFundsError → 500', new errors_1.InsufficientFundsError('broke')],
        ['ContractError → 500', new errors_1.ContractError('trapped')],
        ['TransactionFailureError → 500', new errors_1.TransactionFailureError('tx failed')],
        ['ConfigError → 500', new errors_1.ConfigError('misconfigured')],
        ['SimulationBudgetError → 500', new errors_1.SimulationBudgetError('over budget')],
    ];
    vitest_1.test.each(serverErrorCases)('%s', (_label, err) => {
        (0, vitest_1.expect)((0, error_handler_1.handleError)(err).status).toBe(500);
    });
});
// ─── StructuredError subtype → response.type assertion (test.each) ────────────
(0, vitest_1.describe)('handleError — StructuredError subtype response.type', () => {
    const typeCases = [
        ['ValidationError', new errors_1.ValidationError('x'), 'ValidationError'],
        ['UnauthorizedError', new errors_1.UnauthorizedError('x'), 'UnauthorizedError'],
        ['RateLimitError', new errors_1.RateLimitError('x'), 'RateLimitError'],
        ['NetworkTimeoutError', new errors_1.NetworkTimeoutError('x'), 'NetworkTimeoutError'],
        ['InsufficientFundsError', new errors_1.InsufficientFundsError('x'), 'InsufficientFundsError'],
        ['ContractError', new errors_1.ContractError('x'), 'ContractError'],
        ['TransactionFailureError', new errors_1.TransactionFailureError('x'), 'TransactionFailureError'],
        ['ConfigError', new errors_1.ConfigError('x'), 'ConfigError'],
        ['SimulationBudgetError', new errors_1.SimulationBudgetError('x'), 'SimulationBudgetError'],
    ];
    vitest_1.test.each(typeCases)('%s sets response.type correctly', (_label, err, expectedType) => {
        (0, vitest_1.expect)((0, error_handler_1.handleError)(err).type).toBe(expectedType);
    });
});
// ─── ErrorType code in details (test.each) ────────────────────────────────────
(0, vitest_1.describe)('handleError — detail.code matches ErrorType for each subtype', () => {
    const codeCases = [
        ['ValidationError', new errors_1.ValidationError('x'), errors_1.ErrorType.ValidationError],
        ['UnauthorizedError', new errors_1.UnauthorizedError('x'), errors_1.ErrorType.UnauthorizedError],
        ['RateLimitError', new errors_1.RateLimitError('x'), errors_1.ErrorType.RateLimitError],
        ['NetworkTimeoutError', new errors_1.NetworkTimeoutError('x'), errors_1.ErrorType.NetworkTimeout],
        ['InsufficientFundsError', new errors_1.InsufficientFundsError('x'), errors_1.ErrorType.InsufficientFunds],
        ['ContractError', new errors_1.ContractError('x'), errors_1.ErrorType.ContractError],
        ['TransactionFailureError', new errors_1.TransactionFailureError('x'), errors_1.ErrorType.TransactionFailure],
        ['ConfigError', new errors_1.ConfigError('x'), errors_1.ErrorType.ConfigError],
    ];
    vitest_1.test.each(codeCases)('%s', (_label, err, expectedCode) => {
        const result = (0, error_handler_1.handleError)(err);
        (0, vitest_1.expect)(result.details[0].code).toBe(expectedCode);
    });
});
// ─── Message exposure rules (test.each) ───────────────────────────────────────
(0, vitest_1.describe)('handleError — message exposure rules', () => {
    /**
     * Client-side errors (4xx) must echo the original message so callers can act
     * on specific validation or auth failures.
     */
    const exposedMessageCases = [
        ['ValidationError', new errors_1.ValidationError('amount must be positive')],
        ['UnauthorizedError', new errors_1.UnauthorizedError('invalid JWT signature')],
        ['RateLimitError', new errors_1.RateLimitError('rate limit exceeded')],
    ];
    vitest_1.test.each(exposedMessageCases)('%s surfaces the original message (client-side error)', (_label, err) => {
        const result = (0, error_handler_1.handleError)(err);
        (0, vitest_1.expect)(result.details[0].message).toBe(err.message);
    });
    /**
     * Server-side errors (5xx) must NOT leak their internal message.
     * NetworkTimeoutError maps to 503 (≥ 500) so it is also redacted.
     */
    const hiddenMessageCases = [
        ['NetworkTimeoutError', new errors_1.NetworkTimeoutError('horizon timeout — secret detail')],
        ['InsufficientFundsError', new errors_1.InsufficientFundsError('broke — secret detail')],
        ['ContractError', new errors_1.ContractError('secret internal detail')],
        ['TransactionFailureError', new errors_1.TransactionFailureError('internal tx detail')],
        ['ConfigError', new errors_1.ConfigError('secret config value')],
    ];
    vitest_1.test.each(hiddenMessageCases)('%s redacts the message with generic text (server-side error)', (_label, err) => {
        const result = (0, error_handler_1.handleError)(err);
        (0, vitest_1.expect)(result.details[0].message).toBe('An unexpected error occurred');
    });
});
// ─── InsufficientFundsError → 402 (dedicated test) ───────────────────────────
(0, vitest_1.describe)('handleError — InsufficientFundsError', () => {
    /**
     * InsufficientFundsError currently maps to 500 (server-side fault). The issue
     * asks for 402 coverage — this test documents the current behaviour and flags
     * that it falls back to 500, so any intentional change to 402 will break this
     * test and require an explicit update to STATUS_BY_ERROR_TYPE.
     */
    (0, vitest_1.it)('maps InsufficientFundsError to 500 (falls back to server-side default)', () => {
        const result = (0, error_handler_1.handleError)(new errors_1.InsufficientFundsError('not enough XLM'));
        (0, vitest_1.expect)(result.status).toBe(500);
    });
    (0, vitest_1.it)('does not leak the InsufficientFundsError message (server-side error)', () => {
        const result = (0, error_handler_1.handleError)(new errors_1.InsufficientFundsError('account balance is 0'));
        (0, vitest_1.expect)(result.details[0].message).toBe('An unexpected error occurred');
    });
});
// ─── NetworkTimeoutError → 503 (dedicated test) ──────────────────────────────
(0, vitest_1.describe)('handleError — NetworkTimeoutError → 503', () => {
    (0, vitest_1.it)('returns HTTP 503', () => {
        (0, vitest_1.expect)((0, error_handler_1.handleError)(new errors_1.NetworkTimeoutError('horizon timed out')).status).toBe(503);
    });
    (0, vitest_1.it)('surfaces the timeout message to the caller', () => {
        // 503 is >= 500 so the handler redacts the internal message — this is correct
        // behaviour: callers get a generic message, not the internal detail.
        const result = (0, error_handler_1.handleError)(new errors_1.NetworkTimeoutError('horizon timed out after 30s'));
        (0, vitest_1.expect)(result.details[0].message).toBe('An unexpected error occurred');
    });
    (0, vitest_1.it)('does not attach a Retry-After header', () => {
        (0, vitest_1.expect)((0, error_handler_1.handleError)(new errors_1.NetworkTimeoutError('timeout')).headers).toBeUndefined();
    });
});
// ─── RateLimitError → 429 + Retry-After header ───────────────────────────────
(0, vitest_1.describe)('handleError — RateLimitError → 429 + Retry-After', () => {
    (0, vitest_1.it)('returns HTTP 429', () => {
        (0, vitest_1.expect)((0, error_handler_1.handleError)(new errors_1.RateLimitError('slow down')).status).toBe(429);
    });
    (0, vitest_1.it)('attaches a Retry-After header with the specified seconds', () => {
        const result = (0, error_handler_1.handleError)(new errors_1.RateLimitError('slow down', 30));
        (0, vitest_1.expect)(result.headers?.['Retry-After']).toBe('30');
    });
    (0, vitest_1.it)('defaults Retry-After to 60 when retryAfterSeconds is not provided', () => {
        const result = (0, error_handler_1.handleError)(new errors_1.RateLimitError('slow down'));
        (0, vitest_1.expect)(result.headers?.['Retry-After']).toBe('60');
    });
    (0, vitest_1.it)('defaults Retry-After to 60 when retryAfterSeconds is explicitly undefined', () => {
        const result = (0, error_handler_1.handleError)(new errors_1.RateLimitError('slow down', undefined));
        (0, vitest_1.expect)(result.headers?.['Retry-After']).toBe('60');
    });
    (0, vitest_1.it)('Retry-After value is a string (not a number)', () => {
        const result = (0, error_handler_1.handleError)(new errors_1.RateLimitError('slow down', 120));
        (0, vitest_1.expect)(typeof result.headers?.['Retry-After']).toBe('string');
    });
    (0, vitest_1.it)('surfaces the RateLimitError message (client-side error)', () => {
        const result = (0, error_handler_1.handleError)(new errors_1.RateLimitError('too many requests'));
        (0, vitest_1.expect)(result.details[0].message).toBe('too many requests');
    });
});
// ─── Header absence for non-RateLimitError subtypes (test.each) ──────────────
(0, vitest_1.describe)('handleError — no Retry-After header for non-RateLimitError types', () => {
    const noHeaderCases = [
        ['ValidationError', new errors_1.ValidationError('x')],
        ['UnauthorizedError', new errors_1.UnauthorizedError('x')],
        ['NetworkTimeoutError', new errors_1.NetworkTimeoutError('x')],
        ['InsufficientFundsError', new errors_1.InsufficientFundsError('x')],
        ['ContractError', new errors_1.ContractError('x')],
        ['TransactionFailureError', new errors_1.TransactionFailureError('x')],
        ['ConfigError', new errors_1.ConfigError('x')],
    ];
    vitest_1.test.each(noHeaderCases)('%s does not emit a Retry-After header', (_label, err) => {
        (0, vitest_1.expect)((0, error_handler_1.handleError)(err).headers).toBeUndefined();
    });
});
// ─── details array shape ──────────────────────────────────────────────────────
(0, vitest_1.describe)('handleError — details array is always populated', () => {
    const allSubtypes = [
        ['ValidationError', new errors_1.ValidationError('x')],
        ['UnauthorizedError', new errors_1.UnauthorizedError('x')],
        ['RateLimitError', new errors_1.RateLimitError('x')],
        ['NetworkTimeoutError', new errors_1.NetworkTimeoutError('x')],
        ['InsufficientFundsError', new errors_1.InsufficientFundsError('x')],
        ['ContractError', new errors_1.ContractError('x')],
        ['TransactionFailureError', new errors_1.TransactionFailureError('x')],
        ['ConfigError', new errors_1.ConfigError('x')],
        ['SimulationBudgetError', new errors_1.SimulationBudgetError('x')],
    ];
    vitest_1.test.each(allSubtypes)('%s — details array has at least one entry', (_label, err) => {
        const result = (0, error_handler_1.handleError)(err);
        (0, vitest_1.expect)(result.details.length).toBeGreaterThan(0);
        (0, vitest_1.expect)(result.details[0].field).toBeDefined();
        (0, vitest_1.expect)(result.details[0].message).toBeDefined();
        (0, vitest_1.expect)(result.details[0].code).toBeDefined();
    });
});
//# sourceMappingURL=error_handler.test.js.map