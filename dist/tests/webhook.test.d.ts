/**
 * tests/webhook.test.ts
 * Tests for dispatchWebhook: delivery, HMAC signature, retry, and no-op when unconfigured.
 *
 * Issue #448: HMAC signing implemented in backend/webhook.ts (X-Nodal-Signature header).
 * Tests verify:
 *   - Dispatched request includes X-Nodal-Signature with correct HMAC value
 *   - Signature can be independently verified with the shared secret
 *   - A tampered payload produces a detectable HMAC mismatch
 *   - Signature header is absent when WEBHOOK_SECRET is not configured
 */
export {};
//# sourceMappingURL=webhook.test.d.ts.map