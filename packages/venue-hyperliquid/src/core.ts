import { parseAmount, type Amount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  refuseTestVenueOutsideTest,
  type AsOf,
  type UserVenueAccount,
  type UserVenueDescriptor,
  type VenueRefusalCode,
} from '@intafaced/venue-contracts';
import { HL_TESTNET_API_URL, assertTestnetUrl } from './signing.js';

/**
 * The Hyperliquid testnet adapter's base: its options, its transport to `POST /info`, and the venue's listing. The
 * reads (`reads.ts`) and the signed actions (`venue.ts`) build on it. What each part means is on
 * `HyperliquidTestnetUserVenue` in `venue.ts`.
 */

export const HL_TESTNET_VENUE_ID = 'hyperliquid-testnet';

/**
 * The perpetual account's USDC, reported apart from spot USDC: on this venue
 * they are two separate balances, and `UserVenueBalance` has no field for
 * which account a balance sits in (named as an interface gap in the PR).
 * It is also the only asset a withdrawal takes: `withdraw3` draws on the
 * perpetual account, so spot `USDC` is refused `not_offered`.
 */
export const PERP_COLLATERAL_ASSET = 'USDC-PERP';

export const PERP_QUOTE = 'USDC';
export const WITHDRAW_DECIMALS = 6;
export const BPS_PER_X = 10_000;

/** How long the venue's listing is trusted before it is read again. */
const MARKETS_TTL_MS = 5 * 60_000;
/** A symbol or coin we do not know reads the listing again at most this often. */
const MARKETS_MISS_REFRESH_MS = 10_000;
/** The venue's documented cap on one `userFillsByTime` answer ("at most 2000 fills per response"). */
export const FILLS_PAGE_CAP = 2000;

/**
 * Where nonces come from. The venue keeps the 100 highest nonces per signer
 * and refuses a used one, so every party that signs for one signer address
 * must draw from one source. `next` returns a millisecond nonce, strictly
 * greater than any it returned before for that signer, at or near `nowMs`.
 */
export interface HyperliquidNonceSource {
  next(signer: string, nowMs: number): Promise<string> | string;
}

/**
 * The default nonce source: a counter in this process's memory, per signer.
 * It is for ONE process only. Two processes (or two machines) signing for the
 * same wallet must share a source backed by something they both see, or
 * their nonces can collide in the same millisecond.
 */
export class InMemoryNonceSource implements HyperliquidNonceSource {
  private readonly last = new Map<string, number>();
  next(signer: string, nowMs: number): string {
    const key = signer.toLowerCase();
    const nonce = Math.max((this.last.get(key) ?? 0) + 1, nowMs);
    this.last.set(key, nonce);
    return String(nonce);
  }
}

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export interface HyperliquidTestnetOptions {
  /** Must be the testnet URL; defaults to it. Anything else is refused. */
  readonly baseUrl?: string;
  /** The RAW `process.env.APP_ENV`. A TEST venue is refused unless it is exactly `dev` or `test`. */
  readonly appEnv: string | null | undefined;
  readonly fetch?: FetchLike;
  readonly clock?: () => Date;
  /** How long a request may take before it counts as a timeout. */
  readonly timeoutMs?: number;
  /**
   * Where nonces come from. Defaults to an `InMemoryNonceSource` of this
   * instance's own, which is safe for one instance in one process only: pass
   * one shared source to every instance that signs for the same wallet.
   */
  readonly nonceSource?: HyperliquidNonceSource;
}

export interface HlBookLevel {
  readonly price: Amount;
  readonly size: Amount;
}

export interface HlBook {
  readonly symbol: string;
  readonly bids: readonly HlBookLevel[];
  readonly asks: readonly HlBookLevel[];
}

export interface HlMarket {
  readonly symbol: string;
  readonly kind: 'spot' | 'perpetual';
  /** The venue's asset number: the perp's index, or 10000 + the spot pair's index. */
  readonly asset: number;
  /** The coin name the venue uses in reads (`ETH`, `PURR/USDC`, `@107`). */
  readonly coin: string;
  readonly base: string;
  readonly quote: string;
  readonly szDecimals: number;
  readonly maxLeverage: number | null;
  readonly onlyIsolated: boolean;
}

