/**
 * The venue markets desk (J-cex-spot-16): which markets of the outside venue INTAFACED shows, our routing state for each,
 * our largest routed order, and a scheduled delisting, each written by two operators. The venue's own state and largest
 * order are read live and shown beside ours.
 *
 *   admin.venueMarkets.list               every venue market and every listing we hold, ours beside the venue's (admin:read)
 *   admin.venueMarkets.listingSet         list a market, or move its opening time          `trade.venue_listing_set`
 *   admin.venueMarkets.routingSet         show | close_only | stop                         `trade.venue_routing_set`
 *   admin.venueMarkets.limitsSet          our largest order size and notional              `trade.venue_limits_set`
 *   admin.venueMarkets.delistingSchedule  the date the market leaves; one dated notice     `trade.venue_delisting_schedule`
 *
 * Each write consumes identity's two-person approval (the proposer cannot approve their own: identity refuses
 * `action_approval.same_person`), bound to the target, the version the operators saw and the hash of exactly what is
 * written. The approval id is the business key: a retry of an approved write writes nothing new and answers the version
 * it wrote. A blank or malformed value refuses by name before any approval is spent.
 *
 * Money: none. A routing state, a limit or a delisting moves nothing and cancels nothing; open venue orders stay as they
 * are on the venue, and no ledger recipe is imported here.
 */
