/**
 * Spending tracker that records each payment amount and maintains a rolling
 * time window. It is used by the agent to enforce a cumulative spending limit
 * within `config.SPENDING_WINDOW_MS`.
 *
 * The window is mirrored to SQLite (#372). Holding it only in memory meant a
 * restart reset the cumulative total to zero, so an agent that was restarted —
 * or that crashed and was restarted for it — could spend past its cap by
 * starting over with a clean slate. Records are reloaded on construction and
 * written on every `record()`.
 *
 * Persistence is best-effort: if the database is unavailable the tracker still
 * enforces the limit for the life of the process rather than refusing to run.
 */
export declare class SpendingTracker {
    private readonly windowMs;
    private records;
    constructor(windowMs?: number);
    /**
     * Load the unexpired part of the window left behind by a previous process.
     */
    private restore;
    /**
     * Record a payment amount. The amount is expected to be a numeric string.
     * Throws if the new cumulative total exceeds `config.AGENT_SPENDING_LIMIT`.
     */
    record(amountStr: string): void;
    /** Return the total amount spent within the current window. */
    total(): number;
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
    };
    private persist;
    private pruneOld;
    clear(): void;
}
/**
 * Process-wide singleton backing the cumulative spending window.
 *
 * Lives here (not in agent.ts) so value-moving tools — e.g.
 * {@link SorobanInvokeTool} — can record simulated SAC transfers against the
 * same window as payments without importing the agent (which would create a
 * module cycle) or instantiating a second tracker (whose in-memory state would
 * drift from the real one).
 */
export declare const spendingTracker: SpendingTracker;
//# sourceMappingURL=spending_tracker.d.ts.map