export interface MarketIndex {
  readonly bySymbol: Map<string, HlMarket>;
  readonly byCoin: Map<string, HlMarket>;
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function refusal(venueId: string, code: VenueRefusalCode, detail: string): VenueRefusalError {
  return new VenueRefusalError({ venueId, code, detail });
}

export function str(value: Json | undefined, what: string): string {
  if (typeof value !== 'string') throw new Error(`venue answer: ${what} is not a string`);
  return value;
}

/** A money figure from the venue: always a decimal string, never a JSON number. */
export function amt(value: Json | undefined, what: string): Amount {
  return parseAmount(str(value, what));
}

export function int(value: Json | undefined, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`venue answer: ${what} is not a whole number`);
  return value;
}

export function obj(value: Json | undefined, what: string): { [key: string]: Json } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`venue answer: ${what} is not an object`);
  return value;
}

export function arr(value: Json | undefined, what: string): Json[] {
  if (!Array.isArray(value)) throw new Error(`venue answer: ${what} is not a list`);
  return value;
}

export abstract class HyperliquidCore {
  readonly venue: UserVenueDescriptor;
  protected readonly baseUrl: string;
  protected readonly fetchImpl: FetchLike;
  protected readonly clock: () => Date;
  protected readonly timeoutMs: number;
  protected readonly nonceSource: HyperliquidNonceSource;
  private marketsCache: { index: MarketIndex; loadedAtMs: number } | null = null;
  /** One listing read at a time: concurrent callers share it. */
  private marketsInFlight: Promise<MarketIndex> | null = null;
  private lastMissRefreshMs = Number.NEGATIVE_INFINITY;
  /**
   * Destinations of withdrawals signed and sent through this instance, by
   * nonce. The venue's ledger read does not report one; this is the
   * destination in the signed bytes the venue ran under that nonce.
   */
  protected readonly withdrawalDestinations = new Map<string, string>();

  protected constructor(options: HyperliquidTestnetOptions) {
    this.baseUrl = assertTestnetUrl(options.baseUrl ?? HL_TESTNET_API_URL);
    this.venue = {
      id: HL_TESTNET_VENUE_ID,
      displayName: 'TEST venue (testnet)',
      kind: 'external-dex',
      sequencedDepth: false,
      proofLevel: 'partner-sandbox',
      // b2 change 6: how old this venue's balance and position figures may be before they show as old. Hyperliquid
      // publishes no such limit, so this adapter declares ours: a minute, the same as the TEST venue's.
      figureStaleAfterMs: 60_000,
    };
    refuseTestVenueOutsideTest(this.venue, options.appEnv);
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.clock = options.clock ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.nonceSource = options.nonceSource ?? new InMemoryNonceSource();
  }

  // ── transport ──────────────────────────────────────────────────────────

  /** A read. Any failure to get a readable answer is `venue_down`: nothing was changed by a read. */
  protected async info(body: Record<string, Json>): Promise<Json> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/info`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw refusal(this.venue.id, 'venue_down', `info ${String(body.type)} answered HTTP ${res.status}`);
      return JSON.parse(text) as Json;
    } catch (error) {
      if (error instanceof VenueRefusalError) throw error;
      throw refusal(this.venue.id, 'venue_down', `info ${String(body.type)} failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  protected asOf<T>(value: T, venueTimeMs?: number): AsOf<T> {
    // `reportedAt` is the venue's own time, or null when it sent none (b2 change 6): never our read time.
    const venueTime = venueTimeMs !== undefined ? new Date(venueTimeMs) : null;
    return { venueId: this.venue.id, value, asOf: venueTime ?? this.clock(), reportedAt: venueTime };
  }

  protected user(account: UserVenueAccount): string {
    return (account.subAccount ?? account.owner).toLowerCase();
  }

  // ── markets ────────────────────────────────────────────────────────────

  /**
   * The venue's listing. Read again after `MARKETS_TTL_MS`, or sooner when a
   * caller meets a symbol or coin it does not know (`onMiss`), at most once
   * per `MARKETS_MISS_REFRESH_MS`. One read is in flight at a time.
   */
  protected async loadMarkets(onMiss = false): Promise<MarketIndex> {
    const now = this.clock().getTime();
    const cached = this.marketsCache;
    if (cached && !onMiss && now - cached.loadedAtMs < MARKETS_TTL_MS) return cached.index;
    if (cached && onMiss) {
      if (now - this.lastMissRefreshMs < MARKETS_MISS_REFRESH_MS) return cached.index;
      this.lastMissRefreshMs = now;
    }
    if (!this.marketsInFlight) {
      this.marketsInFlight = this.readMarkets()
        .then((index) => {
          this.marketsCache = { index, loadedAtMs: this.clock().getTime() };
          return index;
        })
        .finally(() => {
          this.marketsInFlight = null;
        });
    }
    return this.marketsInFlight;
  }

