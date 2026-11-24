/**
 * backend/approval_store.ts
 *
 * In-process store for pending payment-approval requests.
 *
 * When a task's amount exceeds APPROVAL_THRESHOLD the agent calls
 * `approvalStore.hold()` instead of executing immediately. The request sits in
 * the store until an operator calls `approve()` or `deny()` via the HTTP API,
 * or the item expires (APPROVAL_TTL_MS, default 10 minutes).
 *
 * ## Thread safety
 * Node.js runs on a single-threaded event loop so the Map operations are
 * inherently serialised — no locks needed.
 *
 * ## Multi-instance deployments
 * For horizontally-scaled deployments, replace this in-memory store with a
 * Redis- or DB-backed implementation using the same `IApprovalStore` interface.
 */

import { AgentTask } from "./agent";
import { createLogger } from "./utils/logger";

const log = createLogger("approval-store");

// ─── TTL ─────────────────────────────────────────────────────────────────────

/** How long a pending approval may sit before it is auto-expired (ms). */
export const APPROVAL_TTL_MS = 10 * 60 * 1_000; // 10 minutes

// ─── Types ────────────────────────────────────────────────────────────────────

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface PendingApproval {
  id: string;
  task: AgentTask;
  /** ISO string recorded at hold-time. */
  createdAt: string;
  /** ISO string after which the request is treated as expired. */
  expiresAt: string;
  status: ApprovalStatus;
}

// ─── Interface ────────────────────────────────────────────────────────────────

export interface IApprovalStore {
  /** Place a task on hold, returning the new approval's ID. */
  hold(task: AgentTask): string;
  /** Return all entries (pruning expired ones first). */
  list(): PendingApproval[];
  /** Return one entry by ID, or undefined if not found. */
  get(id: string): PendingApproval | undefined;
  /**
   * Transition a pending entry to `approved`.
   * Returns the entry so the caller can execute the task.
   * Throws if the entry does not exist, is not `pending`, or has expired.
   */
  approve(id: string): PendingApproval;
  /**
   * Transition a pending entry to `denied`.
   * Throws if the entry does not exist or is not `pending`.
   */
  deny(id: string): PendingApproval;
}

// ─── In-memory implementation ─────────────────────────────────────────────────

export class InMemoryApprovalStore implements IApprovalStore {
  readonly entries = new Map<string, PendingApproval>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = APPROVAL_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Clear all entries — used in tests to reset between cases. */
  reset(): void {
    this.entries.clear();
  }

  hold(task: AgentTask): string {
    const id = crypto.randomUUID();
    const now = new Date();
    const entry: PendingApproval = {
      id,
      task,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      status: "pending",
    };
    this.entries.set(id, entry);
    log.info({ approvalId: id, taskType: task.type }, "Task held for approval");
    return id;
  }

  list(): PendingApproval[] {
    this._pruneExpired();
    return Array.from(this.entries.values());
  }

  get(id: string): PendingApproval | undefined {
    this._pruneExpired();
    return this.entries.get(id);
  }

  approve(id: string): PendingApproval {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Approval ${id} not found`);
    if (entry.status !== "pending") {
      throw new Error(`Approval ${id} is already ${entry.status} — cannot approve`);
    }
    if (new Date() > new Date(entry.expiresAt)) {
      entry.status = "expired";
      throw new Error(`Approval ${id} has expired`);
    }
    entry.status = "approved";
    log.info({ approvalId: id, taskType: entry.task.type }, "Approval granted");
    return entry;
  }

  deny(id: string): PendingApproval {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Approval ${id} not found`);
    if (entry.status !== "pending") {
      throw new Error(`Approval ${id} is already ${entry.status} — cannot deny`);
    }
    entry.status = "denied";
    log.info({ approvalId: id, taskType: entry.task.type }, "Approval denied");
    return entry;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private _pruneExpired(): void {
    const now = new Date();
    for (const [id, entry] of this.entries) {
      if (entry.status === "pending" && now > new Date(entry.expiresAt)) {
        entry.status = "expired";
        log.info({ approvalId: id }, "Approval expired");
      }
    }
  }
}

/** Module-level singleton used by the agent and HTTP server. */
export const approvalStore: IApprovalStore = new InMemoryApprovalStore();
