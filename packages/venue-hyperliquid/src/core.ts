import { parseAmount, ZERO, type Amount } from '@intafaced/ledger-client/money';
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
/** The most orders one signed cancel names (`cancel_orders`): ours, as the venue publishes no cap. */
export const CANCELS_PER_ACTION = 20;

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
/**
 * How long a shared read's answer is kept (`shareReads`). The venue weighs most info reads at 20 and a few at 2, against
 * 1200 a minute per IP, shared by every process on the machine (its rate-limit docs); the account's fee rates and builder approval change only by its own
 * signed action, which drops every kept answer. Each is well inside a figure's 60-second staleness limit.
 */
const LIGHT_READS = new Set(['l2Book', 'allMids', 'clearinghouseState', 'orderStatus', 'spotClearinghouseState', 'exchangeStatus']);
const SLOW_READS = new Set(['meta', 'spotMeta', 'perpDexs']);
/**
 * An account's reads that change only by its own signed action of another kind than an order or a cancel: its fee
 * rates (`userFees`, by its volume over days), its builder approval (`maxBuilderFee`), its session keys (`extraAgents`)
 * a market's leverage (`activeAssetData`, of which only `leverage` is read) and its account mode (`userAbstraction`). Kept for minutes; an order or a cancel
 * keeps them (`ORDER_ACTIONS`), any other signed action of the account drops them.
 */
const RARE_READS = new Set(['userFees', 'maxBuilderFee', 'extraAgents', 'activeAssetData', 'userAbstraction']);
export const READ_FRESH_MS = { light: 2_000, heavy: 15_000, slow: 30_000, rare: 300_000 } as const;
/**
 * The exchange actions that change only an account's orders, positions, balances and fills, never its fee rates,
 * approvals, session keys or leverage: after one, only those reads of the account are read again.
 */
const ORDER_ACTIONS: ReadonlySet<string> = new Set([
  'order',
  'cancel',
  'cancelByCloid',
  'modify',
  'batchModify',
  'scheduleCancel',
  'twapOrder',
  'twapCancel',
]);
/**
 * A fill read's start is read from this grid, and the fills before the asked start are left out after: desks
 * and background reads asking from moments a few seconds apart share one read instead of each weighing 20.
 */
export const FILLS_GRID_MS = 3_600_000;
/** How long to wait before the one retry of a read the venue answered 429, unless it says (Retry-After, capped at 5 s). */
const READ_RETRY_MS = 1_000;
/** A venue answer's text as JSON; `readOnce` has already checked that it parses. */
const parseJson = (text: string): Json => JSON.parse(text);
/**
 * The venue's weight for one request (its rate-limit docs): an info read weighs 2 when light (`LIGHT_READS`) and 20
 * otherwise, plus 1 per 20 items a list read answers (1 per 60 for candles); an exchange action weighs 1 plus 1 per 40
 * orders or cancels it carries.
 */
const PER_ITEM_READS = new Set(['recentTrades', 'historicalOrders', 'userFills', 'userFillsByTime', 'fundingHistory', 'userFunding']);
function readWeight(type: string, answer: Json | undefined): number {
  const base = LIGHT_READS.has(type) ? 2 : 20;
  const items = Array.isArray(answer) ? answer.length : 0;
  if (type === 'candleSnapshot') return base + Math.floor(items / 60);
  return PER_ITEM_READS.has(type) ? base + Math.floor(items / 20) : base;
}
/**
 * One minute's spend at the venue: requests and weight by request type, the minute named by its start (UTC). A read of
 * one account also names how many different accounts it was read for (`accounts`), so a reader that reads every account
 * shows apart from one that reads a few often.
 */
