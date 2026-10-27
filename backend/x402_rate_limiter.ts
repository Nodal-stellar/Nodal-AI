/**
 * backend/x402_rate_limiter.ts
 *
 * Sliding-window rate limiter for x402 payments.
 *
 * Replaces the in-memory fixed-window limiter in X402PaymentTool with a
 * persistent sliding-window implementation that:
 *   - Survives restarts (backed by the same store as the spending tracker)
 *   - Works across multiple agent instances sharing a database
 *   - Uses a true sliding window (no 2× burst at window boundaries)
 *
 * The limiter records each x402 payment timestamp and counts how many fall
 * within the configured window (default: 60 seconds). If the count exceeds
 * MAX_X402_PAYMENTS_PER_MINUTE, the payment is rejected.
 */

import { config } from './config';
import { logger } from './logger';
import { getStorage } from './db/storage';

/**
 * Timestamp record for a single x402 payment.
 */
interface X402RateRecord {
  timestamp: number;
}

/**
 * Sliding-window rate limiter for x402 payments.
 *
 * The window is persisted to the database so that:
 *   - Multiple instances sharing a DB enforce the same limit
 *   - A restart does not reset the counter
 *   - The sliding window prevents boundary bursts
 */
export class X402RateLimiter {
  private readonly windowMs: number;
  private readonly maxPayments: number;
  private inMemoryRecords: X402RateRecord[] = [];
  private loadedFromDb = false;

  constructor(windowMs: number = 60_000, maxPayments?: number) {
    this.windowMs = windowMs;
    this.maxPayments = maxPayments ?? config.MAX_X402_PAYMENTS_PER_MINUTE;
    this.restore();
  }

  /**
   * Load unexpired records from the database.
   */
  private async restore(): Promise<void> {
    try {
      const storage = getStorage();
      const records = await storage.loadX402RateRecords(Date.now() - this.windowMs);
      this.inMemoryRecords = records;
      this.loadedFromDb = true;
      if (records.length > 0) {
        logger.info(
          {
            records: records.length,
            countInWindow: this.countInWindow(),
          },
          'Restored x402 rate limiter from persistence'
        );
      }
    } catch (err) {
      // No database, or it is unreadable — carry on with an empty window.
      logger.warn(
        {
          error: String(err),
        },
        'Could not restore x402 rate limiter; starting empty'
      );
      this.inMemoryRecords = [];
      this.loadedFromDb = false;
    }
  }

  /**
   * Check if a new x402 payment is allowed under the rate limit.
   *
   * @returns true if allowed, false if the limit would be exceeded
   */
  async check(): Promise<boolean> {
    // Wait for DB restore on first call
    if (!this.loadedFromDb) {
      await this.restore();
    }

    const now = Date.now();
    this.pruneOld(now);
    const count = this.countInWindow();

    if (count >= this.maxPayments) {
      logger.warn(
        {
          count,
          maxPayments: this.maxPayments,
          windowMs: this.windowMs,
        },
        'x402 rate limit exceeded'
      );
      return false;
    }

    return true;
  }

  /**
   * Record a successful x402 payment.
   *
   * This should be called after the payment is confirmed to persist the
   * timestamp. If persistence fails, the in-memory record is still kept
   * for the life of the process.
   */
  async record(): Promise<void> {
    const now = Date.now();
    this.inMemoryRecords.push({ timestamp: now });

    try {
      const storage = getStorage();
      await storage.saveX402RateRecord(now);
    } catch (err) {
      // A record that cannot be written down still counts in this process.
      logger.warn({ error: String(err) }, 'Could not persist x402 rate record');
    }
  }

  /**
   * Get the current count of payments within the sliding window.
   */
  countInWindow(): number {
    const now = Date.now();
    this.pruneOld(now);
    return this.inMemoryRecords.length;
  }

  /**
   * Get the current window status for monitoring/debugging.
   */
  getWindowStatus(): {
    count: number;
    maxPayments: number;
    windowMs: number;
    oldestTimestamp: number | null;
  } {
    const now = Date.now();
    this.pruneOld(now);
    return {
      count: this.inMemoryRecords.length,
      maxPayments: this.maxPayments,
      windowMs: this.windowMs,
      oldestTimestamp:
        this.inMemoryRecords.length > 0 ? this.inMemoryRecords[0]!.timestamp : null,
    };
  }

  /**
   * Remove records older than the sliding window.
   */
  private pruneOld(now: number): void {
    const cutoff = now - this.windowMs;
    let evicted = false;
    while (this.inMemoryRecords.length > 0) {
      const first = this.inMemoryRecords[0];
      if (first && first.timestamp < cutoff) {
        this.inMemoryRecords.shift();
        evicted = true;
      } else {
        break;
      }
    }

    // Also prune from DB periodically (when records are evicted)
    if (evicted && this.loadedFromDb) {
      try {
        const storage = getStorage();
        await storage.pruneX402RateRecords(cutoff);
      } catch {
        // Pruning is housekeeping; failing to do it must not block a payment.
      }
    }
  }

  /**
   * Reset all state (used in tests).
   */
  clear(): void {
    this.inMemoryRecords = [];
    try {
      const storage = getStorage();
      storage.clearX402RateRecords();
    } catch {
      // Nothing persisted to clear.
    }
  }
}

/**
 * Process-wide singleton for x402 rate limiting.
 */
export const x402RateLimiter = new X402RateLimiter();