import { compare, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type { Principal } from '@intafaced/auth';
import { isTestVenue, type UserVenue, type UserVenueMarket } from '@intafaced/venue-contracts';
import {
  delistingNoticeKey,
  VENUE_ROUTING_STATES,
  type VenueDelistingNotice,
  type VenueLimitVersion,
  type VenueListingStore,
  type VenueListingVersion,
  type VenueRoutingState,
} from '../venue/venue-listing-store.js';
import { publishPendingDelistingNotices, type VenueDelistingNotices } from '../venue/venue-listing.js';
import {
  consumeApproval,
  payloadHash,
  requireOperator,
  requireOperatorWrite,
  requireReason,
  TradeOpsError,
  type ApprovalBook,
} from './common.js';

export const VENUE_LISTING_SET_ACTION = 'trade.venue_listing_set' as const;
export const VENUE_ROUTING_SET_ACTION = 'trade.venue_routing_set' as const;
export const VENUE_LIMITS_SET_ACTION = 'trade.venue_limits_set' as const;
export const VENUE_DELISTING_SCHEDULE_ACTION = 'trade.venue_delisting_schedule' as const;

/** The approval target of a market's listing line (listing, routing and delisting share one version line). */
export const venueListingTarget = (venueId: string, symbol: string) => `venue-listing:${venueId}:${symbol}`;
/** The approval target of a market's routed-order limits. */
export const venueLimitsTarget = (venueId: string, symbol: string) => `venue-limits:${venueId}:${symbol}`;

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;

/** An exact unsigned decimal in its one canonical spelling (no trailing fraction zeros), the form every hash binds. */
export function canonicalVenueDecimal(value: string): string {
  const [whole, frac = ''] = value.split('.');
  const f = frac.replace(/0+$/, '');
  return f === '' ? whole! : `${whole}.${f}`;
}

/**
 * A time as the canonical ISO string the hash binds, or null when it is not a real time: ISO with its zone, and every
 * field in range (no 2026-02-30, no 24:00, no +25:00), so a time never silently rolls over into another day.
 */
export function canonicalVenueTime(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [number, number, number, number, number, number];
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth || h > 23 || mi > 59 || s > 59) return null;
  if (m[7] !== 'Z' && (Number(m[9]) > 23 || Number(m[10]) > 59)) return null;
  const at = new Date(value.trim());
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

export function venueListingPayloadHash(b: { venueId: string; symbol: string; opensAt: string; expectedVersion: string; reason: string }) {
  return payloadHash({ actionType: VENUE_LISTING_SET_ACTION, ...b });
}
export function venueRoutingPayloadHash(b: { venueId: string; symbol: string; routing: string; expectedVersion: string; reason: string }) {
  return payloadHash({ actionType: VENUE_ROUTING_SET_ACTION, ...b });
}
export function venueLimitsPayloadHash(b: {
  venueId: string;
  symbol: string;
  maxOrderQty: string;
  maxOrderNotional: string;
  expectedVersion: string;
  reason: string;
}) {
  return payloadHash({ actionType: VENUE_LIMITS_SET_ACTION, ...b });
}
export function venueDelistingPayloadHash(b: {
  venueId: string;
  symbol: string;
  delistsAt: string;
  expectedVersion: string;
  reason: string;
}) {
  return payloadHash({ actionType: VENUE_DELISTING_SCHEDULE_ACTION, ...b });
}

/** One write. The venue is the door's connected venue (one per deployment); its id is bound into every hash. */
interface WriteBase {
  readonly symbol: string;
  /** The version the operators saw: `0` when there is none yet. */
  readonly expectedVersion: string;
  readonly reason: string;
  readonly approvalId: string;
  readonly operationId: string;
}
export interface VenueListingSetInput extends WriteBase {
  /** When the market opens on INTAFACED (ISO). Blank or null refuses `trade.venue_listing_opening_window_blank`. */
  readonly opensAt: string | null;
}
export interface VenueRoutingSetInput extends WriteBase {
  readonly routing: string;
}
export interface VenueLimitsSetInput extends WriteBase {
  readonly maxOrderQty: string | null;
  readonly maxOrderNotional: string | null;
}
export interface VenueDelistingScheduleInput extends WriteBase {
  readonly delistsAt: string | null;
}

export interface VenueMarketsDeps {
  /** The connected venue; `null` when the user-venue door is off (every door refuses `trade.user_venue_off`). */
  readonly venue: (() => Promise<UserVenue>) | null;
  readonly store: VenueListingStore;
  readonly approvals: ApprovalBook;
  readonly notices: VenueDelistingNotices;
  readonly now: () => Date;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const dec = (a: Amount | null) => (a === null ? null : formatAmount(a));

function listingView(r: VenueListingVersion) {
  return {
    version: r.version,
    change: r.change,
    opensAt: r.opensAt.toISOString(),
    delistsAt: iso(r.delistsAt),
    routing: r.routing,
    approvalId: r.approvalId,
    proposerId: r.proposerId,
    approverId: r.approverId,
    executorId: r.executorId,
    reason: r.reason,
    recordedAt: r.recordedAt.toISOString(),
  };
}
function limitView(r: VenueLimitVersion) {
  return {
    version: r.version,
    maxOrderQty: formatAmount(r.maxOrderQty),
    maxOrderNotional: formatAmount(r.maxOrderNotional),
    venueMaxOrderQtyAtWrite: formatAmount(r.venueMaxOrderQty),
    venueMaxOrderNotionalAtWrite: formatAmount(r.venueMaxOrderNotional),
    approvalId: r.approvalId,
    proposerId: r.proposerId,
    approverId: r.approverId,
    executorId: r.executorId,
    reason: r.reason,
    recordedAt: r.recordedAt.toISOString(),
  };
}
function noticeView(n: VenueDelistingNotice | null) {
  return n ? { noticeKey: n.noticeKey, delistsAt: n.delistsAt.toISOString(), publishedAt: iso(n.publishedAt) } : null;
}

export class VenueMarketsAdmin {
  constructor(private readonly deps: VenueMarketsDeps) {}

  private async connected(): Promise<UserVenue> {
    if (!this.deps.venue) throw new TradeOpsError('trade.user_venue_off', 'the user-venue door is off on this deployment');
    return this.deps.venue();
  }

  private async venueMarket(venue: UserVenue, symbol: string): Promise<UserVenueMarket> {
    const market = (await venue.markets(null)).value.find((m) => m.symbol === symbol);
    if (!market) throw new TradeOpsError('trade.venue_market_unknown', `${symbol} is not listed on ${venue.venue.id}`);
    return market;
  }

  /** Every venue market and every listing we hold, ours beside the venue's own state and largest order. */
  async list(principal: Principal) {
    requireOperator(principal);
    const venue = await this.connected();
    await publishPendingDelistingNotices(this.deps.store, this.deps.notices, this.deps.now);
    const read = await venue.markets(null);
    const now = this.deps.now();
    const listings = await this.deps.store.listingVersions(venue.venue.id);
    const limits = await this.deps.store.limitVersions(venue.venue.id);
    const symbols = [...new Set([...read.value.map((m) => m.symbol), ...listings.map((l) => l.symbol)])];
    const markets = [];
    for (const symbol of symbols) {
      const m = read.value.find((x) => x.symbol === symbol) ?? null;
      const history = listings.filter((l) => l.symbol === symbol);
      const limitHistory = limits.filter((l) => l.symbol === symbol);
      const current = history.at(-1) ?? null;
      const delisting = current?.delistsAt
        ? await this.deps.store.noticeByApproval(history.find((h) => h.change === 'delisting')!.approvalId)
        : null;
      markets.push({
        symbol,
        kind: m?.kind ?? null,
        baseAsset: m?.baseAsset ?? null,
        quoteAsset: m?.quoteAsset ?? null,
        // The venue's own word: null where it reports none, and `listed: false` once the venue no longer lists it.
        venue: {
          listed: m !== null,
          status: m?.status ?? null,
          maxOrderQty: dec(m?.maxOrderQty ?? null),
          maxOrderNotional: dec(m?.maxOrderNotional ?? null),
        },
        listing: current
          ? {
              ...listingView(current),
              open: current.opensAt.getTime() <= now.getTime(),
              delisted: current.delistsAt !== null && current.delistsAt.getTime() <= now.getTime(),
            }
          : null,
        listingHistory: history.map(listingView),
        limits: limitHistory.length ? limitView(limitHistory.at(-1)!) : null,
        limitHistory: limitHistory.map(limitView),
        delistingNotice: noticeView(delisting),
      });
    }
    const test = isTestVenue(venue.venue);
    return { venueId: venue.venue.id, test, ...(test ? { label: 'TEST' as const } : {}), asOf: read.asOf.toISOString(), markets };
  }

  private symbolOf(input: WriteBase): { venueSymbol: string } {
    const s = (input.symbol ?? '').trim();
    if (!/^[A-Z0-9][A-Z0-9/._-]{0,63}$/.test(s)) throw new TradeOpsError('trade.venue_market_unknown', 'symbol is a venue symbol');
    return { venueSymbol: s };
  }

  private version(text: string, code: string): number {
    if (!/^(?:0|[1-9]\d{0,8})$/.test((text ?? '').trim())) throw new TradeOpsError(code, 'expectedVersion is a whole number');
    return Number(text.trim());
  }

  /**
   * One listing-line write: replay by approval, stale check, consume, append. If the append fails after the approval was
   * consumed, nothing was written and the approval is spent; the operators approve again.
   */
  private async writeListing(
    principal: Principal,
    input: WriteBase,
    actionType: string,
    hash: string,
    build: (
      current: VenueListingVersion | null,
    ) => Omit<VenueListingVersion, 'version' | 'approvalId' | 'proposerId' | 'approverId' | 'executorId' | 'recordedAt'>,
    same: (stored: VenueListingVersion) => boolean,
    venueId: string,
  ) {
    const replay = await this.deps.store.listingByApproval(input.approvalId);
    if (replay) {
      if (replay.venueId !== venueId || replay.symbol !== input.symbol || !same(replay)) {
        throw new TradeOpsError('approval_reused', 'this approval already wrote a different change');
      }
      await publishPendingDelistingNotices(this.deps.store, this.deps.notices, this.deps.now);
      return this.answerListing(replay);
    }
    const expected = this.version(input.expectedVersion, 'trade.venue_listing_stale');
    const current = await this.deps.store.latestListing(venueId, input.symbol);
    if ((current?.version ?? 0) !== expected) {
      throw new TradeOpsError('trade.venue_listing_stale', `expected version ${expected}; the listing is at ${current?.version ?? 0}`);
    }
    const fields = build(current);
    const consumed = await consumeApproval(this.deps.approvals, {
      approvalId: input.approvalId,
      actionType,
      targetId: venueListingTarget(venueId, input.symbol),
      expectedVersion: String(expected),
      payloadHash: hash,
      operationId: input.operationId,
    });
    const at = this.deps.now();
    const row: VenueListingVersion = {
      ...fields,
      version: expected + 1,
      approvalId: input.approvalId,
      proposerId: consumed.requesterId,
      approverId: consumed.approverId,
      executorId: principal.userId,
      recordedAt: at,
    };
    const notice =
      row.change === 'delisting' && row.delistsAt
        ? {
            noticeKey: delistingNoticeKey(venueId, input.symbol, row.delistsAt),
            approvalId: input.approvalId,
            venueId,
            symbol: input.symbol,
            delistsAt: row.delistsAt,
            scheduledAt: at,
          }
        : undefined;
    const outcome = await this.deps.store.appendListing(row, notice);
    if (outcome === 'stale') {
      throw new TradeOpsError('trade.venue_listing_stale', 'another approved change landed first; the approval is spent, approve again');
    }
    const stored = (await this.deps.store.listingByApproval(input.approvalId))!;
    // The notice row is written with the version; it is sent now, and again by the next run if the bus did not take it.
    await publishPendingDelistingNotices(this.deps.store, this.deps.notices, this.deps.now);
    return this.answerListing(stored);
  }

  private async answerListing(row: VenueListingVersion) {
    return {
      venueId: row.venueId,
      symbol: row.symbol,
      listing: listingView(row),
      delistingNotice: noticeView(await this.deps.store.noticeByApproval(row.approvalId)),
    };
  }

  async listingSet(principal: Principal, input: VenueListingSetInput) {
    requireOperatorWrite(principal);
    const { venueSymbol } = this.symbolOf(input);
    const reason = requireReason(input.reason);
    if (input.opensAt === null || input.opensAt === undefined || input.opensAt.trim() === '') {
      throw new TradeOpsError('trade.venue_listing_opening_window_blank', 'a listing needs its opening time; nothing was written');
    }
    const opensAt = canonicalVenueTime(input.opensAt);
    if (!opensAt) throw new TradeOpsError('trade.venue_listing_opening_window_invalid', 'opensAt is an ISO time');
    const venue = await this.connected();
    await this.venueMarket(venue, venueSymbol);
    const venueId = venue.venue.id;
    return this.writeListing(
      principal,
      { ...input, symbol: venueSymbol },
      VENUE_LISTING_SET_ACTION,
      venueListingPayloadHash({ venueId, symbol: venueSymbol, opensAt, expectedVersion: input.expectedVersion.trim(), reason }),
      (current) => {
        if (current?.delistsAt && current.delistsAt.getTime() <= Date.parse(opensAt)) {
          throw new TradeOpsError('trade.venue_listing_opening_window_invalid', 'the market would open after its delisting date');
        }
        return {
          venueId,
          symbol: venueSymbol,
          change: 'listing',
          opensAt: new Date(opensAt),
          delistsAt: current?.delistsAt ?? null,
          routing: current?.routing ?? 'show',
          reason,
        };
      },
      (stored) => stored.change === 'listing' && stored.opensAt.toISOString() === opensAt && stored.reason === reason,
      venueId,
    );
  }

  async routingSet(principal: Principal, input: VenueRoutingSetInput) {
    requireOperatorWrite(principal);
    const { venueSymbol } = this.symbolOf(input);
    const reason = requireReason(input.reason);
    if (!(VENUE_ROUTING_STATES as readonly string[]).includes(input.routing)) {
      throw new TradeOpsError('trade.venue_routing_invalid', 'routing is show, close_only or stop');
    }
    const routing = input.routing as VenueRoutingState;
    const venue = await this.connected();
    const venueId = venue.venue.id;
    return this.writeListing(
      principal,
      { ...input, symbol: venueSymbol },
      VENUE_ROUTING_SET_ACTION,
      venueRoutingPayloadHash({ venueId, symbol: venueSymbol, routing, expectedVersion: input.expectedVersion.trim(), reason }),
      (current) => {
        if (!current) throw new TradeOpsError('trade.venue_listing_missing', `${venueSymbol} has no listing; list it first`);
        if (current.routing === routing)
          throw new TradeOpsError('trade.venue_routing_unchanged', `the routing state is already ${routing}`);
        return { ...current, change: 'routing', routing, reason };
      },
      (stored) => stored.change === 'routing' && stored.routing === routing && stored.reason === reason,
      venueId,
    );
  }

  async delistingSchedule(principal: Principal, input: VenueDelistingScheduleInput) {
    requireOperatorWrite(principal);
    const { venueSymbol } = this.symbolOf(input);
    const reason = requireReason(input.reason);
    if (input.delistsAt === null || input.delistsAt === undefined || input.delistsAt.trim() === '') {
      throw new TradeOpsError('trade.venue_delisting_date_blank', 'a delisting needs its date; nothing was written');
    }
    const delistsAt = canonicalVenueTime(input.delistsAt);
    if (!delistsAt) throw new TradeOpsError('trade.venue_delisting_date_invalid', 'delistsAt is an ISO time');
    const venue = await this.connected();
    const venueId = venue.venue.id;
    return this.writeListing(
      principal,
      { ...input, symbol: venueSymbol },
      VENUE_DELISTING_SCHEDULE_ACTION,
      venueDelistingPayloadHash({ venueId, symbol: venueSymbol, delistsAt, expectedVersion: input.expectedVersion.trim(), reason }),
      (current) => {
        if (!current) throw new TradeOpsError('trade.venue_listing_missing', `${venueSymbol} has no listing; list it first`);
        // One dated notice per market: a date once scheduled is not moved through this door.
        if (current.delistsAt) {
          throw new TradeOpsError(
            'trade.venue_delisting_already_scheduled',
            `${venueSymbol} is already delisting at ${current.delistsAt.toISOString()}`,
          );
        }
        const at = new Date(delistsAt);
        if (at.getTime() <= this.deps.now().getTime())
          throw new TradeOpsError('trade.venue_delisting_not_future', 'the delisting date must be in the future');
        if (at.getTime() <= current.opensAt.getTime()) {
          throw new TradeOpsError('trade.venue_delisting_not_future', 'the delisting date must be after the market opens');
        }
        return { ...current, change: 'delisting', delistsAt: at, reason };
      },
      (stored) => stored.change === 'delisting' && stored.delistsAt?.toISOString() === delistsAt && stored.reason === reason,
      venueId,
    );
  }

  async limitsSet(principal: Principal, input: VenueLimitsSetInput) {
    requireOperatorWrite(principal);
    const { venueSymbol } = this.symbolOf(input);
    const reason = requireReason(input.reason);
    const exact = (value: string | null | undefined, label: string): string => {
      const text = (value ?? '').trim();
      if (text === '') throw new TradeOpsError('trade.venue_limit_blank', `${label} is blank; a limit is never filled in`);
      if (!DECIMAL.test(text)) throw new TradeOpsError('trade.venue_limit_not_exact', `${label} must be an exact unsigned decimal string`);
      const canonical = canonicalVenueDecimal(text);
      if (parseAmount(canonical) <= 0n) throw new TradeOpsError('trade.venue_limit_not_exact', `${label} must be above zero`);
      return canonical;
    };
    const maxOrderQty = exact(input.maxOrderQty, 'maxOrderQty');
    const maxOrderNotional = exact(input.maxOrderNotional, 'maxOrderNotional');
    const venue = await this.connected();
    const venueId = venue.venue.id;
    const qty = parseAmount(maxOrderQty);
    const notional = parseAmount(maxOrderNotional);

    const replay = await this.deps.store.limitsByApproval(input.approvalId);
    if (replay) {
      if (
        replay.venueId !== venueId ||
        replay.symbol !== venueSymbol ||
        replay.maxOrderQty !== qty ||
        replay.maxOrderNotional !== notional ||
        replay.reason !== reason
      ) {
        throw new TradeOpsError('approval_reused', 'this approval already wrote a different change');
      }
      return { venueId, symbol: venueSymbol, limits: limitView(replay) };
    }
    if (!(await this.deps.store.latestListing(venueId, venueSymbol))) {
      throw new TradeOpsError('trade.venue_listing_missing', `${venueSymbol} has no listing; list it first`);
    }
    const expected = this.version(input.expectedVersion, 'trade.venue_limit_stale');
    const current = await this.deps.store.latestLimits(venueId, venueSymbol);
    if ((current?.version ?? 0) !== expected) {
      throw new TradeOpsError('trade.venue_limit_stale', `expected version ${expected}; the limits are at ${current?.version ?? 0}`);
    }
    // Never above the venue's own: a venue that reports no largest order cannot prove it, so nothing is written.
    const market = await this.venueMarket(venue, venueSymbol);
    if (market.maxOrderQty === null || market.maxOrderNotional === null) {
      throw new TradeOpsError('trade.venue_limit_unknown', `${venue.venue.id} does not report its largest order on ${venueSymbol}`);
    }
    if (compare(qty, market.maxOrderQty) > 0 || compare(notional, market.maxOrderNotional) > 0) {
      throw new TradeOpsError(
        'trade.venue_limit_above_venue',
        `the venue's largest order on ${venueSymbol} is ${formatAmount(market.maxOrderQty)} / ${formatAmount(market.maxOrderNotional)}`,
      );
    }
    const consumed = await consumeApproval(this.deps.approvals, {
      approvalId: input.approvalId,
      actionType: VENUE_LIMITS_SET_ACTION,
      targetId: venueLimitsTarget(venueId, venueSymbol),
      expectedVersion: String(expected),
      payloadHash: venueLimitsPayloadHash({
        venueId,
        symbol: venueSymbol,
        maxOrderQty,
        maxOrderNotional,
        expectedVersion: input.expectedVersion.trim(),
        reason,
      }),
      operationId: input.operationId,
    });
    const row: VenueLimitVersion = {
      venueId,
      symbol: venueSymbol,
      version: expected + 1,
      maxOrderQty: qty,
      maxOrderNotional: notional,
      venueMaxOrderQty: market.maxOrderQty,
      venueMaxOrderNotional: market.maxOrderNotional,
      approvalId: input.approvalId,
      proposerId: consumed.requesterId,
      approverId: consumed.approverId,
      executorId: principal.userId,
      reason,
      recordedAt: this.deps.now(),
    };
    if ((await this.deps.store.appendLimits(row)) === 'stale') {
      throw new TradeOpsError('trade.venue_limit_stale', 'another approved change landed first; the approval is spent, approve again');
    }
    return { venueId, symbol: venueSymbol, limits: limitView((await this.deps.store.limitsByApproval(input.approvalId))!) };
  }
}
