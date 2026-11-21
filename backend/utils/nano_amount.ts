/**
 * backend/utils/nano_amount.ts
 *
 * Raw → XNO conversion for the spending tracker (#977).
 *
 * Nano amounts are integers in raw: 1 XNO = 10^30 raw. The spending tracker
 * keeps every asset in 7-decimal units (stroops, see ./amount), so a Nano
 * payment is charged to the tracker as XNO with at most 7 decimals.
 *
 * One tracker unit of XNO (0.0000001 XNO) is 10^23 raw. A raw amount that is
 * not a whole number of those units is rounded UP, so a payment is never
 * counted as less than it moves: 1 raw is charged as 0.0000001 XNO.
 *
 * BigInt only — no parseFloat, no Number(), so 30-digit amounts stay exact.
 * This module imports nothing.
 */

/** Asset key the tracker and SPENDING_LIMITS use for Nano, e.g. `SPENDING_LIMITS='XNO:1'`. */
export const NANO_ASSET_KEY = 'XNO';

/** Decimal places of one XNO in raw. */
export const NANO_DECIMALS = 30;

/** 1 XNO in raw (10^30). */
export const RAW_PER_XNO = 10n ** BigInt(NANO_DECIMALS);

/** Decimal places the spending tracker keeps for every asset. */
const TRACKER_DECIMALS = 7;

/** Raw in one tracker unit of XNO: 10^(30 - 7) = 10^23. */
export const RAW_PER_TRACKER_UNIT = 10n ** BigInt(NANO_DECIMALS - TRACKER_DECIMALS);

/**
 * Convert a raw amount (unsigned integer string) to the XNO amount string the
 * spending tracker accepts, e.g. "2000000000000000000000000000000" → "2.0000000".
 * Sub-unit remainders round up.
 *
 * @throws {Error} if `raw` is not an unsigned integer string.
 */
export function nanoRawToTrackerAmount(raw: string): string {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new Error(`Nano amount must be an unsigned integer string in raw, got "${String(raw)}"`);
  }
  const value = BigInt(raw);
  const units = (value + RAW_PER_TRACKER_UNIT - 1n) / RAW_PER_TRACKER_UNIT;
  const scale = 10n ** BigInt(TRACKER_DECIMALS);
  const whole = units / scale;
  const frac = units % scale;
  return `${whole}.${String(frac).padStart(TRACKER_DECIMALS, '0')}`;
}
