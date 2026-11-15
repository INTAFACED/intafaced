/**
 * J-cex-spot-16 router: a malformed venue symbol is BAD_REQUEST `trade.venue_symbol_invalid`; only a well-formed symbol
 * the venue does not list is NOT_FOUND `trade.venue_market_unknown`. The TEST venue simulator runs in process; no database.
 */
import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { router } from '@intafaced/contracts';
import { TEST_VENUE_MARKETS, TestVenueSimulator, seedTestVenue } from '@intafaced/venue-sim';
import { principalFor } from '../spot/testing.js';
import { MemoryVenueListingStore } from '../venue/venue-listing-store.js';
import { MemoryApprovalBook } from './common.js';
import { tradeOpsAdminRouter } from './router.js';
import type { TradeOpsAdmin } from './service.js';
import { VenueMarketsAdmin } from './venue-markets.js';

const OP = '33333333-3333-4333-8333-333333333333';
const REASON = 'TEST: J-cex-spot-16 router review';

async function caller() {
  const now = new Date('2026-11-09T12:00:00.000Z');
  const sim = new TestVenueSimulator({ clock: () => now, markets: TEST_VENUE_MARKETS, chainId: 84532 });
  await seedTestVenue(sim);
  const store = new MemoryVenueListingStore();
  const venueMarkets = new VenueMarketsAdmin({
    venue: async () => sim,
    store,
    approvals: new MemoryApprovalBook(),
    notices: { publish: async () => {} },
    now: () => now,
  });
  const admin = { venueMarkets } as unknown as TradeOpsAdmin;
  const context = { principal: principalFor(OP, ['admin:read', 'admin:write']), region: 'SG', service: null, requestId: 'ctx' };
  return { store, call: router({ admin: tradeOpsAdminRouter(admin) }).createCaller(context as never) };
}

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => {
      expect(e).toBeInstanceOf(TRPCError);
      const t = e as TRPCError;
      return [t.code, (t.cause as { code?: string } | undefined)?.code];
    },
  );

describe('venue markets router (J-cex-spot-16)', () => {
  it('a malformed symbol is BAD_REQUEST trade.venue_symbol_invalid; an unknown well-formed one is NOT_FOUND', async () => {
    const { store, call } = await caller();
    const listing = (symbol: string) =>
      call.admin.venueMarkets.listingSet({
        symbol,
        opensAt: '2026-11-09T12:00:00Z',
        expectedVersion: '0',
        reason: REASON,
        approvalId: 'approval-router',
        operationId: 'op-router',
      });
    for (const bad of ['eth-usdc', 'ETH USDC', '-ETH', 'ETH;DROP']) {
      expect(await refusal(listing(bad))).toEqual(['BAD_REQUEST', 'trade.venue_symbol_invalid']);
      expect(
        await refusal(
          call.admin.venueMarkets.routingSet({
            symbol: bad,
            routing: 'stop',
            expectedVersion: '1',
            reason: REASON,
            approvalId: 'approval-router',
            operationId: 'op-router',
          }),
        ),
      ).toEqual(['BAD_REQUEST', 'trade.venue_symbol_invalid']);
    }
    expect(await refusal(listing('SOL-USDC'))).toEqual(['NOT_FOUND', 'trade.venue_market_unknown']);
    expect(await store.listingVersions('test-venue-sim')).toEqual([]);
  });
});
