/** J-academy-07 — the payment amounts and calldata the buyer's wallet is asked to sign. */
import { describe, expect, it } from 'vitest';
import { fromBaseUnits, toBaseUnits, transferCalldata } from './chain.js';

describe('payment amounts', () => {
  it('scales a decimal price to the token unit exactly, and back', () => {
    expect(toBaseUnits('2.5', 6)).toBe(2_500_000n);
    expect(toBaseUnits('20', 6)).toBe(20_000_000n);
    expect(toBaseUnits('0.000001', 6)).toBe(1n);
    expect(toBaseUnits('1.5', 18)).toBe(1_500_000_000_000_000_000n);
    expect(fromBaseUnits(2_500_000n, 6)).toBe('2.5');
    expect(fromBaseUnits(20_000_000n, 6)).toBe('20');
  });

  it('refuses a price with more decimals than the token, or one that is not a decimal', () => {
    expect(() => toBaseUnits('0.0000001', 6)).toThrow(/more decimals/);
    expect(() => toBaseUnits('abc', 6)).toThrow();
    expect(() => toBaseUnits('1', 19)).toThrow(/decimals/);
  });

  it('builds transfer(to, amount) and nothing else', () => {
    const to = '0x7e57ac4d00000000000000000000000000000007';
    expect(transferCalldata(to, 2_500_000n)).toBe(`0xa9059cbb${'0'.repeat(24)}${to.slice(2)}${(2_500_000).toString(16).padStart(64, '0')}`);
    expect(() => transferCalldata(to, 0n)).toThrow();
    expect(() => transferCalldata('0x12', 1n)).toThrow();
  });
});
