import type { Amount } from '@intafaced/ledger-client/money';
import type { Principal } from '@intafaced/auth';
import {
  VenueRefusalError,
  isTestVenue,
  type AsOf,
  type PlaceUserOrderIntent,
  type UserVenueAccount,
  type UserVenueMarket,
  type VenueBook,
  type VenueOrderPreview,
  type VenueSignature,
} from '@intafaced/venue-contracts';
import type { PreparedActionStore } from './prepared-action-store.js';
import { rankRoute, type CandidateCost, type RouteReasonCode } from './route-ranking.js';
import { UserVenueDoor, UserVenueDoorError, type SubmitAnswer } from './user-venue-door.js';

/**
 * THE ROUTER OVER EVERY VENUE THE PERSON CAN SIGN FOR (J-derivatives-28; spec D-venue-01 to D-venue-04).
 *
 * One `UserVenueDoor` per configured venue (`TRADE_USER_VENUE_URL`, then each of `TRADE_USER_VENUE_URLS`), sharing one
 * prepared-action store, one builder fee and one listing gate. The router adds:
 *   · the venues read of one market: each venue with its own price, depth and fees as it reports them, our builder fee,
 *     whether the person has an account there they can sign for, and its health (a venue that is down is listed down
 *     with since when and why, never dropped);
 *   · the route preview: each signable venue that is up previews the order, and `rankRoute` chooses one, with its reason;
 *   · submit on the venue the action was prepared for, found from the stored action itself, so a signed order is only
 *     ever sent to its own venue and never re-sent to another (no silent failover).
 * The venue stays the record of balances, fills and positions. Nothing here moves money or posts to the ledger.
 */

/** How many levels a side the venues strip shows. */
export const STRIP_DEPTH = 5;

export interface VenueHealth {
  readonly state: 'up' | 'down';
  /** When it last changed state (the first read, for a venue never seen to change). */
  readonly since: Date;
  readonly reason: string | null;
  /** The last read that decided it. */
  readonly checkedAt: Date;
}

export type BuilderFeeShown =
  | { readonly published: false }
  | { readonly published: true; readonly carries: false }
  | {
      readonly published: true;
      readonly carries: true;
      readonly feeBps: Amount;
    };

export interface MarketVenueRow {
  /** `null` only for a venue this deployment has never reached: it has no id to show yet. */
  readonly venueId: string | null;
  readonly displayName: string | null;
  readonly test: boolean;
  readonly health: VenueHealth;
  /** Whether the venue lists the market and we show it there; `null` when the venue could not be read. */
  readonly listed: boolean | null;
  readonly market: Pick<
    UserVenueMarket,
    'kind' | 'baseAsset' | 'quoteAsset' | 'makerFeeBps' | 'takerFeeBps' | 'lotSize' | 'tickSize'
  > | null;
  readonly book: AsOf<VenueBook> | null;
  readonly builderFee: BuilderFeeShown | null;
  /** `signable`: the person has an account there their wallet can sign for. `connect`: none yet. `unknown`: no wallet given or not read. */
  readonly account: 'signable' | 'connect' | 'unknown';
}

export type ExcludedCode = 'venue_down' | 'not_listed' | 'no_account' | 'builder_fee_not_published' | `refused:${string}`;

export interface ExcludedVenue {
  readonly venueId: string | null;
  readonly displayName: string | null;
  readonly code: ExcludedCode;
  readonly detail: string;
}

/** The best level of the side an order takes from, as the venues strip showed it: what "the shown price" means. */
export type ShownBest = { readonly price: Amount; readonly amount: Amount } | null;

export interface RouteChoice {
  readonly shownBest: ShownBest;
  readonly venueId: string;
  readonly displayName: string;
  readonly test: boolean;
  readonly preview: AsOf<VenueOrderPreview>;
  readonly cost: CandidateCost;
}

