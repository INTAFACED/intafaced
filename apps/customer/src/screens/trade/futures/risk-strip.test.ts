import { describe, expect, it } from 'vitest';
import type { VenueOrder, VenuePosition } from '../../../features/trade/venue-api';
import { dec, str, sub, times } from '../../../data/decimal';
import { positionLines, riskOf, sizeFromRisk } from './risk-strip';

const position = (over: Partial<VenuePosition>): VenuePosition =>
  ({
    symbol: 'BTC-PERP',
    side: 'long',
    size: '0.5',
    entryPrice: '96000',
    markPrice: '97000',
    unrealisedPnl: '500',
    ...over,
  }) as VenuePosition;
const trigger = (over: Partial<VenueOrder> & { at: string; role: string }): VenueOrder =>
  ({
    symbol: 'BTC-PERP',
    side: 'sell',
    type: 'trigger',
    reduceOnly: true,
    remaining: '0.5',
    trigger: { price: over.at, source: 'mark', role: over.role, state: 'waiting', triggeredAt: null, failure: null },
    ...over,
  }) as VenueOrder;

// What closing at a price nets, here before fees (the arithmetic of the totals), and one that knows no fees at all.
const gross = (p: VenuePosition, price: string) => {
  const move = times(sub(dec(price)!, dec(p.entryPrice)!), dec(p.size)!);
  return str(p.side === 'long' ? move : -move);
};
const unknown = () => null;

describe('riskOf (J-derivatives-32 #1)', () => {
  it('totals a long at its stop and its target, with each figure from the net it is given', () => {
    const r = riskOf([position({})], [trigger({ at: '95000', role: 'stop_loss' }), trigger({ at: '98500', role: 'take_profit' })], gross);
    expect(r).toMatchObject({ open: '500', ifStops: '-500', ifTargets: '1250', noStop: [], noTarget: [], feesUnknown: false, count: 1 });
  });
  it('signs a short the other way, and only counts triggers on the side that closes it', () => {
    const short = position({ side: 'short', entryPrice: '3400', size: '2', unrealisedPnl: '-20' });
    const r = riskOf(
      [short],
      [
        trigger({ symbol: 'BTC-PERP', side: 'buy', at: '3500', role: 'stop_loss' }),
        trigger({ side: 'sell', at: '3300', role: 'take_profit' }),
      ],
      gross,
    );
    expect(r.ifStops).toBe('-200');
    expect(r.noTarget).toEqual(['BTC-PERP']);
    expect(r.ifTargets).toBeNull();
  });
  it('a position with no stop is named, and there is no stop total in its place, never its open result', () => {
    const long = position({});
    const short = position({ symbol: 'ETH-PERP', side: 'short', entryPrice: '3000', size: '1', unrealisedPnl: '12.5' });
    const r = riskOf([long, short], [trigger({ at: '95000', role: 'stop_loss' }), trigger({ at: '98500', role: 'take_profit' })], gross);
    expect(r).toMatchObject({ ifStops: null, noStop: ['ETH-PERP'], ifTargets: '1250', noTarget: ['ETH-PERP'] });
  });
  it('with a fee not known, no total after fees is shown', () => {
    const r = riskOf([position({})], [trigger({ at: '95000', role: 'stop_loss' })], unknown);
    expect(r).toMatchObject({ ifStops: null, feesUnknown: true });
  });
});

describe('sizeFromRisk', () => {
  const base = { risk: '50', entry: '96000', stop: '95000', lot: '0.00001', side: 'buy' as const };
  it('sizes a long so the stop loses at most the risk, rounded down to the lot', () => {
    expect(sizeFromRisk(base)).toEqual({ ok: true, size: '0.05' });
    expect(sizeFromRisk({ ...base, risk: '33' })).toEqual({ ok: true, size: '0.033' });
    expect(sizeFromRisk({ ...base, stop: '95300' })).toEqual({ ok: true, size: '0.07142' });
  });
  it('sizes a short from a stop above its entry', () => {
    expect(sizeFromRisk({ ...base, side: 'sell', stop: '97000' })).toEqual({ ok: true, size: '0.05' });
  });
  it('refuses, naming why, rather than guessing', () => {
    expect(sizeFromRisk({ ...base, stop: '97000' })).toEqual({ ok: false, reason: 'stop_wrong_side' });
    expect(sizeFromRisk({ ...base, stop: '' })).toEqual({ ok: false, reason: 'no_stop' });
    expect(sizeFromRisk({ ...base, entry: null })).toEqual({ ok: false, reason: 'no_entry' });
    expect(sizeFromRisk({ ...base, risk: 'abc' })).toEqual({ ok: false, reason: 'no_risk' });
    expect(sizeFromRisk({ ...base, risk: '0.000001' })).toEqual({ ok: false, reason: 'below_lot' });
  });
});

describe('positionLines', () => {
  it('draws the entry, the resting stop and target with their results, and the published liquidation', () => {
    const p = position({ liquidationPrice: { known: true, value: '88000' } } as Partial<VenuePosition>);
    const lines = positionLines(p, [trigger({ at: '95000', role: 'stop_loss' }), trigger({ at: '98500', role: 'take_profit' })]);
    expect(lines).toEqual([
      { kind: 'entry', price: '96000', result: '500' },
      { kind: 'stop', price: '95000', result: '-500' },
      { kind: 'target', price: '98500', result: '1250' },
      { kind: 'liquidation', price: '88000', result: null },
    ]);
  });
  it('draws nothing without a position, and no liquidation the venue does not publish', () => {
    expect(positionLines(undefined, [])).toEqual([]);
    expect(positionLines(position({ liquidationPrice: { known: false } } as Partial<VenuePosition>), []).map((l) => l.kind)).toEqual([
      'entry',
    ]);
  });
});
