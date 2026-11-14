/**
 * The user-venue door's wiring (src/venue/): the doors, their router, our listings of the venue's markets and the
 * internal deposits read. index.ts calls `wireUserVenue` once and `startAtBoot` where the door used to connect, so a
 * journey that adds to the door edits this file, not the service's wiring file.
 */
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import type { EventBus } from '@intafaced/events';
import { VenueRefusalError } from '@intafaced/venue-contracts';
import type { ServiceAuthMode, ServiceSigner, ServiceVerifier, StepUpCheck } from '@intafaced/contracts';
import { env } from '../env.js';
import type { RankPerksSource } from '../spot/rank-perks.js';
import { builderFeesAt } from './builder-fee-versions.js';
import { createFeeSaverClient } from './fee-saver-client.js';
import { HttpUserVenue } from './http-user-venue.js';
import { registerInternalVenueDeposits } from './internal-deposits.js';
import { SqlPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor, parseBuilderFee, parseOrdersPageMax } from './user-venue-door.js';
import { SqlVenueListingStore } from './venue-listing-store.js';
import {
  StoreVenueRoutingGate,
  assertTestListingsAllowed,
  busVenueDelistingNotices,
  parseTestListings,
  publishPendingDelistingNotices,
  TestListingSeed,
} from './venue-listing.js';
import { UserVenueRouter, parseUserVenueUrls } from './venue-router.js';
import { SqlVenueSellQuoteStore, VenueSellQuotes } from './venue-sell-quotes.js';

