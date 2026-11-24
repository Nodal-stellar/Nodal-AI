/**
 * tests/fuzz/units.test.ts
 *
 * Property tests for generic decimal ↔ atomic-unit conversion (Issue #1007).
 *
 * `toAtomicUnits` / `fromAtomicUnits` (backend/utils/amount.ts) generalize the
 * Stellar-specific 7-decimal `toStroops` / `fromStroops` to an arbitrary
 * decimal-places scale, which is what x402/MPP payments need when the asset
 * involved isn't a 7-decimal Stellar asset (e.g. 18-decimal tokens, or
 * Nano's raw units). Unit mix-ups across these scales were the root cause of
 * several wave-2 bugs, so these are invariant properties, not example tests.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { toAtomicUnits, fromAtomicUnits, toStroops, fromStroops } from '../../backend/utils/amount';

const TEN_K_RUNS = 10_000;

// Decimal scales this property suite exercises: the full Stellar range (0-7)
// plus 18, the scale commonly used by non-Stellar/ERC20-style atomic units.
const DECIMALS_ARB = fc.constantFrom(0, 1, 2, 3, 4, 5, 6, 7, 18);

describe('toAtomicUnits / fromAtomicUnits — generic decimal scale', () => {
  it('toAtomicUnits(decimal, d) === toStroops(decimal) when d === 7 (10k runs)', () => {
    const amountArb = fc
      .tuple(fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 0, max: 9_999_999 }))
      .map(([whole, frac]) => `${whole}.${frac.toString().padStart(7, '0')}`);

    fc.assert(
      fc.property(amountArb, (decimalStr) => {
        expect(toAtomicUnits(decimalStr, 7)).toBe(toStroops(decimalStr));
      }),
      { numRuns: TEN_K_RUNS }
    );
  });

  it('fromAtomicUnits(atomic, d) === fromStroops(atomic) when d === 7 (10k runs)', () => {
    const stroopArb = fc.bigInt({ min: 0n, max: 100_000_000_000_000n });

    fc.assert(
      fc.property(stroopArb, (atomic) => {
        expect(fromAtomicUnits(atomic, 7)).toBe(fromStroops(atomic));
      }),
      { numRuns: TEN_K_RUNS }
    );
  });

  it('round-trips atomic → decimal → atomic for any scale in 0-7 or 18 (10k runs)', () => {
    const arb = fc
      .tuple(DECIMALS_ARB, fc.bigInt({ min: 0n, max: 10n ** 30n }))
      .map(([decimals, atomic]) => [decimals, atomic % 10n ** BigInt(decimals + 15)] as const);

    fc.assert(
      fc.property(arb, ([decimals, atomic]) => {
        const str = fromAtomicUnits(atomic, decimals);
        expect(toAtomicUnits(str, decimals)).toBe(atomic);
      }),
      { numRuns: TEN_K_RUNS }
    );
  });

  it('round-trips decimal → atomic → decimal for canonical strings at any scale (10k runs)', () => {
    const arb = DECIMALS_ARB.chain((decimals) =>
      fc
        .tuple(fc.integer({ min: 0, max: 10_000_000 }), fc.bigInt({ min: 0n, max: 10n ** 20n }))
        .map(([whole, fracRaw]) => {
          const frac = (fracRaw % 10n ** BigInt(Math.max(decimals, 1))).toString();
          const decimalStr =
            decimals === 0
              ? `${whole}`
              : `${whole}.${frac.padStart(decimals, '0').slice(0, decimals)}`;
          return [decimals, decimalStr] as const;
        })
    );

    fc.assert(
      fc.property(arb, ([decimals, decimalStr]) => {
        const atomic = toAtomicUnits(decimalStr, decimals);
        expect(fromAtomicUnits(atomic, decimals)).toBe(decimalStr);
      }),
      { numRuns: TEN_K_RUNS }
    );
  });

  it('is monotonic: larger atomic amounts produce larger decimal strings, numerically (10k runs)', () => {
    const arb = DECIMALS_ARB.chain((decimals) =>
      fc
        .tuple(fc.bigInt({ min: 0n, max: 10n ** 20n }), fc.bigInt({ min: 1n, max: 10n ** 20n }))
        .map(([a, delta]) => [decimals, a, a + delta] as const)
    );

    fc.assert(
      fc.property(arb, ([decimals, smaller, larger]) => {
        const smallerStr = fromAtomicUnits(smaller, decimals);
        const largerStr = fromAtomicUnits(larger, decimals);
        expect(toAtomicUnits(largerStr, decimals)).toBeGreaterThan(
          toAtomicUnits(smallerStr, decimals)
        );
      }),
      { numRuns: TEN_K_RUNS }
    );
  });

  it('rejects negative decimal strings at any scale (10k runs)', () => {
    const arb = DECIMALS_ARB.chain((decimals) =>
      fc.integer({ min: 1, max: 1_000_000 }).map((whole) => [decimals, `-${whole}`] as const)
    );

    fc.assert(
      fc.property(arb, ([decimals, negStr]) => {
        expect(() => toAtomicUnits(negStr, decimals)).toThrow(/negative/i);
      }),
      { numRuns: TEN_K_RUNS }
    );
  });

  it('rejects exponent notation at any scale (10k runs)', () => {
    const arb = DECIMALS_ARB.chain((decimals) =>
      fc
        .tuple(
          fc.integer({ min: 1, max: 999 }),
          fc.constantFrom('e', 'E'),
          fc.integer({ min: 0, max: 20 })
        )
        .map(([base, e, p]) => [decimals, `${base}${e}${p}`] as const)
    );

    fc.assert(
      fc.property(arb, ([decimals, expStr]) => {
        expect(() => toAtomicUnits(expStr, decimals)).toThrow(/exponent/i);
      }),
      { numRuns: TEN_K_RUNS }
    );
  });

  it('rejects amounts with more fractional digits than the given scale allows (10k runs)', () => {
    const arb = DECIMALS_ARB.chain((decimals) =>
      fc
        .tuple(
          fc.integer({ min: 0, max: 10_000 }),
          fc.integer({ min: decimals + 1, max: decimals + 20 })
        )
        .map(([whole, fracLen]) => [decimals, `${whole}.${'9'.repeat(fracLen)}`] as const)
    );

    fc.assert(
      fc.property(arb, ([decimals, tooPrecise]) => {
        expect(() => toAtomicUnits(tooPrecise, decimals)).toThrow(/decimal places/i);
      }),
      { numRuns: TEN_K_RUNS }
    );
  });

  it('fromAtomicUnits rejects negative bigints at any scale (10k runs)', () => {
    const arb = DECIMALS_ARB.chain((decimals) =>
      fc.bigInt({ min: -(10n ** 20n), max: -1n }).map((atomic) => [decimals, atomic] as const)
    );

    fc.assert(
      fc.property(arb, ([decimals, atomic]) => {
        expect(() => fromAtomicUnits(atomic, decimals)).toThrow(RangeError);
      }),
      { numRuns: TEN_K_RUNS }
    );
  });
});
