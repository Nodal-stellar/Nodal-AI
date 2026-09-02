/**
 * tests/payment.test.ts
 *
 * Comprehensive test suite for StellarPaymentTool.
 * Covers: happy path, input validation, network errors, retry exhaustion,
 * timeout simulation, insufficient funds, and memo edge cases.
 *
 * Network mocking is centralised in the shared MockHorizonServer fixture
 * (tests/fixtures/MockHorizonServer.ts); see createMockHorizonServer() for
 * the full API. The fixture is created inside the async vi.mock factory below
 * because vi.mock factories are hoisted above imports and therefore cannot
 * reference top-level bindings directly.
 */
export {};
//# sourceMappingURL=payment.test.d.ts.map