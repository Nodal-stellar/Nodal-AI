/**
 * tests/nano_amount.test.ts
 *
 * Raw → XNO conversion used to charge Nano payments to the spending tracker (#977).
 */

import { describe, it, expect } from 'vitest';
import {
  nanoRawToTrackerAmount,
  NANO_ASSET_KEY,
  RAW_PER_XNO,
  RAW_PER_TRACKER_UNIT,
} from '../backend/utils/nano_amount';
import { toStroops } from '../backend/utils/amount';

describe('nanoRawToTrackerAmount (#977)', () => {
  it('derives 1 XNO as 10^30 raw and one tracker unit as 10^23 raw', () => {
    expect(RAW_PER_XNO).toBe(10n ** 30n);
    expect(RAW_PER_TRACKER_UNIT * 10_000_000n).toBe(RAW_PER_XNO);
    expect(NANO_ASSET_KEY).toBe('XNO');
  });

  it('converts whole and fractional XNO exactly', () => {
    expect(nanoRawToTrackerAmount((2n * RAW_PER_XNO).toString())).toBe('2.0000000');
    expect(nanoRawToTrackerAmount((RAW_PER_XNO / 2n).toString())).toBe('0.5000000');
    expect(nanoRawToTrackerAmount('1000000000000000000000000')).toBe('0.0000010');
  });

  it('rounds a remainder below one tracker unit up', () => {
    expect(nanoRawToTrackerAmount('1')).toBe('0.0000001');
    expect(nanoRawToTrackerAmount((RAW_PER_TRACKER_UNIT + 1n).toString())).toBe('0.0000002');
    expect(nanoRawToTrackerAmount((RAW_PER_XNO + 1n).toString())).toBe('1.0000001');
  });

  it('keeps amounts beyond Number precision exact', () => {
    const raw = '123456789012345678901234567890123456';
    expect(nanoRawToTrackerAmount(raw)).toBe('123456.7890124');
  });

  it('returns a string the tracker parses', () => {
    expect(toStroops(nanoRawToTrackerAmount((3n * RAW_PER_XNO).toString()))).toBe(30_000_000n);
    expect(nanoRawToTrackerAmount('0')).toBe('0.0000000');
  });

  it('rejects anything that is not an unsigned integer string', () => {
    for (const bad of ['', '-1', '1.5', '1e30', ' 1', '0x10']) {
      expect(() => nanoRawToTrackerAmount(bad)).toThrow(/unsigned integer/);
    }
    expect(() => nanoRawToTrackerAmount(5 as unknown as string)).toThrow(/unsigned integer/);
  });
});
