import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FounderSession } from '@/lib/founder-session';
import { wireView, LISTED } from './venue-markets-fixtures.test-util';
import type { TradeCtx } from './edge';

/**
 * The desk's checks before anything is filed (J-cex-spot-16), against the read svc-trade answers: as svc-trade, only a
 * listing or a limit needs the venue to list the market now; a stop or a delisting stays proposable once the venue no
 * longer lists it. A malformed symbol is svc-trade's trade.venue_symbol_invalid, never "unknown market".
 */

let read: unknown;
vi.mock('./edge', () => ({
  trpcSpec: (_service: string, _path: string, _kind: string, _input: unknown, parse: (raw: unknown) => unknown) => ({ parse }),
  edgeCall: async (_ctx: unknown, spec: { parse: (raw: unknown) => unknown }) => {
    const data = spec.parse(read);
    return data === null ? { kind: 'refused', code: 'edge.bad_shape', message: 'bad shape', status: 502 } : { kind: 'ok', data };
  },
}));

const { venueChangeRequest } = await import('./venue-markets-calls');

const ctx = { session: {} as FounderSession, config: {} } as unknown as TradeCtx;
const REASON = 'TEST: J-cex-spot-16 console review';
const GONE = 'T16GONE-USDC';

beforeEach(() => {
  const view = wireView();
  read = {
    ...view,
    markets: [
      ...view.markets,
      {
        symbol: GONE,
        kind: null,
        baseAsset: null,
        quoteAsset: null,
        venue: { listed: false, status: null, maxOrderQty: null, maxOrderNotional: null },
        listing: { ...LISTED, routing: 'show', open: true, delisted: false },
        listingHistory: [LISTED],
        limits: null,
        limitHistory: [],
        delistingNotice: null,
      },
    ],
  };
});

const req = (body: Record<string, unknown>) => venueChangeRequest(ctx, { reason: REASON, ...body });

describe('venueChangeRequest (J-cex-spot-16)', () => {
  it('lets a stop and a delisting be proposed for a market the venue no longer lists', async () => {
    expect(await req({ change: 'routing', symbol: GONE, routing: 'stop' })).toMatchObject({
      kind: 'ok',
      data: { door: 'admin.venueMarkets.routingSet', fields: { routing: 'stop' }, currentVersion: '2' },
    });
    expect(await req({ change: 'delisting', symbol: GONE, delistsAt: '2026-12-01T00:00:00Z' })).toMatchObject({
      kind: 'ok',
      data: { door: 'admin.venueMarkets.delistingSchedule' },
    });
  });

  it('refuses a listing or a limit on a market the venue no longer lists, and a market not on the desk', async () => {
    expect(await req({ change: 'listing', symbol: GONE, opensAt: '2026-12-01T00:00:00Z' })).toMatchObject({
      kind: 'refused',
      code: 'trade.venue_market_unknown',
      status: 404,
    });
    expect(await req({ change: 'limits', symbol: GONE, maxOrderQty: '1', maxOrderNotional: '10' })).toMatchObject({
      kind: 'refused',
      code: 'trade.venue_market_unknown',
    });
    expect(await req({ change: 'routing', symbol: 'T16NONE-USDC', routing: 'stop' })).toMatchObject({
      kind: 'refused',
      code: 'trade.venue_market_unknown',
      status: 404,
    });
  });

  it('refuses a malformed symbol trade.venue_symbol_invalid (400) before reading the desk', async () => {
    read = null;
    for (const symbol of ['eth-usdc', 'ETH USDC', '']) {
      expect(await req({ change: 'routing', symbol, routing: 'stop' })).toMatchObject({
        kind: 'refused',
        code: 'trade.venue_symbol_invalid',
        status: 400,
      });
    }
  });
});
