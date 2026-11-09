import { compare, formatAmount, mul, type Amount } from '@intafaced/ledger-client/money';
import type { EventBus } from '@intafaced/events';
import { isTestVenue, type PlaceUserOrderIntent, type UserVenue, type UserVenueMarket } from '@intafaced/venue-contracts';
import type { VenueLimitVersion, VenueListingStore, VenueListingVersion, VenueRoutingState } from './venue-listing-store.js';

/**
 * WHICH VENUE MARKETS WE SHOW, AND WHAT WE ROUTE TO THEM (J-cex-spot-16).
 *
 * The venue lists what it lists; INTAFACED shows a venue market only once two operators approved our listing of it
 * (`admin.venueMarkets.listingSet`), and routes a customer's new order to it only as our routing state, our opening and
 * delisting dates and our largest order allow. These are our rules on our door: the venue's own state and largest order
 * are the venue's and are shown beside ours, never replaced.
 *
 * A new order is checked here before the venue is asked to prepare it and again before it is first sent. A cancel is
 * never checked against any of this: a control that traps an order is not a safety control. Nothing here cancels an
 * order, touches an open venue order, or posts to the ledger.
 */

export type VenueRouteRefusalCode =
  | 'trade.venue_market_not_listed'
  | 'trade.venue_routing_stopped'
  | 'trade.venue_market_not_open'
  | 'trade.venue_market_delisted'
  | 'trade.venue_routing_close_only'
  | 'trade.venue_order_above_limit';

export class VenueRouteRefusal extends Error {
  constructor(
    readonly code: VenueRouteRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'VenueRouteRefusal';
  }
}

/** Our listing of one venue market as a customer read shows it, beside the venue's own state. */
export interface ShownListing {
  readonly version: number;
  readonly opensAt: Date;
  readonly delistsAt: Date | null;
  readonly routing: VenueRoutingState;
  /** True once `opensAt` has passed. */
  readonly open: boolean;
  /** True once `delistsAt` has passed: only reduce-only orders and cancels are routed. */
  readonly delisted: boolean;
  /** Our largest routed order, or `null` when none is written (the venue's own largest order applies). */
  readonly maxOrderQty: Amount | null;
  readonly maxOrderNotional: Amount | null;
}

export type ListedVenueMarket = UserVenueMarket & { readonly listing: ShownListing };

export interface VenueRoutingGate {
  /** The venue markets we show, each with our listing; a market with no approved listing is not in the map. */
  shown(venueId: string, at: Date): Promise<ReadonlyMap<string, ShownListing>>;
  /** Refuses a new order our listing, routing state, dates or largest order do not admit. Throws `VenueRouteRefusal`. */
  admitPlace(venueId: string, intent: PlaceUserOrderIntent, at: Date): Promise<void>;
}

function shownOf(listing: VenueListingVersion, limits: VenueLimitVersion | null, at: Date): ShownListing {
  return {
    version: listing.version,
    opensAt: listing.opensAt,
    delistsAt: listing.delistsAt,
    routing: listing.routing,
    open: listing.opensAt.getTime() <= at.getTime(),
    delisted: listing.delistsAt !== null && listing.delistsAt.getTime() <= at.getTime(),
    maxOrderQty: limits?.maxOrderQty ?? null,
    maxOrderNotional: limits?.maxOrderNotional ?? null,
  };
}

/** The gate on our own records (`VenueListingStore`). */
export class StoreVenueRoutingGate implements VenueRoutingGate {
  constructor(private readonly store: VenueListingStore) {}

  async shown(venueId: string, at: Date): Promise<ReadonlyMap<string, ShownListing>> {
    const latest = new Map<string, VenueListingVersion>();
    for (const row of await this.store.listingVersions(venueId)) latest.set(row.symbol, row);
    const limits = new Map<string, VenueLimitVersion>();
    for (const row of await this.store.limitVersions(venueId)) limits.set(row.symbol, row);
    const out = new Map<string, ShownListing>();
    for (const [symbol, listing] of latest) out.set(symbol, shownOf(listing, limits.get(symbol) ?? null, at));
    return out;
  }

