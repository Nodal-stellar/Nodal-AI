# Load Testing — Nodal-AI Agent Server

This document describes the load-testing setup introduced in issue #1005.
Baseline numbers are committed in [`docs/load-test-baseline.json`](./load-test-baseline.json)
and are overwritten each time `npm run load-test` runs successfully.

---

## Running the load tests

```bash
npm run load-test
```

A single command starts the agent HTTP server against an in-memory SQLite DB
and mock Horizon/Soroban, runs all three scenarios in sequence, prints a
summary table to stdout, and writes raw results to `docs/load-test-baseline.json`.

> **No network access required.** All Horizon/Soroban calls are no-ops during
> the load run. Results reflect pure agent + HTTP server overhead.

---

## Scenarios

### 1 — `GET /health` baseline

| Setting | Value |
|---|---|
| Connections | 20 concurrent |
| Duration | 10 s |
| Pipeline depth | 1 (no pipelining) |

The health endpoint makes no DB or RPC calls, so this gives the ceiling
throughput of the Node.js HTTP server itself.

**Baseline target:** ≥ 500 req/s, p99 latency < 50 ms, 0 errors.

---

### 2 — `GET /status` pagination

| Setting | Value |
|---|---|
| Connections | 20 concurrent |
| Duration | 10 s |
| Offset values | 0, 100, 200, 300, 400, 500 (cycled) |

Exercises the SQLite `SELECT … LIMIT ? OFFSET ?` path under concurrent reads.
SQLite's reader concurrency means this should not bottleneck before the HTTP
server itself.

**Baseline target:** ≥ 300 req/s, p99 latency < 100 ms, 0 errors.

---

### 3 — 50 concurrent SSE clients

Simulates 50 long-lived client connections all firing requests continuously for
10 s. This exercises Node.js's ability to hold many simultaneous sockets open
without exhausting file descriptors or the libuv thread pool.

**Baseline target:** 0 errors, 100 % success rate.

---

## Committed baseline numbers

See [`load-test-baseline.json`](./load-test-baseline.json) for the most recent
run. Numbers were captured on a standard GitHub Actions `ubuntu-latest` runner
(2 vCPU, 7 GB RAM) using Node.js 20.

| Scenario | req/s | p50 (ms) | p99 (ms) | Errors |
|---|---|---|---|---|
| GET /health (baseline) | 3,200 | 5 | 18 | 0 |
| GET /status pagination | 1,800 | 9 | 35 | 0 |
| 50 concurrent connections | — | — | — | 0 (100 % success) |

---

## SQLite contention notes

Under the status-pagination scenario, concurrent readers share a single
`better-sqlite3` handle. Because `better-sqlite3` uses synchronous calls on the
main thread, there is no true parallelism — requests are serialised through the
event loop. Observed throughput (~1,800 req/s) is therefore bounded by SQLite
row-scan speed, not connection count.

If you need higher read throughput on `/status`, consider:
- Enabling WAL mode: `db.pragma("journal_mode = WAL")` in `persistence.ts`
- Adding a secondary read replica
- Caching the last N results in memory

---

## Adding new scenarios

Add a new async function to `tests/load/run_load_tests.ts` following the
existing pattern, call it from `main()`, store its output in `results`, and
update the baseline file and this document.
