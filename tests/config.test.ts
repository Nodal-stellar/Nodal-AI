/**
 * tests/config.test.ts
 *
 * Tests for:
 *   - config.ts startup validation (AGENT_SECRET_KEY_ARN, mutual exclusion, bad secrets)
 *   - formatValidationErrors (redaction of secret keys in both message and path fields)
 *
 * ## Why vi.hoisted()?
 *
 * config.ts calls loadConfig() at module-level (singleton pattern), which means
 * process.exit(1) can be triggered the moment the module is first imported — before
 * any beforeEach spy setup runs. vi.hoisted() lifts the mock setup above all imports
 * so the spy is in place when the module is first evaluated.
 *
 * The formatValidationErrors describe block imports the function via dynamic
 * import inside a beforeAll to avoid triggering loadConfig() at collection time
 * (static top-level imports are resolved before any test setup can run).
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { z } from "zod";

// ── Hoist process.exit mock so it is active before config.ts is evaluated ────
const { mockExit } = vi.hoisted(() => {
  const mockExit = vi.fn((code?: number) => {
    throw new Error(`process.exit: ${code}`);
  });
  vi.stubGlobal("process", {
    ...process,
    exit: mockExit,
    stderr: { write: vi.fn(() => true) },
    stdout: { write: vi.fn(() => true) },
  });
  return { mockExit };
});

// ── Mock child_process ────────────────────────────────────────────────────────
vi.mock("child_process", async () => {
  const original = await vi.importActual<any>("child_process");
  return { ...original, execSync: vi.fn() };
});

// ─────────────────────────────────────────────────────────────────────────────

describe("config.ts startup validation", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.resetModules();
    originalEnv = { ...process.env };
    // Re-apply process mocks after resetModules clears them
    vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`process.exit: ${code}`);
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("fails if both AGENT_SECRET_KEY and AGENT_SECRET_KEY_ARN are set", async () => {
    process.env.AGENT_SECRET_KEY = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";
    process.env.AGENT_SECRET_KEY_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret";

    await expect(async () => {
      await import("../backend/config");
    }).rejects.toThrow("process.exit: 1");

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("Cannot specify both AGENT_SECRET_KEY and AGENT_SECRET_KEY_ARN"),
    );
  });

  it("fetches the secret using Secrets Manager command when AGENT_SECRET_KEY_ARN is set", async () => {
    const validSecret = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";
    process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
    process.env.X402_ASSET_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    delete process.env.AGENT_SECRET_KEY;
    process.env.AGENT_SECRET_KEY_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret";

    const { execSync } = await import("child_process");
    vi.mocked(execSync).mockReturnValue(Buffer.from(validSecret));

    const { config } = await import("../backend/config");

    expect(execSync).toHaveBeenCalled();
    expect(config.AGENT_PUBLIC_KEY).toBe("GDRIFTCEWUMA5IM6NUQPLA27YPHDMUNMPDXCQWCD3BRPVKMPX5KEM5F5");
    expect(config.agentKeypair().secret()).toBe(validSecret);
  });

  it("supports JSON structured Secrets Manager response", async () => {
    const validSecret = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";
    const jsonSecret = JSON.stringify({ AGENT_SECRET_KEY: validSecret });
    process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
    process.env.X402_ASSET_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    delete process.env.AGENT_SECRET_KEY;
    process.env.AGENT_SECRET_KEY_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret";

    const { execSync } = await import("child_process");
    vi.mocked(execSync).mockReturnValue(Buffer.from(jsonSecret));

    const { config } = await import("../backend/config");
    expect(config.agentKeypair().secret()).toBe(validSecret);
  });

  it("fails validation if fetched secret is not a valid Stellar key", async () => {
    process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
    process.env.X402_ASSET_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    delete process.env.AGENT_SECRET_KEY;
    process.env.AGENT_SECRET_KEY_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret";

    const { execSync } = await import("child_process");
    vi.mocked(execSync).mockReturnValue(Buffer.from("invalid-secret"));

    await expect(async () => {
      await import("../backend/config");
    }).rejects.toThrow("process.exit: 1");

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("AGENT_SECRET_KEY is not a valid Stellar secret key"),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatValidationErrors tests
// Uses dynamic import inside beforeAll so config.ts module-level code doesn't
// execute at collection time (which would call process.exit before any mock).
// ─────────────────────────────────────────────────────────────────────────────

describe("formatValidationErrors", () => {
  let formatValidationErrors: (errors: z.ZodError) => string;

  beforeAll(async () => {
    vi.resetModules();
    // Ensure process.exit is mocked before config module loads
    vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`process.exit: ${code}`);
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    // Provide minimal valid env so loadConfig() succeeds
    process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
    process.env.AGENT_SECRET_KEY = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";
    process.env.X402_ASSET_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

    const mod = await import("../backend/config");
    formatValidationErrors = mod.formatValidationErrors;
  });

  it("redacts a valid S-key in error message", () => {
    const error = new z.ZodError([
      {
        code: "custom",
        path: ["test_field"],
        message: "Invalid secret: SBVXQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT",
        fatal: false,
      },
    ]);
    const result = formatValidationErrors(error);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("SBVXQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT");
  });

  it("does not modify error message without S-key", () => {
    const error = new z.ZodError([
      {
        code: "custom",
        path: ["field"],
        message: "This is a normal error",
        fatal: false,
      },
    ]);
    const result = formatValidationErrors(error);
    expect(result).toContain("This is a normal error");
  });

  // ── Issue #98: path-field redaction ────────────────────────────────────────

  it("[#98] redacts S-key that appears as a path segment", () => {
    const error = new z.ZodError([
      {
        code: "custom",
        path: ["SBVXQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT"],
        message: "Invalid config",
        fatal: false,
      },
    ]);
    const result = formatValidationErrors(error);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("SBVXQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT");
  });

  it("[#98] redacts multiple S-keys in one message", () => {
    const error = new z.ZodError([
      {
        code: "custom",
        path: ["field"],
        message:
          "Key1: SBVXQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT and Key2: SBVXQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAY",
        fatal: false,
      },
    ]);
    const result = formatValidationErrors(error);
    expect(result.match(/\[REDACTED\]/g)).toHaveLength(2);
    expect(result).not.toContain("SBVXQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT");
  });

  it("[#98] redacts S-key in a mixed numeric+string path array", () => {
    const error = new z.ZodError([
      {
        code: "custom",
        path: [0, "SBVXQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT"],
        message: "Invalid config",
        fatal: false,
      },
    ]);
    const result = formatValidationErrors(error);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("SBVXQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT");
  });

  it("[#98] redacts S-key in both path and message simultaneously", () => {
    const secret = "SBVXQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT";
    const error = new z.ZodError([
      {
        code: "custom",
        path: [secret],
        message: `Received secret: ${secret}`,
        fatal: false,
      },
    ]);
    const result = formatValidationErrors(error);
    expect(result).not.toContain(secret);
    // Both the path occurrence and the message occurrence should be redacted
    expect(result.match(/\[REDACTED\]/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it("[#98] preserves normal path segments without secret keys", () => {
    const error = new z.ZodError([
      {
        code: "custom",
        path: ["config", "network", "url"],
        message: "Must be a valid URL",
        fatal: false,
      },
    ]);
    const result = formatValidationErrors(error);
    expect(result).toContain("config.network.url");
    expect(result).toContain("Must be a valid URL");
  });
});
