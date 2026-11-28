import { describe, expect, it } from 'vitest';
import type { VenueFill, VenueOrder, VenuePosition } from '../../../features/trade/venue-api';
import { closeFeeBpsOf, exitOf, feeBasis, netAt, openingStop, rAt } from './exit-figures';

// J-derivatives-32: a stop and a target in dollars after fees and in R, from the venue's figures. Every figure is TEST.
const position = {
  symbol: 'ETH-PERP',
  side: 'long',
  size: '2',
  entryPrice: '3000',
  markPrice: '3050',
  unrealisedPnl: '100',
} as VenuePosition;
const fill = {
  symbol: 'ETH-PERP',
  side: 'buy',
  amount: '2',
  venueFee: '2.7',
  builderFee: '0.6',
  filledAt: '2026-11-28T00:00:00Z',
} as VenueFill;
const market = { takerFeeBps: { known: true, value: '4.5' } } as const;
const status = { builder: { address: '0x00000000000000000000000000000000000000b3', feeBps: '1' } };

describe('exit figures', () => {
  it('the close pays the venue’s taker rate and our fee; either blank, no rate', () => {
    expect(closeFeeBpsOf(market, status)).toBe(5_500_000_000_000_000_000n);
    expect(closeFeeBpsOf({ takerFeeBps: { known: false } }, status)).toBeNull();
    expect(closeFeeBpsOf(market, { builder: null })).toBeNull();
  });

  it('nets a price after the opening fees from the venue’s fills and the close’s fees, as breakeven does', () => {
    const basis = feeBasis(position, [fill], market, status);
    expect(netAt(position, '3100', basis)).toBe('193.29');
    expect(netAt(position, '3003.4', basis)).toBe('0.19626');
    expect(feeBasis(position, [], market, status)).toEqual({ ok: false, missing: 'history' });
    expect(netAt(position, '3100', feeBasis(position, [fill], market, { builder: null }))).toBeNull();
  });

  it('R is the result over what the opening stop risked, to two places toward zero; no risk, no R', () => {
    expect(rAt('193.29', '-206.71')).toBe('0.93');
    expect(rAt('-206.71', '-206.71')).toBe('-1.00');
    expect(rAt('0.19626', '-206.71')).toBe('0.00');
    expect(rAt('5', '0.19')).toBeNull();
    expect(rAt(null, '-1')).toBeNull();
  });

  it('remembers the stop a position opened with, so R keeps its unit after the stop moves; a new position starts again', () => {
    const kept = new Map<string, string>();
    const store = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
    expect(openingStop('0xA', position, null, store)).toBeNull();
    expect(openingStop('0xA', position, '2900', store)).toBe('2900');
    expect(openingStop('0xa', position, '3003.4', store)).toBe('2900');
    expect(openingStop('0xA', { ...position, size: '3' }, '2950', store)).toBe('2950');
  });

  it('finds the waiting reduce-only stop and target that close the position, by role', () => {
    const order = (role: string, side: string, state = 'waiting') =>
      ({ symbol: 'ETH-PERP', side, reduceOnly: true, venueClientOrderId: `0x${role}`, trigger: { price: '1', role, state } }) as VenueOrder;
    const orders = [order('stop_loss', 'buy'), order('take_profit', 'sell', 'triggered'), order('stop_loss', 'sell')];
    expect(exitOf(position, orders, 'stop_loss')?.side).toBe('sell');
    expect(exitOf(position, orders, 'take_profit')).toBeNull();
  });
});
