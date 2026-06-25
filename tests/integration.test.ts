/**
 * tests/integration.test.ts
 *
 * Integration smoke tests for PayFiAgent — exercises the full task dispatch chain
 * with mocked RPC layer only (not individual tools).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PayFiAgent } from "../backend/agent";

// Hoist constants so they are available inside vi.mock() factories (which are hoisted)
const { AGENT_PUBKEY, AGENT_SECRET } = vi.hoisted(() => ({
  AGENT_PUBKEY: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  AGENT_SECRET: "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73",
}));

vi.mock("../backend/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  generateCorrelationId: vi.fn(() => "mock-correlation-id"),
}));

vi.mock("../backend/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── Full account mock that satisfies TransactionBuilder ─────────────────────

function makeMockAccount(publicKey: string) {
  return {
    id: publicKey,
    accountId: () => publicKey,
    sequenceNumber: () => "100",
    incrementSequenceNumber: vi.fn(),
    sequence: "100",
    incrementedSequenceNumber: () => "101",
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    balances: [{ asset_type: "native", balance: "10000.0000000" }],
    signers: [],
    data_attr: {},
    subentry_count: 0,
    home_domain: "",
    inflation_dest: null,
  };
}

// Mock only the RPC layer — tools run with real logic against mocked network calls
vi.mock("../backend/rpc_client", () => ({
  loadAccount: vi.fn().mockImplementation((pubkey: string) =>
    Promise.resolve(makeMockAccount(pubkey ?? AGENT_PUBKEY))
  ),
  resolveNetworkPassphrase: vi.fn().mockImplementation(
    () => "Test SDF Network ; September 2015"
  ),
  // Horizon returns { hash, ledger } (not txHash)
  submitTransaction: vi.fn().mockResolvedValue({
    hash: "test_tx_hash_123456789",
    ledger: 1000,
  }),
  prepareSorobanTx: vi.fn().mockResolvedValue({
    sign: vi.fn(),
    signatures: [{ hint: Buffer.alloc(4), signature: Buffer.alloc(64) }],
  }),
  horizonServer: { fetchBaseFee: vi.fn().mockResolvedValue(100) },
  sorobanServer: {
    sendTransaction: vi.fn().mockResolvedValue({
      hash: "soroban_tx_hash_123456789",
      status: "PENDING",
    }),
    getTransaction: vi.fn().mockResolvedValue({ status: "SUCCESS" }),
  },
}));

vi.mock("../backend/config", () => ({
  config: {
    STELLAR_NETWORK: "testnet",
    HORIZON_URL: "https://horizon-testnet.stellar.org",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    AGENT_PUBLIC_KEY: AGENT_PUBKEY,
    X402_ASSET_CODE: "USDC",
    X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    AGENT_SPENDING_LIMIT: "1000",
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
    agentKeypair: () => ({
      publicKey: () => AGENT_PUBKEY,
      secret: () => AGENT_SECRET,
    }),
  },
  MAINNET_SPENDING_CAP: 10000,
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PayFiAgent integration", () => {
  let agent: PayFiAgent;
  const DEST   = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-apply mock implementations after clearAllMocks resets them
    const rpc = await import("../backend/rpc_client");
    vi.mocked(rpc.loadAccount).mockImplementation((pubkey: string) =>
      Promise.resolve(makeMockAccount(pubkey ?? AGENT_PUBKEY))
    );
    vi.mocked(rpc.resolveNetworkPassphrase).mockImplementation(
      () => "Test SDF Network ; September 2015"
    );
    vi.mocked(rpc.submitTransaction).mockResolvedValue({
      hash: "test_tx_hash_123456789",
      ledger: 1000,
    } as any);
    vi.mocked(rpc.prepareSorobanTx).mockResolvedValue({
      sign: vi.fn(),
      signatures: [{ hint: Buffer.alloc(4), signature: Buffer.alloc(64) }],
    } as any);
    vi.mocked(rpc.sorobanServer.sendTransaction as any).mockResolvedValue({
      hash: "soroban_tx_hash_123456789",
      status: "PENDING",
    });
    vi.mocked(rpc.sorobanServer.getTransaction as any).mockResolvedValue({
      status: "SUCCESS",
    });
    agent = new PayFiAgent();
  });

  it("executes stellar_payment task with full tool chain", async () => {
    const { loadAccount, submitTransaction } = await import("../backend/rpc_client");

    const result = await agent.run({
      type: "stellar_payment",
      payload: { destination: DEST, amount: "100", assetCode: "USDC", assetIssuer: ISSUER },
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("txHash", "test_tx_hash_123456789");
    expect(loadAccount).toHaveBeenCalled();
    expect(submitTransaction).toHaveBeenCalled();
  });

  it("executes soroban_invoke task with full chain", async () => {
    const { prepareSorobanTx } = await import("../backend/rpc_client");

    const result = await agent.run({
      type: "soroban_invoke",
      payload: {
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        method: "test_method",
        args: [],
      },
    });

    expect(result.success).toBe(true);
    expect(prepareSorobanTx).toHaveBeenCalled();
  });

  it("executes x402_respond task with full chain", async () => {
    const { submitTransaction } = await import("../backend/rpc_client");

    const challenge = {
      resource: "https://example.com/resource",
      amount: "50",
      assetCode: "USDC",
      assetIssuer: ISSUER,
      payTo: DEST,
      nonce: "550e8400-e29b-41d4-a716-446655440000",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };

    const result = await agent.run({
      type: "x402_respond",
      payload: challenge,
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("protocol", "x402");
    expect(submitTransaction).toHaveBeenCalled();
  });
});
