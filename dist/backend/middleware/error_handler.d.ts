/**
 * backend/middleware/error_handler.ts
 * Centralised error handler. Converts ZodError instances and StructuredError
 * subclasses into structured JSON payloads, mapping each error type onto the
 * HTTP status code that describes it. Register this after all route handlers.
 */
export interface ErrorDetail {
    field: string;
    message: string;
    code: string;
}
export interface ErrorResponse {
    status: number;
    type: string;
    details: ErrorDetail[];
    /** Extra response headers the caller should emit (e.g. Retry-After on 429). */
    headers?: Record<string, string>;
}
/**
 * Converts any caught error into a structured ErrorResponse.
 * Stack traces are never included in the returned payload.
 */
export declare function handleError(err: unknown): ErrorResponse;
//# sourceMappingURL=error_handler.d.ts.map