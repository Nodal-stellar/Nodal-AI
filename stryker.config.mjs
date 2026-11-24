/**
 * stryker.config.mjs
 *
 * Stryker mutation-testing configuration.
 * Targets the security-critical files: backend/agent.ts,
 * backend/tools/X402PaymentTool.ts and backend/spending_tracker.ts.
 *
 * Run: npm run test:mutation
 *
 * Issue: #456
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  /** Use the vitest runner so mutations are tested inside the existing suite. */
  testRunner: "vitest",

  /** Only mutate the security-critical targeted files. */
  mutate: [
    "backend/agent.ts",
    "backend/tools/X402PaymentTool.ts",
    "backend/spending_tracker.ts",
  ],

  /**
   * Run the tests most likely to catch mutations in agent.ts,
   * X402PaymentTool.ts and spending_tracker.ts first (improves performance
   * via test filtering).
   */
  vitest: {
    configFile: "vitest.config.ts",
  },

  /** Reporters: clear-text for CI, HTML for local inspection. */
  reporters: ["clear-text", "html"],

  /**
   * Enforce a minimum mutation score of 70 % for the security-critical files.
   * Stryker will exit with a non-zero code if the score falls below this.
   */
  thresholds: {
    high: 80,
    low: 70,
    break: 70,
  },

  /**
   * TypeScript source maps let Stryker map mutations back to .ts lines.
   * The project already emits source maps via tsconfig.json.
   */
  coverageAnalysis: "perTest",

  /** Keep the temp sandbox in a predictable location for debugging. */
  tempDirName: ".stryker-tmp",

  /** Concurrency: use half available CPUs to avoid OOM in CI. */
  concurrency: 2,
};