  protected async marketOfCoin(coin: string): Promise<HlMarket | undefined> {
    return (await this.loadMarkets()).byCoin.get(coin) ?? (await this.loadMarkets(true)).byCoin.get(coin);
  }

  private async readMarkets(): Promise<MarketIndex> {
    const [meta, spotMeta] = await Promise.all([this.info({ type: 'meta' }), this.info({ type: 'spotMeta' })]);
    const list: (HlMarket & { canonical: boolean })[] = [];
    arr(obj(meta, 'meta').universe, 'meta.universe').forEach((entry, index) => {
      const u = obj(entry, 'meta.universe[]');
      if (u.isDelisted === true) return;
      const coin = str(u.name, 'meta name');
      list.push({
        symbol: `${coin}-PERP`,
        kind: 'perpetual',
        asset: index,
        coin,
        base: coin,
        quote: PERP_QUOTE,
        szDecimals: int(u.szDecimals, 'szDecimals'),
        maxLeverage: int(u.maxLeverage, 'maxLeverage'),
        onlyIsolated: u.onlyIsolated === true,
        canonical: true,
      });
    });
    const spot = obj(spotMeta, 'spotMeta');
    const tokens = new Map<number, { name: string; szDecimals: number }>();
    for (const t of arr(spot.tokens, 'spotMeta.tokens')) {
      const token = obj(t, 'token');
      tokens.set(int(token.index, 'token index'), {
        name: str(token.name, 'token name'),
        szDecimals: int(token.szDecimals, 'token szDecimals'),
      });
    }
    for (const p of arr(spot.universe, 'spotMeta.universe')) {
      const pair = obj(p, 'spot pair');
      const [b, q] = arr(pair.tokens, 'pair tokens').map((x) => int(x, 'pair token'));
      const base = tokens.get(b!);
      const quote = tokens.get(q!);
      if (!base || !quote) continue;
      list.push({
        symbol: `${base.name}-${quote.name}`,
        kind: 'spot',
        asset: 10_000 + int(pair.index, 'pair index'),
        coin: str(pair.name, 'pair name'),
        base: base.name,
        quote: quote.name,
        szDecimals: base.szDecimals,
        maxLeverage: null,
        onlyIsolated: false,
        canonical: pair.isCanonical === true,
      });
    }
    // Two markets never share a symbol. Where display names collide, a perp,
    // then a canonical pair, then the lowest asset number keeps the plain
    // symbol; every other one is named by its own pair index.
    const groups = new Map<string, (typeof list)[number][]>();
    for (const m of list) groups.set(m.symbol, [...(groups.get(m.symbol) ?? []), m]);
    const bySymbol = new Map<string, HlMarket>();
    const byCoin = new Map<string, HlMarket>();
    for (const group of groups.values()) {
      group.sort(
        (x, y) =>
          Number(y.kind === 'perpetual') - Number(x.kind === 'perpetual') || Number(y.canonical) - Number(x.canonical) || x.asset - y.asset,
      );
      group.forEach(({ canonical: _canonical, ...m }, i) => {
        const market: HlMarket = i === 0 ? m : { ...m, symbol: `${m.symbol}@${m.asset - 10_000}` };
        if (bySymbol.has(market.symbol) || byCoin.has(market.coin)) {
          throw new Error(`venue listing: ${market.symbol} (${market.coin}) is not unique`);
        }
        bySymbol.set(market.symbol, market);
        byCoin.set(market.coin, market);
      });
    }
    return { bySymbol, byCoin };
  }

  protected async market(symbol: string): Promise<HlMarket> {
    const m = (await this.loadMarkets()).bySymbol.get(symbol) ?? (await this.loadMarkets(true)).bySymbol.get(symbol);
    if (!m) throw refusal(this.venue.id, 'unknown_market', `${symbol} is not listed on this venue`);
    return m;
  }

  protected async symbolOfCoin(coin: string): Promise<string> {
    return (await this.marketOfCoin(coin))?.symbol ?? coin;
  }

  protected checkAccount(account: UserVenueAccount): void {
    if (account.venueId !== this.venue.id)
      throw refusal(this.venue.id, 'venue_rejected', `account is on ${account.venueId}, not ${this.venue.id}`);
  }
}
