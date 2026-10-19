import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { planPplns } from './pplns.js';

/**
 * The fee goes through the shared `mulBps` (floor) instead of inline math. This pins the old formula against the plan
 * over rounding edges, and pins that split dust is retained by the pool rather than handed to a miner.
 */
const oldFee = (reward: string, feeBps: number): string => formatAmount((parseAmount(reward) * BigInt(feeBps)) / 10_000n);

describe('planPplns fee and split rounding', () => {
  const shares = [
    { shareId: 'a', minerId: 'alice', weight: 1n },
    { shareId: 'b', minerId: 'bob', weight: 2n },
  ];

  it('charges the same fee as the old inline formula, rounded down', () => {
    for (const reward of ['0.000000000000000001', '0.000000000000000199', '1', '10', '123.456789012345678901']) {
      for (const feeBps of [0, 1, 99, 100, 333, 9_999]) {
        expect(planPplns({ windowId: 'w', assetId: 'IFC', reward, feeBps, shares }).fee, `${reward} at ${feeBps} bps`).toBe(
          oldFee(reward, feeBps),
        );
      }
    }
  });

  it('keeps indivisible dust in the pool: payouts plus retained equal net', () => {
    const plan = planPplns({ windowId: 'w', assetId: 'IFC', reward: '0.000000000000000010', feeBps: 0, shares });
    const paid = plan.payouts.reduce((sum, p) => sum + parseAmount(p.amount), 0n);
    expect(paid + parseAmount(plan.retained)).toBe(parseAmount(plan.net));
    expect(parseAmount(plan.retained)).toBe(1n);
  });
});