export interface RoutePreview {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly amount: Amount;
  readonly quoteAsset: string | null;
  /** `null`: no venue the person can sign for is up and takes the order; `excluded` says why for each. */
  readonly chosen: RouteChoice | null;
  readonly others: readonly (CandidateCost & { readonly displayName: string; readonly shownBest: ShownBest })[];
  readonly excluded: readonly ExcludedVenue[];
  readonly reason: RouteReasonCode | 'no_signable_venue_up';
  readonly at: Date;
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** `TRADE_USER_VENUE_URLS`: blank is none; each entry an http(s) URL; a malformed one stops the boot. */
export function parseUserVenueUrls(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const url = part.trim();
    if (url === '') continue;
    if (!/^https?:\/\/\S+$/.test(url)) throw new Error(`TRADE_USER_VENUE_URLS entries must be http(s) URLs, got ${JSON.stringify(url)}`);
    out.push(url);
  }
  return out;
}

export interface UserVenueRouterDeps {
  readonly doors: readonly UserVenueDoor[];
  readonly store: PreparedActionStore;
  readonly now: () => Date;
}

export class UserVenueRouter {
  private readonly health = new Map<string, VenueHealth>();

  constructor(private readonly deps: UserVenueRouterDeps) {
    if (deps.doors.length === 0) throw new Error('the venue router needs at least one door');
  }

  /** The first configured venue: every route that names no venue uses it, as before the router. */
  get primary(): UserVenueDoor {
    return this.deps.doors[0]!;
  }

  /** True when more than one venue is configured: only then does the ticket route. */
  get routes(): boolean {
    return this.deps.doors.length > 1;
  }

  private observe(venueId: string, up: boolean, reason: string | null): void {
    const now = this.deps.now();
    const was = this.health.get(venueId);
    const state = up ? 'up' : 'down';
    this.health.set(venueId, {
      state,
      since: was && was.state === state ? was.since : now,
      reason: up ? null : reason,
      checkedAt: now,
    });
  }

  /** Run a read on a venue, marking it down on `venue_down` and up on success. Other refusals pass through. */
  private async watched<T>(venueId: string, read: () => Promise<T>): Promise<T> {
    try {
      const value = await read();
      this.observe(venueId, true, null);
      return value;
    } catch (err) {
      if (err instanceof VenueRefusalError && err.refusal.code === 'venue_down') this.observe(venueId, false, err.refusal.detail);
      throw err;
    }
  }

  /** The door of `venueId`, or the primary one when none is named. An id no configured venue has is refused. */
  async door(venueId?: string | null): Promise<UserVenueDoor> {
    const id = (venueId ?? '').trim();
    if (id === '') return this.primary;
    for (const d of this.deps.doors) {
      if (d.connectedVenueId === id) return d;
    }
    // A door not connected yet may be the one: connect each such door once, then look again.
    for (const d of this.deps.doors) {
      if (d.connectedVenueId !== null) continue;
      try {
        if ((await d.venue()).venue.id === id) return d;
      } catch {
        /* unreachable now: it is not this one as far as we can tell */
      }
    }
    throw new UserVenueDoorError(`no venue ${JSON.stringify(id)} is configured here`, 'trade.venue_unknown', 404);
  }

  /** Every configured venue's descriptor and health, for the desk's status read. */
  async venues(): Promise<{ venueId: string | null; displayName: string | null; test: boolean; health: VenueHealth }[]> {
    const out = [];
    for (const d of this.deps.doors) {
      try {
        const v = await d.venue();
        const id = v.venue.id;
        if (!this.health.has(id)) this.observe(id, true, null);
        out.push({ venueId: id, displayName: v.venue.displayName, test: isTestVenue(v.venue), health: this.health.get(id)! });
      } catch (err) {
        const reason = err instanceof VenueRefusalError ? err.refusal.detail : (err as Error).message;
        const id = d.connectedVenueId;
        if (id) this.observe(id, false, reason);
        const now = this.deps.now();
        out.push({
          venueId: id,
          displayName: null,
          test: true,
          health: id ? this.health.get(id)! : { state: 'down' as const, since: now, reason, checkedAt: now },
        });
      }
    }
    return out;
  }

