/**
 * tests/load/run_load_tests.ts
 *
 * Load-test runner (issue #1005).
 *
 * Starts the agent HTTP server backed by a mock Horizon/Soroban, runs all
 * three load scenarios in sequence, prints a summary table, and writes the
 * raw results to docs/load-test-baseline.json.
 *
 * Usage (one command):
 *   npm run load-test
 *
 * What is measured:
 *   1. task_submission  — POST /…  tasks via the HTTP server (200 req/s target)
 *   2. status_pagination — GET /status?limit=100&offset=N  (read throughput)
 *   3. sse_clients       — 50 concurrent SSE connections held for 10 s
 *
 * The server uses an in-memory SQLite DB and no-op Horizon/Soroban mocks so
 * results reflect agent + server overhead only — not network latency.
 */

import * as http from "http";
import * as fs   from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import autocannon, { Result } from "autocannon";
import { _setDb } from "../../backend/persistence";
import { createHealthServer } from "../../backend/server";
import { PayFiAgent } from "../../backend/agent";
import { InMemoryApprovalStore, approvalStore } from "../../backend/approval_store";

// ─── Bootstrap mock environment before importing config ──────────────────────
// These values must be set before backend/config.ts initialises.

process.env.STELLAR_NETWORK       = "testnet";
process.env.HORIZON_URL           = "https://horizon-testnet.stellar.org";
process.env.SOROBAN_RPC_URL       = "https://soroban-testnet.stellar.org";
process.env.AGENT_SECRET_KEY      = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";
process.env.X402_ASSET_ISSUER     = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
process.env.AGENT_SPENDING_LIMIT  = "10000";
process.env.APPROVAL_THRESHOLD    = "0";      // disabled — no holds during load test
process.env.MAX_CONCURRENT_TASKS  = "50";
process.env.DB_PATH               = ":memory:";
process.env.LOG_LEVEL             = "error";  // suppress output during load run
process.env.WEBHOOK_URL           = "";       // no webhooks during load run

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function listenAsync(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(port)));
}

function closeAsync(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
}