  async admitPlace(venueId: string, intent: PlaceUserOrderIntent, at: Date): Promise<void> {
    const listing = await this.store.latestListing(venueId, intent.symbol);
    if (!listing) {
      throw new VenueRouteRefusal('trade.venue_market_not_listed', `${intent.symbol} is not a market INTAFACED shows on this venue`);
    }
    const shown = shownOf(listing, await this.store.latestLimits(venueId, intent.symbol), at);
    if (shown.routing === 'stop') {
      throw new VenueRouteRefusal('trade.venue_routing_stopped', `INTAFACED stopped routing new orders to ${intent.symbol}`);
    }
    if (!shown.open) {
      throw new VenueRouteRefusal(
        'trade.venue_market_not_open',
        `${intent.symbol} opens on INTAFACED at ${listing.opensAt.toISOString()}; no order is routed before then`,
      );
    }
    if (shown.delisted && !intent.reduceOnly) {
      throw new VenueRouteRefusal(
        'trade.venue_market_delisted',
        `${intent.symbol} was delisted on INTAFACED at ${listing.delistsAt!.toISOString()}; only closing (reduce-only) orders are routed`,
      );
    }
    if (shown.routing === 'close_only' && !intent.reduceOnly) {
      throw new VenueRouteRefusal(
        'trade.venue_routing_close_only',
        `INTAFACED routes only closing (reduce-only) orders to ${intent.symbol}`,
      );
    }
    if (shown.maxOrderQty !== null && compare(intent.amount, shown.maxOrderQty) > 0) {
      throw new VenueRouteRefusal(
        'trade.venue_order_above_limit',
        `the order size is above INTAFACED's largest routed order on ${intent.symbol} (${formatAmount(shown.maxOrderQty)})`,
      );
    }
    // Every order carries a price (a market order its worst price), so its notional is known.
    if (shown.maxOrderNotional !== null && compare(mul(intent.amount, intent.price, 'ceil'), shown.maxOrderNotional) > 0) {
      throw new VenueRouteRefusal(
        'trade.venue_order_above_limit',
        `the order notional is above INTAFACED's largest routed order on ${intent.symbol} (${formatAmount(shown.maxOrderNotional)})`,
      );
    }
  }
}

// ── The LOCAL TEST seed ─────────────────────────────────────────────────────

export const LOCAL_TEST_SEED_OPERATOR = 'LOCAL TEST seed' as const;

/** `TRADE_USER_VENUE_TEST_LISTINGS`: a comma list of venue symbols. Blank is none. */
export function parseTestListings(raw: string | undefined): readonly string[] {
  const text = (raw ?? '').trim();
  if (text === '') return [];
  const symbols = text.split(',').map((s) => s.trim());
  for (const s of symbols) {
    if (!/^[A-Z0-9][A-Z0-9/._-]{0,63}$/.test(s)) {
      throw new Error(`TRADE_USER_VENUE_TEST_LISTINGS must be a comma list of venue symbols, got ${JSON.stringify(raw)}`);
    }
  }
  return [...new Set(symbols)];
}

/** The seed is for the local TEST stack only: refused unless the RAW APP_ENV is exactly dev or test. */
export function assertTestListingsAllowed(symbols: readonly string[], appEnv: string | undefined): void {
  if (symbols.length === 0) return;
  if (appEnv !== 'dev' && appEnv !== 'test') {
    throw new Error(
      `TRADE_USER_VENUE_TEST_LISTINGS is a LOCAL TEST seed and is refused outside APP_ENV dev or test (got ${JSON.stringify(appEnv ?? null)})`,
    );
  }
}

