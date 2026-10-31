/**
 * backend/spending_tracker.ts
 *
 * Spending tracker that records each payment amount and maintains a rolling
 * time window. It is used by the agent to enforce a cumulative spending limit
 * within `config.SPENDING_WINDOW_MS`.
 *
 * ## Persistence (#372, #731)
 * The window is mirrored to SQLite. Holding it only in memory meant a restart
 * reset the cumulative total to zero, so an agent that was restarted — or that
 * crashed and was restarted for it — could spend past its cap by starting over
 * with a clean slate. Every accepted spend (`record()` or `reserve()`) is
 * written immediately under its id and reloaded on construction.
 *
 * `release()` / `rollback()` delete the row they cancel, so a rolled-back spend
 * does not reappear after a restart (#731). A reservation that was still in
 * flight when the process died is reloaded and keeps counting
 * (conservative-safe behaviour on crash).
 *
 * Persistence is best-effort: if the database is unavailable the tracker still
 * enforces the limit for the life of the process rather than refusing to run.
 *
 * ## Record semantics (issue #730)
 * `record()` computes the prospective total *before* mutating state. If adding
 * the new amount would breach the limit the method throws *without* pushing the
 * record. A rejected attempt therefore leaves `total()` unchanged and nothing
 * is persisted.
 *
 * ## Reserve / commit / release semantics (issue #729)
 * For transaction-submission flows where the outcome is unknown at call-time,
 * use the three-phase API instead of `record()`:
 *
 *   1. `reserve(amount)` → `reservationId`   – holds the amount against the
 *      limit; throws if it would be exceeded.  State is provisional until
 *      the reservation is either committed or released.
 *   2. `commit(id)`                           – confirms a successful
 *      submission; converts the provisional hold into a real record.
 *   3. `release(id)`                          – cancels a failed/rejected
 *      submission; removes the hold so the amount is not counted.
 *
 * ## Atomic reservation (issue #732)
 * The limit check and the push happen synchronously with no await between
 * them, so concurrent async tasks are serialised by the event loop and can
 * never collectively overshoot. A re-entrancy guard rejects a nested call made
 * from inside that critical section.
 *
 * ## Per-asset limits (issue #733)
 * Each spend carries an asset key ("XLM" for native, "CODE:ISSUER" for credit
 * assets — see {@link assetKey}); when a caller names none, the x402
 * settlement asset is charged.
 *   - `SPENDING_LIMITS` unset: `AGENT_SPENDING_LIMIT` caps the combined total
 *     of every asset.
 *   - `SPENDING_LIMITS` set: each listed asset is capped by its own limit.
 *     Unlisted assets are denied unless `SPENDING_LIMITS_ALLOW_UNKNOWN=true`,
 *     in which case `AGENT_SPENDING_LIMIT` caps each of them.
 *
 * ## BigInt stroop arithmetic (issue #734)
 * Amounts are parsed with `toStroops()` and accumulated as BigInt stroops;
 * `parseFloat` is never used for a comparison against the limit.
 *
 * ## Alerts (issue #824)
 * Every accepted or rejected spend is checked against the configured alert
 * thresholds (80% and 100% of the limit by default). Each threshold notifies
 * once per window — see {@link alerts!SpendingAlertMonitor}.
 */

