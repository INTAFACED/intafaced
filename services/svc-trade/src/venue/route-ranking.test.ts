import { describe, expect, it } from 'vitest';
import { parseAmount as a } from '@intafaced/ledger-client/money';
import type { MaybeKnown, VenueAssetAmount, VenueOrderPreview } from '@intafaced/venue-contracts';
import { rankRoute } from './route-ranking.js';

// The ranking of J-derivatives-28 #2 (spec D-venue-02), on TEST previews built here. No venue is read.

const ASSETS = { base: 'BTC', quote: 'USDC' };
const fee = (amount: string | null, asset = 'USDC'): MaybeKnown<VenueAssetAmount> =>
  amount === null ? { known: false } : { known: true, value: { asset, amount: a(amount) } };

function preview(fills: string, avg: string | null, venueFee: string | null, builderFee: string | null = '0'): VenueOrderPreview {
  return {
    symbol: 'BTC-PERP',
    kind: 'perpetual',
    lock: { asset: 'USDC', amount: a('1') },
    role: 'taker',
    venueFee: fee(venueFee),
    builderFee: fee(builderFee),
    fill: { known: true, value: { amount: a(fills), averagePrice: avg === null ? null : a(avg) } },
    perpetual: null,
  };
}
const buy = { side: 'buy' as const, amount: a('2') };
const sell = { side: 'sell' as const, amount: a('2') };

describe('rankRoute', () => {
  it('none: null; one: only_venue', () => {
    expect(rankRoute([], buy, ASSETS)).toBeNull();
    expect(rankRoute([{ venueId: 'x', preview: preview('2', '100', '1') }], buy, ASSETS)?.reason).toBe('only_venue');
  });

  it('a whole fill beats a part fill even when the part is cheaper per unit', () => {
    const r = rankRoute(
      [
        { venueId: 'a', preview: preview('1', '90', '0') },
        { venueId: 'b', preview: preview('2', '100', '1') },
      ],
      buy,
      ASSETS,
    )!;
    expect([r.chosen.venueId, r.reason]).toEqual(['b', 'fills_whole']);
  });

  it('between whole fills: a buy takes the lowest total, a sell the highest proceeds, fees counted', () => {
    const c = [
      { venueId: 'a', preview: preview('2', '100', '0.5') }, // buy 200.5, sell 199.5
      { venueId: 'b', preview: preview('2', '100.1', '0') }, // buy 200.2, sell 200.2
    ];
    expect(rankRoute(c, buy, ASSETS)!.chosen.venueId).toBe('b');
    expect(rankRoute(c, buy, ASSETS)!.reason).toBe('lowest_cost');
    expect(rankRoute(c, buy, ASSETS)!.chosen.total).toBe(a('200.2'));
    const s = [
      { venueId: 'a', preview: preview('2', '100', '0.5') },
      { venueId: 'b', preview: preview('2', '99.9', '0') }, // sell 199.8
    ];
    expect(rankRoute(s, sell, ASSETS)!.chosen.venueId).toBe('b');
  });

  it('a fee not published is left out of the cost and named, never read as zero', () => {
    const r = rankRoute([{ venueId: 'a', preview: preview('2', '100', null) }], buy, ASSETS)!;
    expect(r.chosen.unknownFees).toEqual(['venue_fee']);
    expect(r.chosen.knownFees).toBe(a('0'));
  });

  it('a fee in the base asset is valued at the fill price; one in another asset is named', () => {
    const p = { ...preview('2', '100', null), venueFee: fee('0.01', 'BTC') };
    expect(rankRoute([{ venueId: 'a', preview: p }], buy, ASSETS)!.chosen.knownFees).toBe(a('1'));
    const q = { ...preview('2', '100', null), venueFee: fee('0.01', 'ETH') };
    expect(rankRoute([{ venueId: 'a', preview: q }], buy, ASSETS)!.chosen.unknownFees).toEqual(['venue_fee']);
  });

  it('between part fills: the larger fill now, then the cheaper per unit; equal: by venue id, stably', () => {
    const more = rankRoute(
      [
        { venueId: 'a', preview: preview('1', '100', '0') },
        { venueId: 'b', preview: preview('1.5', '101', '0') },
      ],
      buy,
      ASSETS,
    )!;
    expect([more.chosen.venueId, more.reason]).toEqual(['b', 'fills_most']);
    const cheaper = rankRoute(
      [
        { venueId: 'a', preview: preview('1', '101', '0') },
        { venueId: 'b', preview: preview('1', '100', '0') },
      ],
      buy,
      ASSETS,
    )!;
    expect([cheaper.chosen.venueId, cheaper.reason]).toEqual(['b', 'lowest_cost']);
    const tie = [
      { venueId: 'b', preview: preview('2', '100', '0') },
      { venueId: 'a', preview: preview('2', '100', '0') },
    ];
    expect([rankRoute(tie, buy, ASSETS)!.chosen.venueId, rankRoute(tie, buy, ASSETS)!.reason]).toEqual(['a', 'tie_by_id']);
    expect(rankRoute([...tie].reverse(), buy, ASSETS)!.chosen.venueId).toBe('a');
  });

  it('nothing fills now anywhere: by venue id', () => {
    const r = rankRoute(
      [
        { venueId: 'b', preview: preview('0', null, '0') },
        { venueId: 'a', preview: preview('0', null, '0') },
      ],
      buy,
      ASSETS,
    )!;
    expect([r.chosen.venueId, r.reason]).toEqual(['a', 'tie_by_id']);
  });
});
