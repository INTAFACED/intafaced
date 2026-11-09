import { describe, expect, it } from 'vitest';
import { fakeMarket, listingStatusOf, presentCcxtMarket } from './public-rest.js';

// J-cex-spot-14 #1: the markets list reads each market's listing status in words, and a delisting carries its date.
describe('listing status on the public market row', () => {
  const at = Date.parse('2026-11-09T00:00:00.000Z');
  const delistsAt = new Date('2026-11-16T00:00:00.000Z');

  it('names open, upcoming, halted, dated delisting and undated delisted listings', () => {
    expect(listingStatusOf({ status: 'active', delistsAt: null })).toBe('open');
    expect(listingStatusOf({ status: 'pending', delistsAt: null })).toBe('upcoming');
    expect(listingStatusOf({ status: 'halted', delistsAt: null })).toBe('halted');
    expect(listingStatusOf({ status: 'delisted', delistsAt })).toBe('delisting');
    expect(listingStatusOf({ status: 'delisted', delistsAt: null })).toBe('delisted');
    expect(listingStatusOf({ status: 'delisted', delistsAt: new Date('not a date') })).toBe('delisted');
  });

  it('publishes the status and the delisting date, and only an open market is orderable', () => {
    const open = presentCcxtMarket(fakeMarket({ symbol: 'BTC/USDT' }), at);
    expect(open).toMatchObject({ listing: 'open', delistsAt: null, orderable: true });

    const upcoming = presentCcxtMarket(fakeMarket({ symbol: 'NEW/USDT', status: 'pending' }), at);
    expect(upcoming).toMatchObject({ listing: 'upcoming', delistsAt: null, orderable: false, active: false });

    const delisting = presentCcxtMarket(fakeMarket({ symbol: 'OLD/USDT', status: 'delisted', delistsAt }), at);
    expect(delisting).toMatchObject({ listing: 'delisting', delistsAt: '2026-11-16T00:00:00.000Z', orderable: false, active: false });

    // A date left on a listing that is no longer delisted is never published.
    const reopened = presentCcxtMarket(fakeMarket({ symbol: 'OLD/USDT', status: 'active', delistsAt }), at);
    expect(reopened).toMatchObject({ listing: 'open', delistsAt: null });
  });
});