/**
 * List `symbols` on a TEST venue as a LOCAL TEST seed, so the stack's other venue journeys see their markets: version 1
 * of each listing, routing `show`, open from now, recorded under `local-test-seed:<venueId>:<symbol>` with the operator
 * `LOCAL TEST seed`. A market already listed (seeded or approved) is left as it is; a symbol the venue does not list is
 * skipped. Refused on a venue that is not a TEST venue and outside APP_ENV dev or test. Returns the symbols it wrote.
 */
export async function seedTestListings(
  store: VenueListingStore,
  venue: UserVenue,
  symbols: readonly string[],
  appEnv: string | undefined,
  now: Date,
): Promise<readonly string[]> {
  if (symbols.length === 0) return [];
  assertTestListingsAllowed(symbols, appEnv);
  if (!isTestVenue(venue.venue)) throw new Error(`the LOCAL TEST listing seed is refused on ${venue.venue.id}: it is not a TEST venue`);
  const listed = new Set((await venue.markets(null)).value.map((m) => m.symbol));
  const written: string[] = [];
  for (const symbol of symbols) {
    if (!listed.has(symbol) || (await store.latestListing(venue.venue.id, symbol))) continue;
    const outcome = await store.appendListing({
      venueId: venue.venue.id,
      symbol,
      version: 1,
      change: 'listing',
      opensAt: now,
      delistsAt: null,
      routing: 'show',
      approvalId: `local-test-seed:${venue.venue.id}:${symbol}`,
      proposerId: LOCAL_TEST_SEED_OPERATOR,
      approverId: LOCAL_TEST_SEED_OPERATOR,
      executorId: LOCAL_TEST_SEED_OPERATOR,
      reason: 'LOCAL TEST seed: listed for the TEST stack',
      recordedAt: now,
    });
    if (outcome === 'written') written.push(symbol);
  }
  return written;
}

// ── The dated delisting notice ──────────────────────────────────────────────

export interface VenueDelistingNotices {
  /** Hand one notice to the bus; throws when the bus did not take it (the row stays pending). */
  publish(notice: { noticeKey: string; venueId: string; symbol: string; delistsAt: Date; scheduledAt: Date }): Promise<void>;
}

export function busVenueDelistingNotices(bus: Pick<EventBus, 'publish'>): VenueDelistingNotices {
  return {
    async publish(n) {
      await bus.publish(
        'venueDelistingScheduled',
        {
          venueId: n.venueId,
          symbol: n.symbol,
          delistsAt: n.delistsAt.toISOString(),
          scheduledAt: n.scheduledAt.toISOString(),
          noticeKey: n.noticeKey,
        },
        { idempotencyKey: n.noticeKey },
      );
    },
  };
}

/** No bus wired: every notice stays pending, and the desk read says so. */
export const NO_VENUE_DELISTING_NOTICES: VenueDelistingNotices = {
  async publish() {
    throw new Error('no event bus is wired for venue delisting notices');
  },
};

type Warn = (message: string, fields: Record<string, string>) => void;
const defaultWarn: Warn = (message, fields) => console.warn(JSON.stringify({ level: 'warn', msg: message, ...fields }));

/**
 * Publish every notice still pending, then mark it published. A notice the bus did not take stays pending for the next
 * run; the consumer files each under its own key, so a notice published twice (a crash between the send and the mark)
 * is still one notice.
 */
export async function publishPendingDelistingNotices(
  store: VenueListingStore,
  notices: VenueDelistingNotices,
  now: () => Date,
  warn: Warn = defaultWarn,
): Promise<number> {
  let sent = 0;
  for (const n of await store.pendingNotices(100)) {
    try {
      await notices.publish(n);
    } catch (err) {
      warn('trade.venue_delisting.notice_unsent', { noticeKey: n.noticeKey, error: String(err) });
      continue;
    }
    await store.markNoticePublished(n.noticeKey, now());
    sent += 1;
  }
  return sent;
}
