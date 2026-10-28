import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  feeFor,
  formatInr,
  parseMinor,
  proportionalFee,
  splitFee,
} from './index.js';

describe('parseMinor', () => {
  it('accepts bigint and integer strings', () => {
    expect(parseMinor(100n)).toBe(100n);
    expect(parseMinor('250')).toBe(250n);
  });
  it('rejects floats, negatives, junk and overflow', () => {
    for (const bad of [1.5, '1.5', '-1', -1n, 'abc', 100, null, 9_223_372_036_854_775_808n]) {
      expect(() => parseMinor(bad)).toThrow(MoneyError);
    }
  });
});

describe('fees', () => {
  it('rounds half up', () => {
    expect(feeFor(1_000n, 250)).toBe(25n); // exact
    expect(feeFor(10n, 250)).toBe(0n); // 0.25 -> 0
    expect(feeFor(20n, 250)).toBe(1n); // 0.5 -> 1 (half up)
    expect(feeFor(1_234n, 199)).toBe(25n); // 1234*199 = 245566 -> 24.5566 -> 25
  });
  it('rejects bad basis points', () => {
    expect(() => feeFor(100n, -1)).toThrow(MoneyError);
    expect(() => feeFor(100n, 10_001)).toThrow(MoneyError);
    expect(() => feeFor(100n, 1.5)).toThrow(MoneyError);
  });
  it('property: fee + net === amount and fee <= amount', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), fc.integer({ min: 0, max: 10_000 }), (a, bps) => {
        const { fee, net } = splitFee(a, bps);
        return fee + net === a && fee <= a && net >= 0n;
      }),
    );
  });
  it('property: partial refunds never refund more fee than was charged', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (total, bps, frac) => {
          const fee = feeFor(total, bps);
          const refunded = BigInt(Math.floor(Number(total) * frac));
          return proportionalFee(fee, refunded, total) <= fee;
        },
      ),
    );
  });
});

describe('formatInr', () => {
  it('formats with Indian grouping and two decimals', () => {
    expect(formatInr(123_450n)).toBe('₹1,234.50');
    expect(formatInr(5n)).toBe('₹0.05');
  });
});