import { randomUUID } from 'crypto';
import { config, MAINNET_SPENDING_CAP } from './config';
import { logger } from './utils/logger';
import { spendingAlerts } from './alerts';
import {
  clearSpendingRecords,
  deleteTrackedSpendingRecord,
  getSpendingRecordsSince,
  pruneSpendingRecords,
  saveTrackedSpendingRecord,
} from './persistence';
import { toStroops, stroopsToString, STROOPS_PER_UNIT } from './utils/amount';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SpendingEntry {
  readonly id: string;
  /** BigInt stroops — never a float. */
  readonly stroops: bigint;
  readonly assetKey: string;
  readonly timestampMs: number;
  /** False while a reservation waits for commit() or release() (#729). */
  committed: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive a canonical asset key from an amount payload.
 *
 * For XLM (native): pass assetCode = "XLM", assetIssuer = undefined/""
 * For credit:       pass assetCode = "USDC", assetIssuer = "GA5Z…"
 *
 * Key format:
 *   - native → "XLM"
 *   - credit → "USDC:GA5Z…"
 */
export function assetKey(assetCode: string, assetIssuer?: string): string {
  const code = assetCode.trim().toUpperCase();
  if (!assetIssuer || code === "XLM") return "XLM";
  return `${code}:${assetIssuer.trim()}`;
}

/** The asset charged when a caller does not name one: the x402 settlement asset. */
function defaultAssetKey(): string {
  return assetKey(config.X402_ASSET_CODE, config.X402_ASSET_ISSUER);
}

/** True when SPENDING_LIMITS configures per-asset limits (#733). */
function perAssetLimits(): boolean {
  return config.SPENDING_LIMITS_MAP.size > 0;
}

/**
 * Look up the per-asset spending limit in stroops from config.
 * Falls back to the global AGENT_SPENDING_LIMIT when no per-asset entry exists.
 *
 * @returns The limit in stroops, or null when the asset is explicitly unknown
 *          and unknown assets are denied.
 */
function limitForAsset(key: string): bigint | null {
  const { SPENDING_LIMITS_MAP, SPENDING_LIMITS_ALLOW_UNKNOWN, AGENT_SPENDING_LIMIT } = config;

  if (SPENDING_LIMITS_MAP.size > 0) {
    const assetLimit = SPENDING_LIMITS_MAP.get(key);
    if (assetLimit !== undefined) {
      return toStroops(assetLimit);
    }
    // Asset not in map
    if (!SPENDING_LIMITS_ALLOW_UNKNOWN) {
      return null; // deny
    }
    // Fall through to global limit for unknown-but-allowed assets
  }

  // No per-asset config → use global limit
  return toStroops(AGENT_SPENDING_LIMIT);
}

/** Stroops → whole units, for metrics, alerts and the number-valued queries. */
function toUnits(stroops: bigint): number {
  return Number(stroops) / Number(STROOPS_PER_UNIT);
}

// ─── SpendingTracker ──────────────────────────────────────────────────────────

export class SpendingTracker {
  private readonly windowMs: number;

  /** Committed records and open reservations inside the window, oldest first. */
  private entries: SpendingEntry[] = [];

  /**
   * In-process mutual exclusion flag (#732). better-sqlite3 is synchronous, so
   * a check + persist + push never yields; the flag guards against a re-entrant
   * call made from inside that critical section on the same tick.
   */
  private _reserving = false;

  constructor(windowMs: number = config.SPENDING_WINDOW_MS) {
    this.windowMs = windowMs;
    this.restore();
  }

  /**
   * Load the unexpired part of the window left behind by a previous process.
   *
   * Idempotent: rows already held in memory are skipped, so calling it again
   * after construction does not double-count.
   */
  restore(): void {
    const cutoff = Date.now() - this.windowMs;
    try {
      const known = new Set(this.entries.map((e) => e.id));
      let restored = 0;
      for (const row of getSpendingRecordsSince(cutoff)) {
        if (known.has(row.id)) continue;
        this.entries.push({
          id: row.id,
          stroops: row.stroops,
          // Rows written before per-asset tracking were charged to the default asset.
          assetKey: row.assetKey ?? defaultAssetKey(),
          timestampMs: row.timestamp,
          committed: true,
        });
        restored++;
      }
      this.entries.sort((a, b) => a.timestampMs - b.timestampMs);
      if (restored > 0) {
        logger.info(
          { records: restored, total: toUnits(this.sum(() => true)) },
          'Restored spending window from persistence'
        );
      }
      // Rows committed before the last restart but now outside the window.
      pruneSpendingRecords(cutoff);
    } catch (err) {
      // No database, or it is unreadable — carry on with what is in memory.
      logger.warn({ error: String(err) }, 'Could not restore spending window; starting empty');
    }
  }

  // ─── Issue #730: check-before-push ──────────────────────────────────────────

  /**
   * Record a payment amount immediately (no reserve/commit needed).
   * The amount is expected to be a numeric string.
   *
   * The prospective total is computed *before* the record is pushed. If it
   * would exceed the limit the method throws without mutating state — a
   * rejected call leaves `total()` unchanged.
   *
   * Callers must only invoke this once a transfer has actually been submitted
   * successfully — recording before submission permanently counts a spend that
   * may never have happened (see #646).
   *
   * Non-numeric input is ignored so callers can handle it themselves; a numeric
   * but malformed amount (exponent, sign, more than 7 decimals) throws rather
   * than letting a spend go uncounted.
   *
   * @throws if the new cumulative total would exceed the applicable limit.
   */
  record(amountStr: string, assetKeyStr: string = defaultAssetKey()): void {
    if (isNaN(parseFloat(amountStr))) return; // let callers handle invalid input
    this.exclusive(() => {
      this.addEntry(amountStr, assetKeyStr, true);
    });
  }

  /**
   * Undo a spend whose transaction ultimately failed to submit.
   *
   * Given a reservation id (#731), removes that spend — committed or not — and
   * deletes its persisted row. Given an amount (#646), removes the most recent
   * committed record of that amount within the active window.
   *
   * Best-effort: an unknown id or amount is a no-op, so callers can safely
   * invoke this (repeatedly) from a failure path.
   */
  rollback(idOrAmount: string): void {
    this.pruneOld(Date.now());

    let idx = this.entries.findIndex((e) => e.id === idOrAmount);
    if (idx === -1 && !isNaN(parseFloat(idOrAmount))) {
      let stroops: bigint | null = null;
      try {
        stroops = toStroops(idOrAmount);
      } catch {
        // Not a well-formed amount, so nothing can have been recorded for it.
      }
      for (let i = this.entries.length - 1; i >= 0 && stroops !== null; i--) {
        const e = this.entries[i];
        if (e && e.committed && e.stroops === stroops) {
          idx = i;
          break;
        }
      }
    }

    const [removed] = idx === -1 ? [] : this.entries.splice(idx, 1);
    this.forget(removed?.id ?? idOrAmount);
  }

  // ─── Issue #729: reserve / commit / release ───────────────────────────────

  /**
   * Reserve an amount against the spending limit before submitting a
   * transaction.  Returns a `reservationId` that must later be passed to
   * either `commit()` (on success) or `release()` (on failure).
   *
   * The reserved amount counts against the limit immediately so that
   * concurrent reservations cannot collectively exceed it.
   *
   * @param amountStr   - Strict decimal string (e.g. "100" or "9.9999999").
   * @param assetKeyStr - Canonical asset key from {@link assetKey}; defaults
   *                      to the x402 settlement asset.
   * @throws When the amount is malformed, the asset is unknown/denied, or the
   *   prospective total (committed + all current holds + amount) would exceed
   *   the applicable limit.
   */
  reserve(amountStr: string, assetKeyStr: string = defaultAssetKey()): string {
    return this.exclusive(() => this.addEntry(amountStr, assetKeyStr, false));
  }

  /**
   * Commit a previously reserved amount after a successful transaction
   * submission.  The provisional hold is converted into a real record so it
   * continues to count within the window.
   *
   * @throws if `id` does not correspond to an active reservation.
   */
  commit(id: string): void {
    this.pruneOld(Date.now());
    const entry = this.openReservation(id);
    // The original reservation timestamp is kept, so the window boundary is
    // calculated relative to when the payment was authorised, not submitted.
    entry.committed = true;
    this.checkAlerts(entry.assetKey);
  }

  /**
   * Release (roll back) a reservation after a failed transaction submission.
   * The amount is removed so that it does not count against the limit.
   *
   * @throws if `id` does not correspond to an active reservation.
   */
  release(id: string): void {
    this.pruneOld(Date.now());
    const entry = this.openReservation(id);
    this.entries.splice(this.entries.indexOf(entry), 1);
    this.forget(id);
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  /** Return the total committed amount within the current window. */
  total(): number {
    this.pruneOld(Date.now());
    return toUnits(this.sum((e) => e.committed));
  }

  /** Return the total of committed + reserved amounts within the current window. */
  totalWithReserved(): number {
    this.pruneOld(Date.now());
    return toUnits(this.sum(() => true));
  }

  /**
   * Committed + reserved stroops per asset within the current window.
   * Useful for the /spending endpoint.
   */
  totals(): Map<string, bigint> {
    this.pruneOld(Date.now());
    const map = new Map<string, bigint>();
    for (const entry of this.entries) {
      map.set(entry.assetKey, (map.get(entry.assetKey) ?? 0n) + entry.stroops);
    }
    return map;
  }

  /** Committed + reserved stroops for a single asset within the current window. */
  totalForAsset(key: string): bigint {
    this.pruneOld(Date.now());
    return this.sum((e) => e.assetKey === key);
  }

  /**
   * Return a snapshot of the current window state.
   *
   * @returns An object with:
   *   - `total` – cumulative spend within the active window
   *   - `recordCount` – number of records still within the window
   *   - `windowMs` – the configured window duration in milliseconds
   *   - `oldestTimestamp` – timestamp of the oldest in-window record, or `null` when empty
   */
  getWindowStatus(): {
    total: number;
    recordCount: number;
    windowMs: number;
    oldestTimestamp: number | null;
  } {
    this.pruneOld(Date.now());
    const records = this.entries.filter((e) => e.committed);
    return {
      total: toUnits(this.sum((e) => e.committed)),
      recordCount: records.length,
      windowMs: this.windowMs,
      oldestTimestamp: records[0]?.timestampMs ?? null,
    };
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  /** Run `fn` as the critical section guarded by the re-entrancy flag (#732). */
  private exclusive<T>(fn: () => T): T {
    if (this._reserving) {
      throw new Error('SpendingTracker: re-entrant reserve() call detected');
    }
    this._reserving = true;
    try {
      return fn();
    } finally {
      this._reserving = false;
    }
  }

  /**
   * Check the limit, then persist and push one spend. The check and the push
   * happen with no await between them (#732).
   *
   * @returns the new entry's id.
   */
  private addEntry(amountStr: string, key: string, committed: boolean): string {
    // Throws on invalid format (no parseFloat)
    const stroops = toStroops(amountStr);
    const now = Date.now();
    this.pruneOld(now);

    this.assertWithinLimit(stroops, key);

    const entry: SpendingEntry = {
      id: randomUUID(),
      stroops,
      assetKey: key,
      timestampMs: now,
      committed,
    };
    // Persist before pushing so a crash right after cannot lose the spend.
    this.persist(entry);
    this.entries.push(entry);
    this.checkAlerts(key);
    return entry.id;
  }

  /**
   * Throw — without mutating state — if adding `stroops` of `key` would breach
   * the applicable limit. A rejected attempt still counts as the limit being
   * hit for alerting.
   */
  private assertWithinLimit(stroops: bigint, key: string): void {
    const limit = limitForAsset(key);
    if (limit === null) {
      throw new Error(
        `Asset "${key}" is not in the per-asset spending limits and ` +
          `SPENDING_LIMITS_ALLOW_UNKNOWN is false — payment denied`
      );
    }

    // Single-payment mainnet cap (belt-and-suspenders for every caller).
    if (
      config.STELLAR_NETWORK === 'mainnet' &&
      stroops > BigInt(MAINNET_SPENDING_CAP) * STROOPS_PER_UNIT
    ) {
      throw new Error(
        `Payment amount ${stroopsToString(stroops)} ${key} exceeds ` +
          `mainnet spending cap of ${MAINNET_SPENDING_CAP}`
      );
    }

    const prospective = this.scopeTotal(key) + stroops;
    if (prospective > limit) {
      this.notify(prospective, limit);
      throw new Error(
        `Cumulative spending for ${perAssetLimits() ? key : 'all assets'} would reach ` +
          `${stroopsToString(prospective)}, which exceeds limit ${stroopsToString(limit)}`
      );
    }
  }

  /** Committed + reserved stroops counted against the limit that applies to `key`. */
  private scopeTotal(key: string): bigint {
    return perAssetLimits() ? this.sum((e) => e.assetKey === key) : this.sum(() => true);
  }

  /** Raise threshold alerts for the window total that the limit for `key` covers. */
  private checkAlerts(key: string): void {
    const limit = limitForAsset(key);
    if (limit !== null) this.notify(this.scopeTotal(key), limit);
  }

  /** Raise threshold alerts (80% / 100% by default) for the given window total. */
  private notify(totalStroops: bigint, limitStroops: bigint): void {
    const total = toUnits(totalStroops);
    const limit = toUnits(limitStroops);
    if (total > limit * 0.8) {
      logger.warn(
        { total, limit, percent: ((total / limit) * 100).toFixed(1) },
        'Approaching spending limit'
      );
    }
    spendingAlerts.check(total, limit, this.windowMs);
  }

  /** Reservation `id` if it is still open. @throws otherwise. */
  private openReservation(id: string): SpendingEntry {
    const entry = this.entries.find((e) => e.id === id && !e.committed);
    if (!entry) {
      throw new Error(`No active reservation with id "${id}"`);
    }
    return entry;
  }

  private sum(include: (e: SpendingEntry) => boolean): bigint {
    let sum = 0n;
    for (const e of this.entries) {
      if (include(e)) sum += e.stroops;
    }
    return sum;
  }

  private persist(entry: SpendingEntry): void {
    try {
      saveTrackedSpendingRecord({
        id: entry.id,
        assetKey: entry.assetKey,
        stroops: entry.stroops,
        timestamp: entry.timestampMs,
      });
    } catch (err) {
      // A spend that cannot be written down still counts in this process.
      logger.warn({ error: String(err) }, 'Could not persist spending record');
    }
  }

  /** Delete the persisted row for a cancelled spend (#731). */
  private forget(id: string): void {
    try {
      deleteTrackedSpendingRecord(id);
    } catch {
      // Persistence is best-effort; the in-memory window is authoritative.
    }
  }

  private pruneOld(now: number): void {
    const cutoff = now - this.windowMs;
    // Entries are kept in timestamp order; stale reservations are pruned too
    // (conservative: only once strictly expired).
    let evicted = false;
    while (this.entries.length > 0 && (this.entries[0]?.timestampMs ?? 0) < cutoff) {
      this.entries.shift();
      evicted = true;
    }
    if (evicted) {
      try {
        pruneSpendingRecords(cutoff);
      } catch {
        // Pruning is housekeeping; failing to do it must not block a payment.
      }
    }
  }

  /** Reset all state (committed records, reservations and alert thresholds). */
  clear(): void {
    this.entries = [];
    spendingAlerts.reset();
    try {
      clearSpendingRecords();
    } catch {
      // Nothing persisted to clear.
    }
  }

  /**
   * Clear all in-memory entries.
   * FOR TESTING ONLY — resets state between tests without requiring a new instance.
   * @internal
   */
  _resetForTests(): void {
    this.entries.splice(0);
  }
}

/**
 * Process-wide singleton backing the cumulative spending window.
 *
 * Lives here (not in agent.ts) so value-moving tools — e.g.
 * {@link tools/SorobanInvokeTool!SorobanInvokeTool | SorobanInvokeTool} — can record simulated SAC transfers against the
 * same window as payments without importing the agent (which would create a
 * module cycle) or instantiating a second tracker (whose in-memory state would
 * drift from the real one).
 */
export const spendingTracker = new SpendingTracker();
