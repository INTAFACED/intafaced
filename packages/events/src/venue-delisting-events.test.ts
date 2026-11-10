import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG, WIRING_SOCKETS } from './catalog.js';
import { EVENT_BUS_MATRIX } from './socket-inventory.js';

const ok = {
  venueId: 'test-venue-sim',
  symbol: 'ETH-USDC',
  delistsAt: '2026-12-01T00:00:00.000Z',
  scheduledAt: '2026-11-09T12:00:00.000Z',
  noticeKey: 'venue-delisting:test-venue-sim:ETH-USDC:2026-12-01T00:00:00.000Z',
};

describe('J-cex-spot-16 #8 venue delisting event', () => {
  it('declares the subject under the subject law, version 1, deduped on the notice key', () => {
    expect(EVENT_CATALOG.venueDelistingScheduled.subject).toBe('intafaced.trade.venue_delisting.created');
    expect(EVENT_CATALOG.venueDelistingScheduled.version).toBe(1);
    expect(EVENT_CATALOG.venueDelistingScheduled.description).toContain('(noticeKey)');
  });

  it('carries the venue, the symbol, the dated delisting and the notice key; nothing else is a valid shape', () => {
    expect(EVENT_CATALOG.venueDelistingScheduled.schema.parse(ok)).toEqual(ok);
    for (const bad of [
      { ...ok, delistsAt: '' },
      { ...ok, delistsAt: 'next week' },
      { ...ok, symbol: '' },
      { ...ok, venueId: 'Test Venue' },
      { ...ok, noticeKey: '' },
    ]) {
      expect(EVENT_CATALOG.venueDelistingScheduled.schema.safeParse(bad).success).toBe(false);
    }
    const { delistsAt: _d, ...undated } = ok;
    expect(EVENT_CATALOG.venueDelistingScheduled.schema.safeParse(undated).success).toBe(false);
  });

  it('is wired end to end: published by svc-trade (venue/venue-listing-notices.ts), read by svc-notify', () => {
    expect(WIRING_SOCKETS.filter((s) => (s.event as string) === 'venueDelistingScheduled')).toEqual([]);
    expect(EVENT_BUS_MATRIX.venueDelistingScheduled).toEqual({ kind: 'live' });
  });
});
