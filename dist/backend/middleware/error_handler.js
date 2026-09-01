"use strict";
/**
 * backend/middleware/error_handler.ts
 * Centralised error handler. Converts ZodError instances and StructuredError
 * subclasses into structured JSON payloads, mapping each error type onto the
 * HTTP status code that describes it. Register this after all route handlers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleError = handleError;
const zod_1 = require("zod");
const errors_1 = require("../errors");
/**
 * HTTP status for each structured error type. Anything absent - contract
 * failures, transaction failures, config problems, unknown errors - is a
 * server-side fault and stays 500.
 */
const STATUS_BY_ERROR_TYPE = {
    [errors_1.ErrorType.ValidationError]: 400,
    [errors_1.ErrorType.UnauthorizedError]: 401,
    [errors_1.ErrorType.RateLimitError]: 429,
    [errors_1.ErrorType.NetworkTimeout]: 503,
};
/** Seconds a rate-limited caller should wait when the error carries no hint. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;
function mapZodIssues(issues) {
    return issues.map((issue) => ({
        field: issue.path.length > 0 ? issue.path.join('.') : 'root',
        message: issue.message,
        code: issue.code,
    }));
}
/**
 * Converts any caught error into a structured ErrorResponse.
 * Stack traces are never included in the returned payload.
 */
function handleError(err) {
    if (err instanceof zod_1.ZodError) {
        return {
            status: 400,
            type: 'ValidationError',
            details: mapZodIssues(err.issues),
        };
    }
    if (err instanceof errors_1.StructuredError) {
        const status = STATUS_BY_ERROR_TYPE[err.errorType] ?? 500;
        const response = {
            status,
            type: err.name,
            details: [
                {
                    field: 'root',
                    // 5xx responses stay generic: an internal fault must not leak its
                    // message to the caller. Client-side errors describe themselves.
                    message: status >= 500 ? 'An unexpected error occurred' : err.message,
                    code: err.errorType,
                },
            ],
        };
        if (err instanceof errors_1.RateLimitError) {
            const retryAfter = err.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
            response.headers = { 'Retry-After': String(retryAfter) };
        }
        return response;
    }
    return {
        status: 500,
        type: 'InternalServerError',
        details: [
            {
                field: 'unknown',
                message: 'An unexpected error occurred',
                code: 'internal_error',
            },
        ],
    };
}
//# sourceMappingURL=error_handler.js.map