export interface VenueWeightMinute {
  readonly minute: string;
  readonly weight: number;
  readonly byType: Readonly<Record<string, { readonly requests: number; readonly weight: number; readonly accounts?: number }>>;
}
const freshFor = (type: string) =>
  LIGHT_READS.has(type)
    ? READ_FRESH_MS.light
    : RARE_READS.has(type)
      ? READ_FRESH_MS.rare
      : SLOW_READS.has(type)
        ? READ_FRESH_MS.slow
        : READ_FRESH_MS.heavy;
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
  /** Read for a 429's Retry-After only; a fake may leave it out. */
  readonly headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface HyperliquidTestnetOptions {
  /** Must be the testnet URL; defaults to it. Anything else is refused. */
  readonly baseUrl?: string;
  /** The RAW `process.env.APP_ENV`. A TEST venue is refused unless it is exactly `dev` or `test`. */
  readonly appEnv: string | null | undefined;
  /** The RAW `process.env.INTAFACED_BETA_POSTURE`: `test-networks` beside APP_ENV `staging` also lets a TEST venue run (the beta posture). */
  readonly betaPosture?: string | null;
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
  /**
   * The chain the person's wallet is on when it signs a user-signed action (approve agent, withdraw, a transfer): the
   * EIP-712 domain's chain id and the action's `signatureChainId`. A wallet refuses a domain on any other chain, and the
   * venue takes whichever chain the action names. Defaults to the app's chain, `WALLET_CHAIN_ID`.
   */
  readonly walletChainId?: number;
  /**
   * Share reads across callers (the live venue server): every tester's desk is read through this one process, on the
   * machine's one IP, and the venue limits each IP by the weight of its requests a minute. On, an answer is kept for a few
   * seconds by its weight (`READ_FRESH_MS`), one read is in flight per request, a signed action drops what was kept of its own accounts,
   * and a read the venue answers 429 is tried once more. Off (the default), every read goes to the venue.
   */
  readonly shareReads?: boolean;
  /**
   * Told once a minute what this instance spent at the venue the minute before (`VenueWeightMinute`), at its first
   * request in the next minute: every request that left for the venue, by type, weighed as the venue weighs it.
   */
  readonly onWeightMinute?: (spent: VenueWeightMinute) => void;
  /**
   * The HIP-3 perp DEXs whose markets are listed beside the main one: Hyperliquid lists its stock, index and
   * gold perpetuals on DEXs a deployer runs (`xyz`), each read apart (`metaAndAssetCtxs` with `dex`). Named, not every
   * DEX: the test network lists hundreds, most of them empty, and each read weighs 20. Defaults to none.
   */
  readonly perpDexs?: readonly string[];
  /**
   * Where a warning goes: a named perp DEX left out of the listing (not listed by the venue, or its read failed), so the
   * main listing stays up. Defaults to standard error.
   */
  readonly warn?: (message: string) => void;
}