export function wireUserVenue(deps: {
  app: FastifyInstance;
  sql: Sql;
  bus: Pick<EventBus, 'publish'>;
  stepUp: StepUpCheck;
  perks: RankPerksSource;
  outS2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
  doorS2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode };
}) {
  const { app, sql, bus, stepUp, perks, outS2s, doorS2s } = deps;
  // The B1 user-venue door (src/venue/): off unless TRADE_USER_VENUE_URL is set. A TEST venue is refused unless the RAW
  // APP_ENV is exactly dev or test; checked here at boot when the venue answers, and again whenever the door reconnects.
  const userVenueUrl = env.TRADE_USER_VENUE_URL.trim();
  // Our listings of the venue's markets (J-cex-spot-16). The LOCAL TEST seed lists the stack's TEST markets on a TEST venue
  // only, and is refused at boot outside APP_ENV dev or test.
  const venueListings = new SqlVenueListingStore(sql);
  const venueDelistingNotices = busVenueDelistingNotices(bus);
  const testListings = parseTestListings(env.TRADE_USER_VENUE_TEST_LISTINGS);
  assertTestListingsAllowed(testListings, process.env.APP_ENV);
  // Seeded once per process after the door first connects, never inside connect: a seed failure is logged and retried by
  // the sweep below, and the door (cancels included) keeps working.
  // J-derivatives-28: the primary venue, then each venue of TRADE_USER_VENUE_URLS (comma-separated), one door each, all
  // behind one router. Every door shares the store, the builder fee and the listing gate; each seeds its own TEST listings.
  const userVenueUrls = userVenueUrl ? [userVenueUrl, ...parseUserVenueUrls(env.TRADE_USER_VENUE_URLS)] : [];
  const userVenueStore = new SqlPreparedActionStore(sql);
  const testListingSeeds = userVenueUrls.map(
    () =>
      new TestListingSeed({
        store: venueListings,
        symbols: testListings,
        appEnv: process.env.APP_ENV,
        now: () => new Date(),
        log: (err) =>
          process.stderr.write(
            `${JSON.stringify({ level: 'warn', msg: 'trade.venue_listings.test_seed_failed', message: err instanceof Error ? err.message : String(err) })}\n`,
          ),
      }),
  );
  const feeSaverCoupons = env.CAMPAIGNS_URL.trim()
    ? createFeeSaverClient(env.CAMPAIGNS_URL.trim(), env.INTERNAL_SERVICE_SECRET, outS2s)
    : null;
  const userVenueDoors = userVenueUrls.map(
    (url, i) =>
      new UserVenueDoor({
        connect: async () => {
          const venue = await HttpUserVenue.connect({ baseUrl: url, timeoutMs: env.TRADE_USER_VENUE_TIMEOUT_MS });
          testListingSeeds[i]!.connected(venue);
          return venue;
        },
        listings: new StoreVenueRoutingGate(venueListings),
        appEnv: process.env.APP_ENV,
        store: userVenueStore,
        stepUp,
        builder: parseBuilderFee(env.TRADE_USER_VENUE_BUILDER_ADDRESS, env.TRADE_USER_VENUE_BUILDER_FEE_BPS),
        slippageCapBps: env.TRADE_MARKET_SLIPPAGE_CAP_BPS,
        spreadLimitBps: env.TRADE_MARKET_SPREAD_LIMIT_BPS,
        ordersPageMax: parseOrdersPageMax(env.TRADE_USER_VENUE_ORDERS_PAGE_MAX),
        // J-cex-spot-17: the builder-fee version in force when an order is prepared, by venue and market group.
        builderFeesAt: async (at) => (await builderFeesAt(sql, at)).book,
        now: () => new Date(),
        // J-campaigns-09 #2 #3: the rank's discount and a fee-saver coupon on our builder fee; either unreadable is skipped.
        feeDiscounts: {
          rankBps: async (userId) => {
            try {
              return (await perks.perksOf(userId)).feeDiscountBps;
            } catch {
              return null;
            }
          },
          coupons: feeSaverCoupons,
          skipped: (what, userId, orderKey) =>
            process.stderr.write(
              `${JSON.stringify({ level: 'warn', msg: 'trade.builder_fee_discount_skipped', what, userId, orderKey })}\n`,
            ),
        },
      }),
  );
  const userVenue = userVenueDoors[0] ?? null;
  const userVenueRouter =
    userVenueDoors.length > 0 ? new UserVenueRouter({ doors: userVenueDoors, store: userVenueStore, now: () => new Date() }) : null;
  // The primary venue's deposits for one wallet, read by svc-campaigns' welcome checklist (J-campaigns-04 #2 #3).
  registerInternalVenueDeposits(app, { door: userVenue, secret: env.INTERNAL_SERVICE_SECRET, s2s: doorS2s });
  // Convert's sell quotes priced by the venue on the customer's own venue account (J-cex-spot-17 #8), on the primary
  // venue's door. Off with the door.
  const venueSellQuotes = userVenue
    ? new VenueSellQuotes({ door: userVenue, store: new SqlVenueSellQuoteStore(sql), now: () => new Date() })
    : null;

  /** The listing sweep, then each door's first connect; index.ts awaits it where the door has always connected. */
  async function startAtBoot(): Promise<void> {
    // A delisting notice the bus did not take when it was written is sent again (the consumer files it once).
    setInterval(() => {
      for (const seed of testListingSeeds) void seed.retry();
      publishPendingDelistingNotices(venueListings, venueDelistingNotices, () => new Date()).catch((err: unknown) =>
        process.stderr.write(
          `${JSON.stringify({ level: 'warn', msg: 'trade.venue_delisting.notice_sweep_failed', message: String(err) })}\n`,
        ),
      );
    }, 60_000).unref();
    for (const door of userVenueDoors) {
      try {
        await door.venue();
      } catch (err) {
        if (err instanceof VenueRefusalError && err.refusal.code === 'test_venue_outside_test') throw err;
        process.stderr.write(
          `${JSON.stringify({ level: 'warn', msg: 'trade.user_venue.unreachable_at_boot', message: err instanceof Error ? err.message : String(err) })}\n`,
        );
      }
    }
  }

  return { userVenueDoors, userVenue, userVenueRouter, userVenueStore, venueListings, venueDelistingNotices, venueSellQuotes, startAtBoot };
}