  private async rowOf(d: UserVenueDoor, owner: string | null, symbol: string, side: 'buy' | 'sell'): Promise<MarketVenueRow> {
    let venue;
    try {
      venue = await d.venue();
    } catch (err) {
      const reason = err instanceof VenueRefusalError ? err.refusal.detail : (err as Error).message;
      const now = this.deps.now();
      const id = d.connectedVenueId;
      if (id) this.observe(id, false, reason);
      return {
        venueId: id,
        displayName: null,
        test: true,
        health: id ? this.health.get(id)! : { state: 'down', since: now, reason, checkedAt: now },
        listed: null,
        market: null,
        book: null,
        builderFee: null,
        account: 'unknown',
      };
    }
    const id = venue.venue.id;
    const base = { venueId: id, displayName: venue.venue.displayName, test: isTestVenue(venue.venue) };
    try {
      const shown = await this.watched(id, () => d.markets());
      const market = shown.value.find((m) => m.symbol === symbol) ?? null;
      if (!market) {
        return { ...base, health: this.health.get(id)!, listed: false, market: null, book: null, builderFee: null, account: 'unknown' };
      }
      const book = await this.watched(id, () => venue.book(symbol, STRIP_DEPTH));
      const fee = await d.builderFeeFor(symbol, side);
      const builderFee: BuilderFeeShown =
        fee === null
          ? { published: false }
          : fee.carries
            ? { published: true, carries: true, feeBps: fee.feeBps }
            : { published: true, carries: false };
      let account: MarketVenueRow['account'] = 'unknown';
      if (owner) {
        const acct: UserVenueAccount = { venueId: id, owner, subAccount: null };
        const [balances, agents] = await Promise.all([
          this.watched(id, () => venue.balances(acct)),
          this.watched(id, () => venue.agents(acct)),
        ]);
        account = balances.value.some((b) => b.total > 0n) || agents.value.length > 0 ? 'signable' : 'connect';
      }
      return {
        ...base,
        health: this.health.get(id)!,
        listed: true,
        market: {
          kind: market.kind,
          baseAsset: market.baseAsset,
          quoteAsset: market.quoteAsset,
          makerFeeBps: market.makerFeeBps,
          takerFeeBps: market.takerFeeBps,
          lotSize: market.lotSize,
          tickSize: market.tickSize,
        },
        book,
        builderFee,
        account,
      };
    } catch (err) {
      if (!(err instanceof VenueRefusalError && err.refusal.code === 'venue_down')) throw err;
      return { ...base, health: this.health.get(id)!, listed: null, market: null, book: null, builderFee: null, account: 'unknown' };
    }
  }

  /** Each configured venue for `symbol` (J-derivatives-28 #1), in configured order. A down venue is a row, never dropped. */
  async marketVenues(
    ownerRaw: string | null,
    symbol: string,
    side: 'buy' | 'sell' = 'buy',
  ): Promise<{ symbol: string; venues: MarketVenueRow[]; at: Date }> {
    const s = (symbol ?? '').trim();
    if (!/^\S{1,64}$/.test(s)) throw new UserVenueDoorError('symbol must be a venue market symbol', 'trade.venue_request_invalid', 400);
    const owner = ownerRaw ? ownerRaw.trim().toLowerCase() : null;
    if (owner !== null && !ADDRESS_RE.test(owner)) {
      throw new UserVenueDoorError('owner must be the wallet address (0x and 40 hex)', 'trade.venue_request_invalid', 400);
    }
    const venues = await Promise.all(this.deps.doors.map((d) => this.rowOf(d, owner, s, side)));
    return { symbol: s, venues, at: this.deps.now() };
  }