/** The chain the customer app holds a wallet on (Base Sepolia, 84532; apps/customer `APP_CHAIN_ID`), which is not INTACHAIN. */
const WALLET_CHAIN_ID = 84532;

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
  /** The HIP-3 DEX a perp is listed on and that DEX's own name for itself, or null on the main DEX and spot. */
  readonly dex: { readonly name: string; readonly fullName: string } | null;
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

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
  private readonly shareReads: boolean;
  /** The HIP-3 perp DEXs listed beside the main one (`HyperliquidTestnetOptions.perpDexs`). */
  protected readonly perpDexs: readonly string[];
  private readonly warn: (message: string) => void;
  /** Shared reads (`shareReads`): each answer's text by its request body, and the reads in flight, with the account read. */
  private readonly kept = new Map<string, { text: string; atMs: number; user: string | null; type: string }>();
  private readonly reading = new Map<string, { read: Promise<string>; user: string | null; type: string }>();
  /** Per account, bumped by every signed action for it, so a read of it that began before the action is not kept after. */
  private readonly readsEpoch = new Map<string, { orders: number; rare: number }>();
  private readonly onWeightMinute: ((spent: VenueWeightMinute) => void) | null;
  private weightMinute: { startMs: number; byType: Map<string, { requests: number; weight: number; users: Set<string> }> } | null = null;
  /**
   * Destinations of withdrawals signed and sent through this instance, by
   * nonce. The venue's ledger read does not report one; this is the
   * destination in the signed bytes the venue ran under that nonce.
   */
  protected readonly withdrawalDestinations = new Map<string, string>();
  /** The wallet's chain: every user-signed action is signed under it (`walletChainId`). */
  readonly chainId: number;

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
      // An order, cancel or leverage change is an L1 action whose EIP-712 domain names chain 1337 (signing.ts L1_DOMAIN),
      // which no wallet signs on: it is signed by the trading session's agent key, approved once by the owner's wallet.
      tradesSignedBy: 'session_key',
      // One `cancelByCloid` carries several cancels, each named by its client id. The venue publishes no cap; this is
      // ours, well under the 40 cancels past which it weighs the action one more (`venue.ts` submit).
      cancelsPerAction: CANCELS_PER_ACTION,
    };
    refuseTestVenueOutsideTest(this.venue, options.appEnv, options.betaPosture);
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.clock = options.clock ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.nonceSource = options.nonceSource ?? new InMemoryNonceSource();
    const chainId = options.walletChainId ?? WALLET_CHAIN_ID;
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`wallet chain ${String(chainId)} is not a chain id`);
    this.chainId = chainId;
    this.shareReads = options.shareReads === true;
    this.onWeightMinute = options.onWeightMinute ?? null;
    this.perpDexs = [...new Set(options.perpDexs ?? [])];
    this.warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
    for (const dex of this.perpDexs) {
      if (!/^[a-z0-9]{1,15}$/.test(dex)) throw new Error(`a perp DEX is named by its lower-case name, as xyz, not ${JSON.stringify(dex)}`);
    }
  }

  // ── transport ──────────────────────────────────────────────────────────

  /** A read. Any failure to get a readable answer is `venue_down`: nothing was changed by a read. */
  protected async info(body: Record<string, Json>): Promise<Json> {
    if (!this.shareReads) return parseJson(await this.readOnce(body));
    const key = JSON.stringify(body);
    const user = typeof body.user === 'string' ? body.user.toLowerCase() : null;
    const type = String(body.type);
    const now = this.clock().getTime();
    const kept = this.kept.get(key);
    if (kept && now - kept.atMs < freshFor(type)) return parseJson(kept.text);
    let inFlight = this.reading.get(key);
    if (!inFlight) {
      const epoch = this.epochOf(user, type);
      const read: Promise<string> = this.readOnce(body, true)
        .then((text) => {
          if (epoch === this.epochOf(user, type)) this.keep(key, { text, user, type });
          return text;
        })
        .finally(() => {
          if (this.reading.get(key)?.read === read) this.reading.delete(key);
        });
      inFlight = { read, user, type };
      this.reading.set(key, inFlight);
    }
    return parseJson(await inFlight.read);
  }

  /**
   * A signed action changes what its own accounts read (orders, positions, balances, fees, agents and approvals), not
   * another person's: only reads of `users` kept before it are dropped, and a read of them begun before it is not kept.
   * An order or a cancel (`ORDER_ACTIONS`) changes only the account's orders, positions, balances and fills, so its fee
   * rates, approvals, session keys and leverage (`RARE_READS`) stay kept; any other action, or none named, drops them all.
   * Market reads (books, trades, candles, prices) are kept for their few seconds whoever trades.
   */
  protected forgetReads(users: readonly string[], actionType?: string): void {
    const forget = new Set(users.map((u) => u.toLowerCase()));
    const all = actionType === undefined || !ORDER_ACTIONS.has(actionType);
    const drops = (type: string) => all || !RARE_READS.has(type);
    for (const u of forget) {
      const epoch = this.readsEpoch.get(u) ?? { orders: 0, rare: 0 };
      this.readsEpoch.set(u, { orders: epoch.orders + 1, rare: epoch.rare + (all ? 1 : 0) });
    }
    for (const [k, v] of this.kept) if (v.user !== null && forget.has(v.user) && drops(v.type)) this.kept.delete(k);
    for (const [k, v] of this.reading) if (v.user !== null && forget.has(v.user) && drops(v.type)) this.reading.delete(k);
  }

  private epochOf(user: string | null, type: string): number {
    if (user === null) return 0;
    const epoch = this.readsEpoch.get(user);
    return epoch === undefined ? 0 : RARE_READS.has(type) ? epoch.rare : epoch.orders;
  }

  private keep(key: string, read: { text: string; user: string | null; type: string }): void {
    const now = this.clock().getTime();
    if (this.kept.size >= 2_000) for (const [k, v] of this.kept) if (now - v.atMs >= freshFor(v.type)) this.kept.delete(k);
    this.kept.set(key, { ...read, atMs: now });
  }

  /** Counts one request that left for the venue, and tells `onWeightMinute` the last minute's spend once a new one starts. */
  protected spend(type: string, weight: number, user: string | null = null): void {
    if (this.onWeightMinute === null) return;
    const startMs = Math.floor(this.clock().getTime() / 60_000) * 60_000;
    let current = this.weightMinute;
    if (current === null || current.startMs !== startMs) {
      if (current !== null) {
        const byType: Record<string, { requests: number; weight: number; accounts?: number }> = {};
        let total = 0;
        for (const [t, v] of [...current.byType].sort(([, a], [, b]) => b.weight - a.weight)) {
          byType[t] = { requests: v.requests, weight: v.weight, ...(v.users.size > 0 ? { accounts: v.users.size } : {}) };
          total += v.weight;
        }
        this.onWeightMinute({ minute: new Date(current.startMs).toISOString(), weight: total, byType });
      }
      current = { startMs, byType: new Map() };
      this.weightMinute = current;
    }
    const row = current.byType.get(type) ?? { requests: 0, weight: 0, users: new Set<string>() };
    row.requests += 1;
    row.weight += weight;
    if (user !== null) row.users.add(user.toLowerCase());
    current.byType.set(type, row);
  }

  private async readOnce(body: Record<string, Json>, retry429 = false): Promise<string> {
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
      let answer: Json | undefined;
      try {
        answer = parseJson(text);
      } catch {
        answer = undefined;
      }
      this.spend(String(body.type), readWeight(String(body.type), answer), typeof body.user === 'string' ? body.user : null);
      if (res.status === 429 && retry429) {
        clearTimeout(timer);
        const said = Number(res.headers?.get('retry-after') ?? NaN);
        await new Promise((r) => setTimeout(r, Number.isFinite(said) && said > 0 ? Math.min(said * 1000, 5_000) : READ_RETRY_MS));
        return await this.readOnce(body, false);
      }
      if (!res.ok) throw refusal(this.venue.id, 'venue_down', `info ${String(body.type)} answered HTTP ${res.status}`);
      if (answer === undefined) throw new Error('the answer is not JSON');
      return text;
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
        dex: null,
        canonical: true,
      });
    });
    list.push(...(await this.readDexMarkets()));
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
        dex: null,
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

  /**
   * The live markets of each named HIP-3 DEX. `perpDexs` lists the main DEX first (as null), then each HIP-3 DEX
   * by its index; a market's asset number is 100000 + that index × 10000 + its index in the DEX's own listing
   * (Hyperliquid's asset-ids docs). Its coin already carries the DEX (`xyz:TSLA`), and so does its symbol
   * (`xyz:TSLA-PERP`). A market the venue flags delisted, or with no open interest, is not listed: on the venue, a DEX
   * keeps delisted tickers with frozen prices far from the live one. A named DEX the venue doesn't list, or whose read
   * fails, is left out with a warning naming it, so the main listing and every other DEX stay up.
   */
  private async readDexMarkets(): Promise<(HlMarket & { canonical: boolean })[]> {
    if (this.perpDexs.length === 0) return [];
    let dexs: Json[];
    try {
      dexs = arr(await this.info({ type: 'perpDexs' }), 'perpDexs');
    } catch (error) {
      this.warn(`venue listing: the perp DEXs ${this.perpDexs.join(', ')} are left out: ${messageOf(error)}`);
      return [];
    }
    const out: (HlMarket & { canonical: boolean })[] = [];
    for (const name of this.perpDexs) {
      const index = dexs.findIndex((d) => d !== null && typeof d === 'object' && !Array.isArray(d) && d.name === name);
      if (index < 1) {
        this.warn(`venue listing: the perp DEX ${name} is left out: it is not listed by perpDexs`);
        continue;
      }
      try {
        out.push(...(await this.readDex(name, index, obj(dexs[index], 'perpDexs[]'))));
      } catch (error) {
        this.warn(`venue listing: the perp DEX ${name} is left out: ${messageOf(error)}`);
      }
    }
    return out;
  }

  /** One named DEX's live markets; it throws when its read fails or its answer can't be read, so all of it is left out. */
  private async readDex(name: string, index: number, dex: Record<string, Json>): Promise<(HlMarket & { canonical: boolean })[]> {
    const fullName = typeof dex.fullName === 'string' && dex.fullName !== '' ? dex.fullName : name;
    const both = arr(await this.info({ type: 'metaAndAssetCtxs', dex: name }), `metaAndAssetCtxs ${name}`);
    const ctxs = arr(both[1], `asset contexts ${name}`);
    const out: (HlMarket & { canonical: boolean })[] = [];
    arr(obj(both[0], `metaAndAssetCtxs ${name} meta`).universe, `${name} universe`).forEach((entry, i) => {
      const u = obj(entry, `${name} universe[]`);
      if (u.isDelisted === true) return;
      const ctx = ctxs[i];
      if (!ctx || amt(obj(ctx, `${name} asset ctx`).openInterest, 'openInterest') === ZERO) return;
      const coin = str(u.name, `${name} universe name`);
      if (!coin.startsWith(`${name}:`)) throw new Error(`venue listing: ${coin} on the perp DEX ${name} does not carry its prefix`);
      out.push({
        symbol: `${coin}-PERP`,
        kind: 'perpetual',
        asset: 100_000 + index * 10_000 + i,
        coin,
        base: coin,
        quote: PERP_QUOTE,
        szDecimals: int(u.szDecimals, 'szDecimals'),
        maxLeverage: int(u.maxLeverage, 'maxLeverage'),
        onlyIsolated: u.onlyIsolated === true,
        dex: { name, fullName },
        canonical: true,
      });
    });
    return out;
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
