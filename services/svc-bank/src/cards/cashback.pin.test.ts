import { describe, expect, it } from 'vitest';
import { cashbackOn } from './issuer.js';

/**
 * `cashbackOn` once computed `captured * bps / 10_000` inline. It now goes through the shared `mulBps` with an explicit
 * floor. This pins the old formula against the new one over amounts that include rounding edges, so the swap cannot move
 * a reward by one unit.
 */
const oldCashbackOn = (captured: bigint, rateBps: number): bigint => (rateBps <= 0 ? 0n : (captured * BigInt(rateBps)) / 10_000n);

describe('cashbackOn keeps the pre-mulBps result', () => {
  const amounts = [
    0n,
    1n,
    99n,
    100n,
    199n,
    9_999n,
    10_000n,
    10_001n,
    123_456_789n,
    10n ** 18n,
    10n ** 18n + 1n,
    250n * 10n ** 18n,
    10n ** 30n + 7n,
  ];
  const rates = [-5, 0, 1, 10, 50, 99, 100, 333, 9_999, 10_000];

  it('matches the old inline formula for every amount and rate', () => {
    for (const amount of amounts) {
      for (const rate of rates) {
        expect(cashbackOn(amount, rate), `amount ${amount} at ${rate} bps`).toBe(oldCashbackOn(amount, rate));
      }
    }
  });

  it('never rounds up', () => {
    expect(cashbackOn(199n, 100)).toBe(1n);
    expect(cashbackOn(1n, 9_999)).toBe(0n);
  });
});
