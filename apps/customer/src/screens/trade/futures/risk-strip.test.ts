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
  const fees = { venueInBps: '4.5', venueOutBps: '4.5', builderBps: '1' };
  const base = { risk: '50', entry: '3000', stop: '2950', mark: '3000', lot: '0.001', side: 'buy' as const, fees, minNotional: null };
  it('sizes a long so the stop loses at most the risk after fees both ways, rounded down to the lot', () => {
    // Per unit: 50 to the stop, 3000 × 5.5 bps = 1.65 in, 2950 × 5.5 bps = 1.6225 out: 53.2725. 50 / 53.2725 = 0.9385…
    expect(sizeFromRisk(base)).toEqual({ ok: true, size: '0.938', lossAtStop: '49.969605' });
    // Before fees it would be 1 ETH; the fees take it under.
    expect(sizeFromRisk({ ...base, fees: { venueInBps: '0', venueOutBps: '0', builderBps: '0' } })).toEqual({
      ok: true,
      size: '1',
      lossAtStop: '50',
    });
  });
  it('sizes a short from a stop above the mark and its entry', () => {
    // Per unit: 50 + 1.65 + 3050 × 5.5 bps = 1.6775: 53.3275.
    expect(sizeFromRisk({ ...base, side: 'sell', stop: '3050' })).toEqual({ ok: true, size: '0.937', lossAtStop: '49.9678675' });
  });
  it('never sizes a loss past the risk', () => {
    for (const stop of ['2999.9', '2990', '2900', '2500', '1000']) {
      const r = sizeFromRisk({ ...base, stop });
      if (!r.ok) throw new Error(`${stop}: ${r.reason}`);
      expect(Number(r.lossAtStop)).toBeLessThanOrEqual(50);
    }
  });
  it('refuses a stop on the wrong side, naming the mark or the entry it is measured against', () => {
    expect(sizeFromRisk({ ...base, stop: '3010' })).toEqual({ ok: false, reason: 'stop_wrong_side', against: 'mark', price: '3000' });
    expect(sizeFromRisk({ ...base, entry: '2900', stop: '2950' })).toEqual({
      ok: false,
      reason: 'stop_wrong_side',
      against: 'entry',
      price: '2900',
    });
    expect(sizeFromRisk({ ...base, side: 'sell', stop: '2990' })).toEqual({
      ok: false,
      reason: 'stop_wrong_side',
      against: 'mark',
      price: '3000',
    });
  });
  it("refuses a size under the venue's smallest order, naming the size it would need", () => {
    // 100 USDC at 3000 is 0.0333… ETH: 0.034 in whole lots. Per unit to 1500: 1500 + 1.65 + 0.825 = 1502.475.
    expect(sizeFromRisk({ ...base, stop: '1500', minNotional: '100' })).toEqual({
      ok: false,
      reason: 'below_minimum',
      size: '0.033',
      minSize: '0.034',
      minNotional: '100',
      minLoss: '51.08415',
    });
    // With no published smallest value, one lot is the smallest order.
    expect(sizeFromRisk({ ...base, risk: '0.01' })).toMatchObject({ ok: false, reason: 'below_minimum', size: '0', minSize: '0.001' });
  });
  it('refuses, naming why, rather than guessing', () => {
    expect(sizeFromRisk({ ...base, stop: '' })).toEqual({ ok: false, reason: 'no_stop' });
    expect(sizeFromRisk({ ...base, entry: null })).toEqual({ ok: false, reason: 'no_entry' });
    expect(sizeFromRisk({ ...base, risk: 'abc' })).toEqual({ ok: false, reason: 'no_risk' });
    expect(sizeFromRisk({ ...base, fees: { ...fees, builderBps: null } })).toEqual({ ok: false, reason: 'fee_unpublished' });
    expect(sizeFromRisk({ ...base, fees: { ...fees, venueOutBps: null } })).toEqual({ ok: false, reason: 'fee_unpublished' });
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