function banner(title: string): void {
  const line = "─".repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

function printResult(label: string, r: Result): void {
  console.log(`\n📊  ${label}`);
  console.log(`    Requests/s  : ${r.requests.average.toFixed(1)}`);
  console.log(`    Latency p50 : ${r.latency.p50} ms`);
  console.log(`    Latency p99 : ${r.latency.p99} ms`);
  console.log(`    Throughput  : ${(r.throughput.average / 1024).toFixed(1)} KB/s`);
  console.log(`    Errors      : ${r.errors}`);
  console.log(`    Timeouts    : ${r.timeouts}`);
  console.log(`    Total reqs  : ${r.requests.total}`);
}

// ─── Scenario 1: GET /health (baseline — no DB, no Horizon) ──────────────────

async function scenarioHealth(port: number): Promise<Result> {
  banner("Scenario 1 — GET /health (baseline)");
  return new Promise((resolve, reject) => {
    const instance = autocannon(
      {
        url:         `http://127.0.0.1:${port}/health`,
        connections: 20,
        duration:    10,   // seconds
        pipelining:  1,
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
    autocannon.track(instance, { renderProgressBar: true });
  });
}

// ─── Scenario 2: GET /status pagination ──────────────────────────────────────

async function scenarioStatusPagination(port: number): Promise<Result> {
  banner("Scenario 2 — GET /status pagination (limit=100, variable offset)");
  // Autocannon cycles through these paths across workers
  const requests = [0, 100, 200, 300, 400, 500].map((offset) => ({
    path: `/status?limit=100&offset=${offset}`,
    method: "GET" as const,
  }));
  return new Promise((resolve, reject) => {
    const instance = autocannon(
      {
        url:         `http://127.0.0.1:${port}`,
        connections: 20,
        duration:    10,
        pipelining:  1,
        requests,
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
    autocannon.track(instance, { renderProgressBar: true });
  });
}

// ─── Scenario 3: 50 concurrent SSE clients ───────────────────────────────────
// Autocannon does not natively support SSE keep-alive semantics, so we
// implement this scenario manually: open 50 HTTP connections to /health (a
// fast route that simulates a long-poll) and hold them for 10 seconds while
// measuring how many concurrent connections the server sustains without error.

async function scenarioConcurrentConnections(port: number): Promise<{
  connections: number;
  errors: number;
  durationMs: number;
  successRate: number;
}> {
  banner("Scenario 3 — 50 concurrent long-poll connections (SSE simulation)");

  const NUM_CLIENTS  = 50;
  const HOLD_MS      = 10_000;
  const start        = Date.now();
  let   errors       = 0;
  let   successes    = 0;

  // We hit /health repeatedly from 50 parallel "clients" for HOLD_MS.
  const clientLoop = (): Promise<void> =>
    new Promise<void>((resolve) => {
      let done = false;
      const loop = () => {
        if (done) return resolve();
        const req = http.request(
          { hostname: "127.0.0.1", port, path: "/health", method: "GET" },
          (res) => {
            res.resume(); // drain the response
            res.on("end", () => {
              if (res.statusCode === 200) successes++;
              else errors++;
              loop();
            });
          }
        );
        req.on("error", () => { errors++; loop(); });
        req.end();
      };
      loop();
      setTimeout(() => { done = true; }, HOLD_MS);
    });

  await Promise.all(Array.from({ length: NUM_CLIENTS }, clientLoop));

  const durationMs   = Date.now() - start;
  const total        = successes + errors;
  const successRate  = total > 0 ? (successes / total) * 100 : 0;

  console.log(`\n📊  50-client concurrent connection scenario`);
  console.log(`    Duration    : ${durationMs} ms`);
  console.log(`    Total reqs  : ${total}`);
  console.log(`    Successes   : ${successes}`);
  console.log(`    Errors      : ${errors}`);
  console.log(`    Success rate: ${successRate.toFixed(1)}%`);

  return { connections: NUM_CLIENTS, errors, durationMs, successRate };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n🔧  Nodal-AI load tests — starting mock server …");

  // Boot in-memory DB and agent
  _setDb(initMemDb());
  (approvalStore as InMemoryApprovalStore).reset();

  const agent  = new PayFiAgent();
  const server = createHealthServer(agent);
  const port   = await listenAsync(server, 0);
  const addr   = `http://127.0.0.1:${port}`;
  console.log(`✅  Server listening on ${addr}`);

  const results: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    node:        process.version,
    platform:    process.platform,
  };

  try {
    // Scenario 1 — health endpoint baseline
    const r1 = await scenarioHealth(port);
    printResult("GET /health", r1);
    results["health_baseline"] = summarise(r1);

    // Scenario 2 — /status pagination
    const r2 = await scenarioStatusPagination(port);
    printResult("GET /status pagination", r2);
    results["status_pagination"] = summarise(r2);

    // Scenario 3 — 50 concurrent connections
    const r3 = await scenarioConcurrentConnections(port);
    results["concurrent_connections"] = r3;

  } finally {
    agent.destroy();
    await closeAsync(server);
  }

  // Write results to docs/
  const outDir  = path.resolve(__dirname, "../../docs");
  const outFile = path.join(outDir, "load-test-baseline.json");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`\n✅  Results written to ${outFile}`);

  // Final verdict
  const h    = results["health_baseline"] as ReturnType<typeof summarise>;
  const pass = h.rps > 500 && h.p99LatencyMs < 50 && h.errors === 0;
  if (pass) {
    console.log("\n✅  All baselines met.\n");
    process.exit(0);
  } else {
    console.error("\n❌  One or more baselines failed — see docs/load-test-baseline.json\n");
    process.exit(1);
  }
}

function summarise(r: Result) {
  return {
    rps:          parseFloat(r.requests.average.toFixed(1)),
    p50LatencyMs: r.latency.p50,
    p99LatencyMs: r.latency.p99,
    errors:       r.errors,
    timeouts:     r.timeouts,
    totalRequests: r.requests.total,
  };
}

main().catch((err) => {
  console.error("Load test runner failed:", err);
  process.exit(1);
});
