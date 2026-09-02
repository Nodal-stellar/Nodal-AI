/**
 * tests/fuzz/payment_schema.test.ts
 *
 * Property-based fuzz tests for StellarPaymentTool's amount Zod schema.
 *
 * Issue #445: Generate 500+ random amount strings per run and assert that:
 *   - Negative amounts are rejected
 *   - Zero (and zero-equivalent decimals) are rejected
 *   - Amounts above AGENT_SPENDING_LIMIT are rejected by the agent guard
 *   - Valid positive amounts within the limit are accepted
 *
 * Uses Math.random() only — no external property-based libraries required.
 */
export {};
//# sourceMappingURL=payment_schema.test.d.ts.map