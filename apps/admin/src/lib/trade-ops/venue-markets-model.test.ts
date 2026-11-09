import { describe, expect, it } from 'vitest';
import { checkDelistsAt, checkLimits, checkOpensAt, checkRouting, parseVenueMarketsView } from './venue-markets-model';
import { wireView } from './venue-markets-fixtures.test-util';

describe('venue markets desk model (J-cex-spot-16)', () => {
  it('parses the desk read, ours beside the venue own, figures as the strings sent', () => {
    const v = parseVenueMarketsView(wireView());
    expect(v?.test).toBe(true);
    expect(v?.markets[0]).toMatchObject({ venue: { status: 'trading', maxOrderQty: '10' }, listing: { routing: 'stop', open: true } });
    expect(v?.markets[0]?.limits?.maxOrderQty).toBe('2');
    expect(v?.markets[1]).toMatchObject({ listing: null, venue: { status: null, maxOrderQty: null } });
  });

  it('refuses a read that is not that shape, and a TEST venue without its TEST label', () => {
    expect(parseVenueMarketsView(wireView({ label: undefined }))).toBeNull();
    expect(parseVenueMarketsView(wireView({ markets: [{ symbol: 'X' }] }))).toBeNull();
    expect(
      parseVenueMarketsView({ ...wireView(), markets: [{ ...wireView().markets[0], venue: { listed: true, status: 1 } }] }),
    ).toBeNull();
    expect(parseVenueMarketsView(null)).toBeNull();
  });

  it('refuses a blank opening window or delisting date by svc-trade own code, and a time without its zone', () => {
    expect(checkOpensAt('  ')).toMatchObject({ ok: false, code: 'trade.venue_listing_opening_window_blank' });
    expect(checkOpensAt('2026-11-09 12:00')).toMatchObject({ ok: false, code: 'trade.venue_listing_opening_window_invalid' });
    expect(checkOpensAt('2026-11-09T12:00:00Z')).toEqual({ ok: true, value: '2026-11-09T12:00:00Z' });
    expect(checkDelistsAt('')).toMatchObject({ ok: false, code: 'trade.venue_delisting_date_blank' });
    // A time that does not exist refuses, as svc-trade refuses it, never rolling into the next month.
    expect(checkOpensAt('2026-02-30T00:00:00Z')).toMatchObject({ ok: false, code: 'trade.venue_listing_opening_window_invalid' });
    expect(checkOpensAt('2026-11-09T24:00:00Z')).toMatchObject({ ok: false, code: 'trade.venue_listing_opening_window_invalid' });
    expect(checkDelistsAt('2027-02-29T00:00:00Z')).toMatchObject({ ok: false, code: 'trade.venue_delisting_date_invalid' });
    expect(checkDelistsAt('2026-12-01T00:00:00+25:00')).toMatchObject({ ok: false, code: 'trade.venue_delisting_date_invalid' });
    expect(checkDelistsAt('2028-02-29T00:00:00Z')).toEqual({ ok: true, value: '2028-02-29T00:00:00Z' });
    expect(checkRouting('pause')).toMatchObject({ ok: false, code: 'trade.venue_routing_invalid' });
    expect(checkRouting('close_only')).toEqual({ ok: true, value: 'close_only' });
  });

  it('refuses a blank limit, an inexact one, one above the venue own, and any when the venue reports none', () => {
    const venue = { maxOrderQty: '10', maxOrderNotional: '1000' };
    expect(checkLimits({ maxOrderQty: '', maxOrderNotional: '5' }, venue)).toMatchObject({ code: 'trade.venue_limit_blank' });
    expect(checkLimits({ maxOrderQty: '1', maxOrderNotional: ' ' }, venue)).toMatchObject({ code: 'trade.venue_limit_blank' });
    expect(checkLimits({ maxOrderQty: '1e3', maxOrderNotional: '5' }, venue)).toMatchObject({ code: 'trade.venue_limit_not_exact' });
    expect(checkLimits({ maxOrderQty: '0', maxOrderNotional: '5' }, venue)).toMatchObject({ code: 'trade.venue_limit_not_exact' });
    expect(checkLimits({ maxOrderQty: '10.000000000000000001', maxOrderNotional: '5' }, venue)).toMatchObject({
      code: 'trade.venue_limit_above_venue',
    });
    expect(checkLimits({ maxOrderQty: '1', maxOrderNotional: '1000.1' }, venue)).toMatchObject({ code: 'trade.venue_limit_above_venue' });
    expect(checkLimits({ maxOrderQty: '10', maxOrderNotional: '1000' }, venue)).toEqual({
      ok: true,
      value: { maxOrderQty: '10', maxOrderNotional: '1000' },
    });
    expect(checkLimits({ maxOrderQty: '1', maxOrderNotional: '5' }, { maxOrderQty: null, maxOrderNotional: '1' })).toMatchObject({
      code: 'trade.venue_limit_unknown',
    });
  });
});
