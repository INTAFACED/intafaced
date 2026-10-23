import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { DEFAULT_FUTURES_LADDER_POLICY as POLICY } from './ladder-policy.test-harness.js';
import { liquidationPriceFor } from './liquidation-price.js';
import { planLadderRung } from './maintenance-ladder.js';

const CENT = parseAmount('0.01');

function rungAt(input: { side: 'long' | 'short'; size: string; entry: string; margin: string; depth: string }, price: bigint) {
  return planLadderRung({
    position: {
      positionId: 'p1',
      userId: 'u1',
      side: input.side,
      size: parseAmount(input.size),
      entryPrice: parseAmount(input.entry),
      margin: parseAmount(input.margin),
      marginAsset: 'USDT',
    },
    markPrice: price,
    depthNotional: parseAmount(input.depth),
    policy: POLICY,
  });
}

function estimate(input: { side: 'long' | 'short'; size: string; entry: string; margin: string; depth: string }) {
  return liquidationPriceFor({
    side: input.side,
    size: parseAmount(input.size),
    entryPrice: parseAmount(input.entry),
    margin: parseAmount(input.margin),
    depthNotional: parseAmount(input.depth),
    policy: POLICY,
  });
}

describe('liquidation price from the maintenance ladder', () => {
  const cases = [
    { name: 'a 5x long on a deep book', side: 'long', size: '0.01', entry: '64732.41', margin: '129.77538', depth: '1000000' },
    { name: 'a 5x short on a deep book', side: 'short', size: '0.01', entry: '64732.41', margin: '129.77538', depth: '1000000' },
    { name: 'a 10x long rated into a higher tier', side: 'long', size: '2', entry: '65000', margin: '13000', depth: '200000' },
    { name: 'a 10x short rated into a higher tier', side: 'short', size: '2', entry: '65000', margin: '13000', depth: '200000' },
  ] as const;

  for (const c of cases) {
    it(`${c.name}: the ladder acts within a cent of the price shown, and not a cent before it`, () => {
      const got = estimate(c);
      if (got.price === null) throw new Error(`no price: ${got.reason}`);
      const past = c.side === 'long' ? got.price - CENT : got.price + CENT;
      const before = c.side === 'long' ? got.price + CENT : got.price - CENT;
      expect(rungAt(c, past).action, formatAmount(got.price)).toBe('liquidate');
      expect(rungAt(c, before).action).not.toBe('liquidate');
      expect(rungAt(c, past).maintenanceBps).toBe(got.maintenanceBps);
    });
  }

  it('the 5x long sits below entry and the short above it, by about the margin less maintenance', () => {
    const long = estimate(cases[0]);
    const short = estimate(cases[1]);
    expect(long.price !== null && formatAmount(long.price)).toBe('52014.946733668341708543');
    expect(short.price !== null && formatAmount(short.price)).toBe('77323.331343283582089552');
  });

  it('a long whose margin covers its whole notional has no liquidation price above zero; an empty position has none', () => {
    expect(estimate({ side: 'long', size: '0.01', entry: '65000', margin: '650', depth: '1000000' })).toEqual({
      price: null,
      reason: 'no_price_above_zero',
    });
    expect(estimate({ side: 'long', size: '0', entry: '65000', margin: '650', depth: '1000000' })).toEqual({
      price: null,
      reason: 'empty_position',
    });
  });

  it('a short whose requirement steps up at a tier edge is liquidated at the edge: no single figure, never a wrong one', () => {
    // Depth 500 000: the 100 bps tier ends at 2 000 bps of depth, a notional of 100 000, so at a price of 100 000.
    const c = { side: 'short', size: '1', entry: '95000', margin: '7000', depth: '500000' } as const;
    expect(estimate(c)).toEqual({ price: null, reason: 'between_tiers' });
    expect(rungAt(c, parseAmount('100000.01')).action).toBe('liquidate');
    expect(rungAt(c, parseAmount('99999.99')).action).not.toBe('liquidate');
  });
});
