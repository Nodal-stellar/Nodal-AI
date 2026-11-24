/**
 * tests/integration/approvals_flow.test.ts
 *
 * End-to-end integration test for the approval flow (issue #1003).
 *
 * Covers:
 *   - Over-threshold payment is held (not submitted) → appears in GET /approvals
 *   - Approve path  → executes exactly once, tx submitted
 *   - Double-approve → 409, still only one submission
 *   - Deny path     → 200, nothing submitted
 *   - Approve-after-deny → 409
 *   - Expiry path   → 409
 *   - Under-threshold → executes immediately (no hold)
 *   - Webhook fires with pendingApproval=true when held
 *   - Unknown ID    → 409
 *   - Bad action body → 400
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "http";
import Database from "better-sqlite3";
import { Account, Networks } from "@stellar/stellar-sdk";
import { PayFiAgent } from "../../backend/agent";
import { createHealthServer } from "../../backend/server";
import { InMemoryApprovalStore, approvalStore } from "../../backend/approval_store";
import { _setDb } from "../../backend/persistence";

// ─── Mocks ────────────────────────────────────────────────────────────────────
// vi.mock factories are hoisted before imports, so ALL values used inside must
// be literals or require() calls — no top-level const references allowed.

vi.mock("../../backend/rpc_client", () => ({
  loadAccount: vi.fn(), // implementation set per-test in beforeEach
  resolveNetworkPassphrase: vi.fn().mockReturnValue(
    "Test SDF Network ; September 2015",
  ),
  submitTransaction: vi.fn().mockResolvedValue({
    hash: "mock_tx_hash_approval_flow",
    ledger: 2000,
  }),
  prepareSorobanTx: vi.fn(),
  horizonServer: {},
  sorobanServer: {},
}));

vi.mock("../../backend/config", () => ({
  config: {
    STELLAR_NETWORK:      "testnet",
    HORIZON_URL:          "https://horizon-testnet.stellar.org",
    SOROBAN_RPC_URL:      "https://soroban-testnet.stellar.org",
    AGENT_PUBLIC_KEY:
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    X402_ASSET_CODE:      "USDC",
    X402_ASSET_ISSUER:
      "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    AGENT_SPENDING_LIMIT: "10000",
    APPROVAL_THRESHOLD:   "50",
    MAX_RETRIES:          3,
    RETRY_DELAY_MS:       50,
    MAX_CONCURRENT_TASKS: 10,
    WEBHOOK_URL:          undefined,
    WEBHOOK_SECRET:       undefined,
    agentKeypair: () => ({
      publicKey: () =>
        "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      secret: () =>
        "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73",
    }),
  },
  MAINNET_SPENDING_CAP: 10000,
}));

vi.mock("../../backend/webhook", () => ({
  dispatchWebhook: vi.fn().mockResolvedValue(undefined),
}));

// ─── Constants ────────────────────────────────────────────────────────────────

const AGENT_PUBKEY =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
// Use a destination that is NOT the agent public key (self-pay guard)
const DEST =
  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER =
  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePayload(amount: string) {
  return { destination: DEST, amount, assetCode: "USDC", assetIssuer: ISSUER };
}

function initMemDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_results (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     TEXT    NOT NULL,
      taskType      TEXT    NOT NULL,
      success       INTEGER NOT NULL,
      data          TEXT,
      error         TEXT,
      correlationId TEXT
    )
  `);
  return db;
}

function makeAccount() {
  return new Account(AGENT_PUBKEY, "100");
}

async function req(
  server: http.Server,
  method: string,
  path: string,
  body?: object,
): Promise<{ status: number; json: unknown }> {
  const { port } = server.address() as { port: number };
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload !== undefined && {
            "Content-Length": Buffer.byteLength(payload),
          }),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => { data += c.toString(); });
        res.on("end", () => {
          try   { resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode ?? 0, json: data }); }
        });
      },
    );
    r.on("error", reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("Approval flow integration (#1003)", () => {
  let agent:  PayFiAgent;
  let server: http.Server;
  const store = approvalStore as InMemoryApprovalStore;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Wire loadAccount to return a fresh real Account each call
    const rpc = await import("../../backend/rpc_client");
    vi.mocked(rpc.loadAccount).mockResolvedValue(makeAccount() as any);
    vi.mocked(rpc.submitTransaction).mockResolvedValue({
      hash: "mock_tx_hash_approval_flow",
      ledger: 2000,
    } as any);
    vi.mocked(rpc.resolveNetworkPassphrase).mockReturnValue(Networks.TESTNET);

    // Fresh in-memory DB with schema so saveResult never fails
    _setDb(initMemDb());
    // Reset approval store state between tests
    store.reset();

    agent  = new PayFiAgent();
    server = createHealthServer(agent);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
  });

  afterEach(async () => {
    agent.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  // 1 ── over-threshold task is held ─────────────────────────────────────────

  it("holds a payment exceeding the threshold instead of executing it", async () => {
    const { submitTransaction } = await import("../../backend/rpc_client");
    const result = await agent.run({
      type: "stellar_payment",
      payload: makePayload("100"),
    });

    expect(result.pendingApproval).toBe(true);
    expect(typeof result.approvalId).toBe("string");
    expect(result.success).toBe(false);
    expect(vi.mocked(submitTransaction)).not.toHaveBeenCalled();
  });

  // 2 ── GET /approvals lists pending task ───────────────────────────────────

  it("GET /approvals returns the held task as pending", async () => {
    await agent.run({ type: "stellar_payment", payload: makePayload("100") });

    const { status, json } = await req(server, "GET", "/approvals");
    expect(status).toBe(200);
    const body = json as { approvals: Array<{ status: string }> };
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]!.status).toBe("pending");
  });

  // 3 ── approve executes the task exactly once ──────────────────────────────

  it("approving a held task executes it exactly once and returns tx hash", async () => {
    const { submitTransaction } = await import("../../backend/rpc_client");
    const held = await agent.run({
      type: "stellar_payment",
      payload: makePayload("100"),
    });

    const { status, json } = await req(
      server, "POST", `/approvals/${held.approvalId}`, { action: "approve" },
    );

    expect(status).toBe(200);
    const body = json as { result: { success: boolean; data: { txHash: string } } };
    expect(body.result.success).toBe(true);
    expect(body.result.data.txHash).toBe("mock_tx_hash_approval_flow");
    expect(vi.mocked(submitTransaction)).toHaveBeenCalledTimes(1);
  });

  // 4 ── double-approve → 409, still one submission ──────────────────────────

  it("second approve on same ID returns 409 and does not submit again", async () => {
    const { submitTransaction } = await import("../../backend/rpc_client");
    const held = await agent.run({
      type: "stellar_payment",
      payload: makePayload("100"),
    });

    const first = await req(
      server, "POST", `/approvals/${held.approvalId}`, { action: "approve" },
    );
    expect(first.status).toBe(200);
    expect(vi.mocked(submitTransaction)).toHaveBeenCalledTimes(1);

    const second = await req(
      server, "POST", `/approvals/${held.approvalId}`, { action: "approve" },
    );
    expect(second.status).toBe(409);
    expect(vi.mocked(submitTransaction)).toHaveBeenCalledTimes(1);
  });

  // 5 ── deny → 200, nothing submitted ──────────────────────────────────────

  it("denying a held task returns 200 and never submits", async () => {
    const { submitTransaction } = await import("../../backend/rpc_client");
    const held = await agent.run({
      type: "stellar_payment",
      payload: makePayload("100"),
    });

    const { status, json } = await req(
      server, "POST", `/approvals/${held.approvalId}`, { action: "deny" },
    );

    expect(status).toBe(200);
    const body = json as { approval: { status: string } };
    expect(body.approval.status).toBe("denied");
    expect(vi.mocked(submitTransaction)).not.toHaveBeenCalled();
  });

  // 6 ── approve after deny → 409 ───────────────────────────────────────────

  it("cannot approve a denied task — returns 409", async () => {
    const held = await agent.run({
      type: "stellar_payment",
      payload: makePayload("100"),
    });
    await req(server, "POST", `/approvals/${held.approvalId}`, { action: "deny" });

    const { status } = await req(
      server, "POST", `/approvals/${held.approvalId}`, { action: "approve" },
    );
    expect(status).toBe(409);
  });

  // 7 ── expiry → 409 ───────────────────────────────────────────────────────

  it("expired approval cannot be approved — returns 409", async () => {
    const held = await agent.run({
      type: "stellar_payment",
      payload: makePayload("100"),
    });

    // Backdate expiresAt directly on the entry so store treats it as expired
    const entry = store.entries.get(held.approvalId!)!;
    entry.expiresAt = new Date(Date.now() - 1).toISOString();

    const { status } = await req(
      server, "POST", `/approvals/${held.approvalId}`, { action: "approve" },
    );
    expect(status).toBe(409);
  });

  // 8 ── under-threshold executes immediately ────────────────────────────────

  it("payment at or below threshold executes immediately without holding", async () => {
    const { submitTransaction } = await import("../../backend/rpc_client");
    const result = await agent.run({
      type: "stellar_payment",
      payload: makePayload("10"),  // 10 ≤ threshold of 50
    });

    expect(result.pendingApproval).toBeUndefined();
    expect(result.success).toBe(true);
    expect(vi.mocked(submitTransaction)).toHaveBeenCalledTimes(1);
  });

  // 9 ── webhook fires with pendingApproval=true ─────────────────────────────

  it("dispatches webhook with pendingApproval=true when task is held", async () => {
    const { dispatchWebhook } = await import("../../backend/webhook");
    await agent.run({ type: "stellar_payment", payload: makePayload("100") });

    expect(vi.mocked(dispatchWebhook)).toHaveBeenCalledWith(
      expect.objectContaining({ pendingApproval: true }),
    );
  });

  // 10 ── unknown ID → 409 ──────────────────────────────────────────────────

  it("POST /approvals/unknown-id returns 409", async () => {
    const { status } = await req(
      server, "POST", "/approvals/does-not-exist-00000000", { action: "approve" },
    );
    expect(status).toBe(409);
  });

  // 11 ── invalid action → 400 ──────────────────────────────────────────────

  it("POST /approvals/:id with invalid action returns 400", async () => {
    const held = await agent.run({
      type: "stellar_payment",
      payload: makePayload("100"),
    });
    const { status } = await req(
      server, "POST", `/approvals/${held.approvalId}`, { action: "invalid" },
    );
    expect(status).toBe(400);
  });
});