  /** The route preview of one order (J-derivatives-28 #2, #4): the venue chosen, its expected fill and fees, and why. */
  async routePreview(principal: Principal, ownerRaw: string, intent: PlaceUserOrderIntent): Promise<RoutePreview> {
    if (intent?.kind !== 'place_order') {
      throw new UserVenueDoorError('a route preview takes an order intent (kind place_order)', 'trade.venue_request_invalid', 400);
    }
    const owner = (ownerRaw ?? '').trim().toLowerCase();
    if (!ADDRESS_RE.test(owner))
      throw new UserVenueDoorError('owner must be the wallet address (0x and 40 hex)', 'trade.venue_request_invalid', 400);
    const rows = await Promise.all(this.deps.doors.map(async (d) => ({ d, row: await this.rowOf(d, owner, intent.symbol, intent.side) })));
    const excluded: ExcludedVenue[] = [];
    const previews: {
      venueId: string;
      displayName: string;
      test: boolean;
      quote: string;
      base: string;
      shownBest: ShownBest;
      preview: AsOf<VenueOrderPreview>;
    }[] = [];
    for (const { d, row } of rows) {
      const who = { venueId: row.venueId, displayName: row.displayName };
      if (row.health.state === 'down') {
        excluded.push({ ...who, code: 'venue_down', detail: row.health.reason ?? 'the venue is down' });
        continue;
      }
      if (row.listed !== true || !row.market || !row.venueId || !row.displayName) {
        excluded.push({ ...who, code: 'not_listed', detail: `${intent.symbol} is not listed on this venue` });
        continue;
      }
      if (row.account !== 'signable') {
        excluded.push({ ...who, code: 'no_account', detail: 'no account here your wallet can sign for: connect to use' });
        continue;
      }
      if (row.builderFee && !row.builderFee.published) {
        excluded.push({ ...who, code: 'builder_fee_not_published', detail: 'our builder fee is not published (owner value blank)' });
        continue;
      }
      const venueId = row.venueId;
      try {
        const preview = await this.watched(venueId, () => d.preview(principal, owner, intent));
        const level = (intent.side === 'buy' ? row.book?.value.asks : row.book?.value.bids)?.[0] ?? null;
        const shownBest = level ? { price: level.price, amount: level.amount } : null;
        previews.push({
          venueId,
          displayName: row.displayName,
          test: row.test,
          quote: row.market.quoteAsset,
          base: row.market.baseAsset,
          shownBest,
          preview,
        });
      } catch (err) {
        if (err instanceof VenueRefusalError) {
          excluded.push({
            ...who,
            code: err.refusal.code === 'venue_down' ? 'venue_down' : `refused:${err.refusal.code}`,
            detail: err.refusal.detail,
          });
        } else if (err instanceof UserVenueDoorError) {
          excluded.push({ ...who, code: `refused:${err.code}`, detail: err.message });
        } else throw err;
      }
    }
    const at = this.deps.now();
    const quoteAsset = previews[0]?.quote ?? null;
    const ranked = quoteAsset
      ? rankRoute(
          previews.map((p) => ({ venueId: p.venueId, preview: p.preview.value })),
          { side: intent.side, amount: intent.amount },
          { base: previews[0]!.base, quote: quoteAsset },
        )
      : null;
    if (!ranked) {
      return {
        symbol: intent.symbol,
        side: intent.side,
        amount: intent.amount,
        quoteAsset,
        chosen: null,
        others: [],
        excluded,
        reason: 'no_signable_venue_up',
        at,
      };
    }
    const byId = new Map(previews.map((p) => [p.venueId, p] as const));
    const chosen = byId.get(ranked.chosen.venueId)!;
    return {
      symbol: intent.symbol,
      side: intent.side,
      amount: intent.amount,
      quoteAsset,
      chosen: {
        venueId: chosen.venueId,
        displayName: chosen.displayName,
        test: chosen.test,
        shownBest: chosen.shownBest,
        preview: chosen.preview,
        cost: ranked.chosen,
      },
      others: ranked.others.map((o) => ({
        ...o,
        displayName: byId.get(o.venueId)!.displayName,
        shownBest: byId.get(o.venueId)!.shownBest,
      })),
      excluded,
      reason: ranked.reason,
      at,
    };
  }

  /** Send a stored action on the venue it was prepared for (found from the stored action), never on another. */
  /** The door of the venue a stored action was prepared for; the primary one when no action has that key. */
  async doorOfAction(principal: Principal, actionKey: string): Promise<UserVenueDoor> {
    const row = await this.deps.store.find(principal.userId, (actionKey ?? '').trim());
    return row ? this.door(row.prepared.venueId) : this.primary;
  }

  async submit(principal: Principal, actionKey: string, signature: VenueSignature): Promise<SubmitAnswer> {
    const row = await this.deps.store.find(principal.userId, (actionKey ?? '').trim());
    const d = row ? await this.door(row.prepared.venueId) : this.primary;
    const venueId = row?.prepared.venueId ?? null;
    try {
      const answer = await d.submit(principal, actionKey, signature);
      if (venueId) this.observe(venueId, true, null);
      return answer;
    } catch (err) {
      if (venueId && err instanceof VenueRefusalError && err.refusal.code === 'venue_down')
        this.observe(venueId, false, err.refusal.detail);
      throw err;
    }
  }
}
