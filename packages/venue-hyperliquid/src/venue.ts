import { abs, compare, div, mul, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  assertSignatureMatches,
  assertSignerMaySign,
  refuseTestVenueOutsideTest,
  venueClientOrderId,
  type AsOf,
  type MaybeKnown,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenue,
  type UserVenueAccount,
  type UserVenueAgent,
  type UserVenueBalance,
  type UserVenueDescriptor,
  type UserVenueFill,
  type UserVenueLeverage,
  type UserVenueMarket,
  type UserVenueOrder,
  type UserVenuePosition,
  type UserVenueWithdrawal,
  type VenueIntent,
  type VenueOrderStatus,
  type VenueRefusalCode,
  type VenueSignature,
  type VenueSigner,
  type VenueSubmitOutcome,
  type VenueTimeInForce,
} from '@intafaced/venue-contracts';
import type { MsgpackValue } from './msgpack.js';
import {
  HL_SIGNATURE_CHAIN_ID,
  HL_TESTNET_API_URL,
  HL_TESTNET_CHAIN,
  USER_SIGNED_TYPES,
  actionHash,
  assertTestnetUrl,
  l1TypedData,
  recoverTypedDataSigner,
  splitSignature,
  typedDataDigest,
  userSignedTypedData,
  type HlTypedData,
  type UserSignedPrimaryType,
} from './signing.js';
import {
  bpsToPercentString,
  bpsToTenths,
  priceProblem,
  rateToBps,
  sizeProblem,
  tenthsToBps,
  toWire,
  unit,
  PERP_MAX_DECIMALS,
  SPOT_MAX_DECIMALS,
} from './wire.js';

/**
 * THE HYPERLIQUID TESTNET `UserVenue` — the customer's own testnet account, signed by the customer's wallet.
 *
 * Proof level `partner-sandbox`: a TEST venue. Every figure from it is TEST,
 * and the constructor refuses it outside APP_ENV dev or test
 * (`refuseTestVenueOutsideTest`). The base URL and the chain are fixed to the
 * testnet; anything else is refused with `HyperliquidNetworkRefusedError`.
 *
 * Reads go to `POST /info`; signed actions to `POST /exchange`. `prepare`
 * builds the exact typed data the wallet signs (signing.ts) and sends nothing;
 * `submit` rebuilds the action from the prepared intent, checks the digest and
 * recovers the signer from the signature bytes, then posts.
 *
 * What the venue's answer means (`VenueSubmitOutcome`):
 *   · a timeout, a dropped connection, any HTTP status other than 2xx, or an
 *     unreadable body after the bytes went out → `definite: false` (read back
 *     by `prepared.venueClientOrderId` or `prepared.nonce`; never prepare
 *     again). The venue states its own refusals as HTTP 200 with
 *     `status: "err"` or a per-order `error`; a 4xx or 5xx may come from a
 *     proxy after the action was applied, so it is never read as a refusal;
 *   · the venue's "duplicate nonce" answer, and a duplicate cloid →
 *     `definite: false, reason: 'already_submitted'`;
 *   · any other nonce answer (too low, outside the time window) → a definite
 *     `nonce_rejected`: the venue did not apply this action;
 *   · a stated venue refusal → `definite: true, accepted: false` with a typed
 *     `VenueRefusalCode`.
 *
 * Symbols: a perpetual is `<COIN>-PERP` (quote USDC), a spot pair is
 * `<BASE>-<QUOTE>`, as the TEST simulator names them. Two venue markets never
 * share a symbol: when spot pairs share display names, the canonical pair (or
 * else the lowest-numbered one) keeps `<BASE>-<QUOTE>` and every other one is
 * `<BASE>-<QUOTE>@<pair index>`.
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

const PERP_QUOTE = 'USDC';
const WITHDRAW_DECIMALS = 6;
const BPS_PER_X = 10_000;

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

interface HlMarket {
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

interface MarketIndex {
  readonly bySymbol: Map<string, HlMarket>;
  readonly byCoin: Map<string, HlMarket>;
}

interface BuiltAction {
  readonly action: Record<string, MsgpackValue>;
  readonly typedData: HlTypedData;
  readonly vaultAddress: string | null;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function refusal(venueId: string, code: VenueRefusalCode, detail: string): VenueRefusalError {
  return new VenueRefusalError({ venueId, code, detail });
}

function str(value: Json | undefined, what: string): string {
  if (typeof value !== 'string') throw new Error(`venue answer: ${what} is not a string`);
  return value;
}

/** A money figure from the venue: always a decimal string, never a JSON number. */
function amt(value: Json | undefined, what: string): Amount {
  return parseAmount(str(value, what));
}

function int(value: Json | undefined, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`venue answer: ${what} is not a whole number`);
  return value;
}

function obj(value: Json | undefined, what: string): { [key: string]: Json } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`venue answer: ${what} is not an object`);
  return value;
}

function arr(value: Json | undefined, what: string): Json[] {
  if (!Array.isArray(value)) throw new Error(`venue answer: ${what} is not a list`);
  return value;
}

const TIF_WIRE: Record<VenueTimeInForce, 'Gtc' | 'Ioc' | 'Alo'> = { GTC: 'Gtc', IOC: 'Ioc', ALO: 'Alo' };

/**
 * Map a venue's error text to a typed outcome. Matched on the venue's words,
 * which it does not version; every unmatched text is `venue_rejected` with the
 * text kept, never dropped.
 *
 * Nonces. The venue's documented rule (Hyperliquid docs, "Nonces and API
 * wallets"): it keeps the 100 highest nonces per signer, a new one must be
 * above the smallest of them and never used before, and within
 * (T - 2 days, T + 1 day) of the block time. The docs give no error text.
 * The wording below is what the venue has been seen to answer, from public
 * user reports, not from Hyperliquid's own docs or SDK:
 *   · "Invalid nonce: duplicate nonce <n>" — this nonce was already used, so
 *     this exact action may have landed: `already_submitted`, never definite;
 *   · "Invalid nonce: nonce too low ..." — below the kept set or the window.
 * The wording for a nonce too far in the future was not found in any public
 * source. Every nonce answer other than the duplicate one guarantees the
 * action was not applied, so it is a definite `nonce_rejected`.
 */
export function classifyVenueError(venueId: string, text: string, asOf: Date): VenueSubmitOutcome {
  if (/invalid nonce:\s*duplicate nonce/i.test(text)) return { definite: false, reason: 'already_submitted' };
  if (/cloid|client order id/i.test(text) && /duplicate|already/i.test(text)) return { definite: false, reason: 'already_submitted' };
  const code: VenueRefusalCode = /\bnonce\b/i.test(text)
    ? 'nonce_rejected'
    : /builder/i.test(text) && /approv|max(imum)? ?fee|exceed/i.test(text)
      ? 'builder_fee_not_approved'
      : /insufficient|not enough/i.test(text) && /margin|balance|funds/i.test(text)
        ? 'insufficient_balance'
        : /does not exist/i.test(text) && /user|wallet|agent|signer/i.test(text)
          ? 'signer_not_authorised'
          : /never placed|already canceled|already cancelled/i.test(text)
            ? 'unknown_order'
            : /unknown asset|invalid asset|asset not found/i.test(text)
              ? 'unknown_market'
              : 'venue_rejected';
  return { definite: true, accepted: false, refusal: { venueId, code, detail: text }, asOf };
}

/** What the venue said about one order or cancel in an `ok` answer. */
type StatusLine = { kind: 'accepted'; venueRef: string | null } | { kind: 'error'; text: string };

function statusLine(response: Json): StatusLine {
  const r = obj(response, 'response');
  if (r.type === 'default') return { kind: 'accepted', venueRef: null };
  const data = obj(r.data, 'response.data');
  const statuses = arr(data.statuses, 'response.data.statuses');
  if (statuses.length !== 1) throw new Error(`venue answer: expected one status, got ${statuses.length}`);
  const s = statuses[0]!;
  if (typeof s === 'string') return { kind: 'accepted', venueRef: null }; // "success", "waitingForFill", "waitingForTrigger"
  const o = obj(s, 'status');
  if (typeof o.error === 'string') return { kind: 'error', text: o.error };
  const placed = (o.resting ?? o.filled) as Json | undefined;
  if (placed !== undefined) return { kind: 'accepted', venueRef: String(int(obj(placed, 'status.order').oid, 'oid')) };
  throw new Error('venue answer: an order status with neither resting, filled nor error');
}

export class HyperliquidTestnetUserVenue implements UserVenue {
  readonly venue: UserVenueDescriptor;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly clock: () => Date;
  private readonly timeoutMs: number;
  private readonly nonceSource: HyperliquidNonceSource;
  private marketsCache: { index: MarketIndex; loadedAtMs: number } | null = null;
  /** One listing read at a time: concurrent callers share it. */
  private marketsInFlight: Promise<MarketIndex> | null = null;
  private lastMissRefreshMs = Number.NEGATIVE_INFINITY;
  /**
   * Destinations of withdrawals signed and sent through this instance, by
   * nonce. The venue's ledger read does not report one; this is the
   * destination in the signed bytes the venue ran under that nonce.
   */
  private readonly withdrawalDestinations = new Map<string, string>();

  constructor(options: HyperliquidTestnetOptions) {
    this.baseUrl = assertTestnetUrl(options.baseUrl ?? HL_TESTNET_API_URL);
    this.venue = {
      id: HL_TESTNET_VENUE_ID,
      displayName: 'TEST venue (testnet)',
      kind: 'external-dex',
      sequencedDepth: false,
      proofLevel: 'partner-sandbox',
    };
    refuseTestVenueOutsideTest(this.venue, options.appEnv);
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.clock = options.clock ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.nonceSource = options.nonceSource ?? new InMemoryNonceSource();
  }

  // ── transport ──────────────────────────────────────────────────────────

  /** A read. Any failure to get a readable answer is `venue_down`: nothing was changed by a read. */
  private async info(body: Record<string, Json>): Promise<Json> {
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

  private asOf<T>(value: T, venueTimeMs?: number): AsOf<T> {
    return { venueId: this.venue.id, value, asOf: venueTimeMs !== undefined ? new Date(venueTimeMs) : this.clock() };
  }

  private user(account: UserVenueAccount): string {
    return (account.subAccount ?? account.owner).toLowerCase();
  }

  // ── markets ────────────────────────────────────────────────────────────

  /**
   * The venue's listing. Read again after `MARKETS_TTL_MS`, or sooner when a
   * caller meets a symbol or coin it does not know (`onMiss`), at most once
   * per `MARKETS_MISS_REFRESH_MS`. One read is in flight at a time.
   */
  private async loadMarkets(onMiss = false): Promise<MarketIndex> {
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

  private async marketOfCoin(coin: string): Promise<HlMarket | undefined> {
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

  private async market(symbol: string): Promise<HlMarket> {
    const m = (await this.loadMarkets()).bySymbol.get(symbol) ?? (await this.loadMarkets(true)).bySymbol.get(symbol);
    if (!m) throw refusal(this.venue.id, 'unknown_market', `${symbol} is not listed on this venue`);
    return m;
  }

  private async symbolOfCoin(coin: string): Promise<string> {
    return (await this.marketOfCoin(coin))?.symbol ?? coin;
  }

  async markets(account: UserVenueAccount | null): Promise<AsOf<readonly UserVenueMarket[]>> {
    const { bySymbol } = await this.loadMarkets();
    let fees: { [key: string]: Json } | null = null;
    if (account) fees = obj(await this.info({ type: 'userFees', user: this.user(account) }), 'userFees');
    const fee = (field: string): MaybeKnown<Amount> =>
      fees && typeof fees[field] === 'string' ? { known: true, value: rateToBps(fees[field]) } : { known: false };
    const list: UserVenueMarket[] = [...bySymbol.values()].map((m) => ({
      symbol: m.symbol,
      kind: m.kind,
      baseAsset: m.base,
      quoteAsset: m.quote,
      orderTypes: ['limit', 'market'],
      timeInForce: ['GTC', 'IOC', 'ALO'],
      marginModes: m.kind === 'spot' ? [] : m.onlyIsolated ? ['isolated'] : ['cross', 'isolated'],
      maxLeverageBps: m.maxLeverage === null ? null : m.maxLeverage * BPS_PER_X,
      // The finest price step a non-integer price may use; the venue also caps prices at 5 significant figures.
      tickSize: unit((m.kind === 'spot' ? SPOT_MAX_DECIMALS : PERP_MAX_DECIMALS) - m.szDecimals),
      lotSize: unit(m.szDecimals),
      makerFeeBps: fee(m.kind === 'spot' ? 'userSpotAddRate' : 'userAddRate'),
      takerFeeBps: fee(m.kind === 'spot' ? 'userSpotCrossRate' : 'userCrossRate'),
    }));
    return this.asOf(list);
  }

  // ── prepare ────────────────────────────────────────────────────────────

  async prepare(account: UserVenueAccount, signer: VenueSigner, intent: VenueIntent): Promise<PreparedVenueAction> {
    this.checkAccount(account);
    assertSignerMaySign(account, signer, intent);
    if (signer.role === 'agent') {
      const now = this.clock().getTime();
      const agents = (await this.agents(account)).value;
      const live = agents.find(
        (a) => a.address === signer.address.toLowerCase() && (a.validUntil === null || a.validUntil.getTime() > now),
      );
      if (!live)
        throw refusal(
          this.venue.id,
          'signer_not_authorised',
          `${signer.address.toLowerCase()} is not an approved, unexpired agent on this account`,
        );
    }
    if (intent.kind === 'place_order' && intent.builderFee) {
      const approved = (await this.builderFeeApproval(account, intent.builderFee.builder)).value;
      if (compare(approved, intent.builderFee.feeBps) < 0) {
        throw refusal(this.venue.id, 'builder_fee_not_approved', 'this account has approved less for the builder than the order carries');
      }
    }
    // Strictly increasing milliseconds near the clock, per signer: the venue keeps the highest nonces per signer and refuses a reused one.
    const nonce = await this.nonceSource.next(signer.address, this.clock().getTime());
    if (!/^\d+$/.test(nonce)) throw new Error(`nonce source returned ${nonce}, not a millisecond nonce`);
    const built = await this.build(account, intent, nonce);
    return {
      venueId: this.venue.id,
      account,
      signer,
      intent,
      nonce,
      venueClientOrderId:
        intent.kind === 'place_order' || intent.kind === 'cancel_order' ? venueClientOrderId(this.venue.id, intent.clientOrderKey) : null,
      typedData: built.typedData,
      digest: typedDataDigest(built.typedData),
      builderFee:
        intent.kind === 'place_order' && intent.builderFee
          ? { builder: intent.builderFee.builder.toLowerCase(), feeBps: intent.builderFee.feeBps }
          : null,
      preparedAt: this.clock(),
    };
  }

  private checkAccount(account: UserVenueAccount): void {
    if (account.venueId !== this.venue.id)
      throw refusal(this.venue.id, 'venue_rejected', `account is on ${account.venueId}, not ${this.venue.id}`);
  }

  /** The exact action and typed data for `intent`. Deterministic from (account, intent, nonce) and the venue's listing. */
  private async build(account: UserVenueAccount, intent: VenueIntent, nonce: string): Promise<BuiltAction> {
    const venueId = this.venue.id;
    const vault = account.subAccount ? account.subAccount.toLowerCase() : null;
    const l1 = (action: Record<string, MsgpackValue>): BuiltAction => ({
      action,
      vaultAddress: vault,
      typedData: l1TypedData(actionHash(action, vault, BigInt(nonce))),
    });
    const userSigned = (
      primaryType: UserSignedPrimaryType,
      type: string,
      fields: Record<string, string>,
      nonceField: 'time' | 'nonce',
    ): BuiltAction => {
      const action: Record<string, MsgpackValue> = {
        type,
        signatureChainId: HL_SIGNATURE_CHAIN_ID,
        hyperliquidChain: HL_TESTNET_CHAIN,
        ...fields,
        [nonceField]: Number(nonce),
      };
      const typedData = userSignedTypedData(primaryType, USER_SIGNED_TYPES[primaryType], {
        hyperliquidChain: HL_TESTNET_CHAIN,
        ...fields,
        [nonceField]: BigInt(nonce),
      });
      return { action, typedData, vaultAddress: null };
    };

    switch (intent.kind) {
      case 'place_order': {
        const m = await this.market(intent.symbol);
        const order = this.orderWire(m, intent);
        const action: Record<string, MsgpackValue> = { type: 'order', orders: [order], grouping: 'na' };
        if (intent.builderFee) {
          const f = bpsToTenths(intent.builderFee.feeBps);
          if (f === null || f < 0)
            throw refusal(venueId, 'not_offered', 'the builder fee must be a whole number of tenths of a basis point');
          action.builder = { b: intent.builderFee.builder.toLowerCase(), f };
        }
        return l1(action);
      }
      case 'cancel_order': {
        const m = await this.market(intent.symbol);
        return l1({ type: 'cancelByCloid', cancels: [{ asset: m.asset, cloid: venueClientOrderId(venueId, intent.clientOrderKey) }] });
      }
      case 'update_leverage': {
        const m = await this.market(intent.symbol);
        if (m.kind !== 'perpetual') throw refusal(venueId, 'not_offered', `${m.symbol} is spot: leverage is not offered`);
        if (!Number.isSafeInteger(intent.leverageBps) || intent.leverageBps % BPS_PER_X !== 0 || intent.leverageBps < BPS_PER_X) {
          throw refusal(venueId, 'not_offered', 'this venue takes whole leverage only (a multiple of 10000 bps, at least 1x)');
        }
        const leverage = intent.leverageBps / BPS_PER_X;
        if (m.maxLeverage !== null && leverage > m.maxLeverage)
          throw refusal(venueId, 'not_offered', `${m.symbol} offers at most ${m.maxLeverage}x`);
        if (intent.marginMode === 'cross' && m.onlyIsolated)
          throw refusal(venueId, 'not_offered', `${m.symbol} offers isolated margin only`);
        return l1({ type: 'updateLeverage', asset: m.asset, isCross: intent.marginMode === 'cross', leverage });
      }
      case 'withdraw': {
        if (account.subAccount !== null)
          throw refusal(venueId, 'not_offered', 'a withdrawal from a sub-account is not offered: move the funds to the main account first');
        // withdraw3 draws on the perpetual account's USDC, which balances() reports as USDC-PERP. Spot USDC is a different balance.
        if (intent.asset !== PERP_COLLATERAL_ASSET) {
          throw refusal(
            venueId,
            'not_offered',
            `only ${PERP_COLLATERAL_ASSET} (the perpetual account's USDC) can be withdrawn here; move spot funds to the perpetual account first`,
          );
        }
        if (compare(intent.amount, ZERO) <= 0) throw refusal(venueId, 'venue_rejected', 'a withdrawal must be positive');
        const problem = sizeProblem(intent.amount, WITHDRAW_DECIMALS);
        if (problem) throw refusal(venueId, 'venue_rejected', `withdrawal: ${problem}`);
        return userSigned(
          'HyperliquidTransaction:Withdraw',
          'withdraw3',
          { destination: intent.destination.toLowerCase(), amount: toWire(intent.amount) },
          'time',
        );
      }
      case 'approve_builder_fee': {
        const f = bpsToTenths(intent.maxFeeBps);
        if (f === null || f < 0)
          throw refusal(venueId, 'not_offered', 'the builder fee approval must be a whole number of tenths of a basis point');
        return userSigned(
          'HyperliquidTransaction:ApproveBuilderFee',
          'approveBuilderFee',
          { maxFeeRate: bpsToPercentString(intent.maxFeeBps), builder: intent.builder.toLowerCase() },
          'nonce',
        );
      }
      case 'approve_agent': {
        if (intent.validUntil !== null) {
          throw refusal(venueId, 'not_offered', 'an agent expiry is not offered by this adapter yet: approve without one');
        }
        if (intent.agentName.trim() === '')
          throw refusal(venueId, 'venue_rejected', 'an agent needs a name, so it can be listed and replaced');
        return userSigned(
          'HyperliquidTransaction:ApproveAgent',
          'approveAgent',
          { agentAddress: intent.agentAddress.toLowerCase(), agentName: intent.agentName },
          'nonce',
        );
      }
      case 'revoke_agent':
        throw refusal(venueId, 'not_offered', 'revoking an agent is not offered by this adapter yet');
      case 'amend_order':
        throw refusal(venueId, 'not_offered', 'amend is not offered by this adapter yet: cancel and place a new order');
    }
  }

  private orderWire(m: HlMarket, intent: PlaceUserOrderIntent): Record<string, MsgpackValue> {
    const venueId = this.venue.id;
    if (intent.type === 'market' && intent.timeInForce === 'ALO')
      throw refusal(venueId, 'not_offered', 'a market order cannot be post-only');
    const sizeIssue = sizeProblem(intent.amount, m.szDecimals);
    if (sizeIssue) throw refusal(venueId, 'venue_rejected', `${m.symbol}: ${sizeIssue}`);
    const priceIssue = priceProblem(intent.price, m.szDecimals, m.kind);
    if (priceIssue) throw refusal(venueId, 'venue_rejected', `${m.symbol}: ${priceIssue}`);
    // A market order is an IOC limit at the customer's worst price (the interface's rule, and the venue's own).
    const tif = intent.type === 'market' ? 'Ioc' : TIF_WIRE[intent.timeInForce];
    // Key order is the SDK's (order_request_to_order_wire): the hash depends on it.
    return {
      a: m.asset,
      b: intent.side === 'buy',
      p: toWire(intent.price),
      s: toWire(intent.amount),
      r: intent.reduceOnly,
      t: { limit: { tif } },
      c: venueClientOrderId(venueId, intent.clientOrderKey),
    };
  }

  // ── submit ─────────────────────────────────────────────────────────────

  async submit(prepared: PreparedVenueAction, signature: VenueSignature): Promise<VenueSubmitOutcome> {
    const venueId = this.venue.id;
    assertSignatureMatches(prepared, signature);
    this.checkAccount(prepared.account);
    assertSignerMaySign(prepared.account, prepared.signer, prepared.intent);
    // Rebuild from the intent: the prepared object may have been edited after prepare.
    const built = await this.build(prepared.account, prepared.intent, prepared.nonce);
    const digest = typedDataDigest(built.typedData);
    if (digest.toLowerCase() !== prepared.digest.toLowerCase()) {
      throw refusal(venueId, 'signature_mismatch', 'the prepared action does not match its own digest');
    }
    const recovered = await recoverTypedDataSigner(built.typedData, signature.signature);
    if (recovered !== prepared.signer.address.toLowerCase()) {
      throw refusal(
        venueId,
        'signature_mismatch',
        `the signature was made by ${recovered ?? 'no valid key'}, not ${prepared.signer.address.toLowerCase()}`,
      );
    }
    const body = JSON.stringify({
      action: built.action,
      nonce: Number(prepared.nonce),
      signature: splitSignature(signature.signature),
      vaultAddress: built.vaultAddress,
      expiresAfter: null,
    });
    if (prepared.intent.kind === 'withdraw') this.withdrawalDestinations.set(prepared.nonce, prepared.intent.destination.toLowerCase());

    const sent = await this.post(body);
    if (sent.kind === 'unknown') return { definite: false, reason: sent.reason };
    const asOf = this.clock();
    let line: StatusLine;
    try {
      const answer = obj(sent.json, 'exchange answer');
      if (answer.status === 'err') line = { kind: 'error', text: str(answer.response, 'error text') };
      else if (answer.status === 'ok') line = statusLine(answer.response ?? null);
      else return { definite: false, reason: 'venue_error_after_send' };
    } catch {
      // An answer we cannot read after the bytes went out is not an answer.
      return { definite: false, reason: 'venue_error_after_send' };
    }
    return this.outcomeOf(prepared, line, asOf);
  }

  private async outcomeOf(prepared: PreparedVenueAction, line: StatusLine, asOf: Date): Promise<VenueSubmitOutcome> {
    const venueId = this.venue.id;
    const intent = prepared.intent;
    if (intent.kind === 'cancel_order') {
      // A repeat cancel, or a cancel of an order already gone: the venue's record of the order is the answer.
      if (line.kind === 'accepted' || /never placed|already canceled|already cancelled|filled/i.test(line.text)) {
        let order: UserVenueOrder | null;
        try {
          order = (await this.orderByClientId(prepared.account, prepared.venueClientOrderId!)).value;
        } catch {
          if (line.kind === 'accepted') return { definite: true, accepted: true, venueRef: null, order: null, asOf };
          return { definite: true, accepted: false, refusal: { venueId, code: 'venue_rejected', detail: line.text }, asOf };
        }
        if (order === null) {
          // The venue said success: that wins. A read that finds nothing yet is "not found yet", never a refusal.
          if (line.kind === 'accepted') return { definite: true, accepted: true, venueRef: null, order: null, asOf };
          return {
            definite: true,
            accepted: false,
            refusal: { venueId, code: 'unknown_order', detail: 'no order with this client id on the venue' },
            asOf,
          };
        }
        if (order.status === 'canceled') return { definite: true, accepted: true, venueRef: order.venueOrderId, order, asOf };
        if (line.kind === 'accepted') return { definite: true, accepted: true, venueRef: order.venueOrderId, order, asOf };
        return {
          definite: true,
          accepted: false,
          refusal: { venueId, code: 'order_final', detail: `the order is already ${order.status}` },
          asOf,
        };
      }
      return classifyVenueError(venueId, line.text, asOf);
    }
    if (line.kind === 'error') return classifyVenueError(venueId, line.text, asOf);
    let order: UserVenueOrder | null = null;
    if (intent.kind === 'place_order') {
      try {
        order = (await this.orderByClientId(prepared.account, prepared.venueClientOrderId!)).value;
      } catch {
        order = null; // accepted is definite; the order's detail is read back later
      }
    }
    return { definite: true, accepted: true, venueRef: line.venueRef, order, asOf };
  }

  private async post(
    body: string,
  ): Promise<{ kind: 'json'; json: Json } | { kind: 'unknown'; reason: 'timeout' | 'connection_lost' | 'venue_error_after_send' }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/exchange`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: controller.signal,
        });
      } catch (error) {
        return {
          kind: 'unknown',
          reason: controller.signal.aborted || (error as Error).name === 'AbortError' ? 'timeout' : 'connection_lost',
        };
      }
      let text: string;
      try {
        text = await res.text();
      } catch (error) {
        return {
          kind: 'unknown',
          reason: controller.signal.aborted || (error as Error).name === 'AbortError' ? 'timeout' : 'connection_lost',
        };
      }
      // The venue states its refusals as HTTP 200 (`status: "err"`, or an `error` per order). Any other status after the bytes
      // went out (a proxy's 403, 408 or 409, a 429, a 5xx) may follow an applied action, and nothing here proves a 429 came
      // before the action reached the venue: never a refusal, always a read-back.
      if (!res.ok) return { kind: 'unknown', reason: 'venue_error_after_send' };
      try {
        return { kind: 'json', json: JSON.parse(text) as Json };
      } catch {
        return { kind: 'unknown', reason: 'venue_error_after_send' };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // ── account reads ──────────────────────────────────────────────────────

  async balances(account: UserVenueAccount): Promise<AsOf<readonly UserVenueBalance[]>> {
    const user = this.user(account);
    const [perp, spot] = await Promise.all([
      this.info({ type: 'clearinghouseState', user }),
      this.info({ type: 'spotClearinghouseState', user }),
    ]);
    const p = obj(perp, 'clearinghouseState');
    const summary = obj(p.marginSummary, 'marginSummary');
    const accountValue = amt(summary.accountValue, 'accountValue');
    const withdrawable = amt(p.withdrawable, 'withdrawable');
    const list: UserVenueBalance[] = [];
    for (const b of arr(obj(spot, 'spotClearinghouseState').balances, 'spot balances')) {
      const bal = obj(b, 'spot balance');
      const total = amt(bal.total, 'spot total');
      const hold = amt(bal.hold, 'spot hold');
      list.push({ asset: str(bal.coin, 'spot coin'), free: sub(total, hold), locked: hold, total });
    }
    if (accountValue !== ZERO || withdrawable !== ZERO) {
      // The venue reports the perp account's value and what can be withdrawn; what is held is the difference.
      list.push({ asset: PERP_COLLATERAL_ASSET, free: withdrawable, locked: sub(accountValue, withdrawable), total: accountValue });
    }
    list.sort((a, b) => a.asset.localeCompare(b.asset));
    return this.asOf(list, typeof p.time === 'number' ? p.time : undefined);
  }

  private async toOrder(
    account: UserVenueAccount,
    raw: { [key: string]: Json },
    status: VenueOrderStatus | null,
    leverageOf: (coin: string) => Promise<number | null>,
  ): Promise<UserVenueOrder> {
    const coin = str(raw.coin, 'order coin');
    const m = await this.marketOfCoin(coin);
    const price = amt(raw.limitPx, 'limitPx');
    const remaining = amt(raw.sz, 'sz');
    const original = raw.origSz !== undefined ? amt(raw.origSz, 'origSz') : remaining;
    const filled = sub(original, remaining);
    const side = raw.side === 'B' ? 'buy' : 'sell';
    const orderType = typeof raw.orderType === 'string' ? raw.orderType : 'Limit';
    const tif: VenueTimeInForce = raw.tif === 'Ioc' ? 'IOC' : raw.tif === 'Alo' ? 'ALO' : 'GTC';
    const resolved: VenueOrderStatus = status ?? (compare(filled, ZERO) > 0 ? 'partially_filled' : 'open');
    const live = resolved === 'open' || resolved === 'partially_filled';
    let locked = ZERO;
    let lockedAsset = m?.quote ?? PERP_QUOTE;
    if (m && live) {
      if (m.kind === 'spot') {
        // The venue holds the quote notional of a resting buy and the base of a resting sell.
        if (side === 'buy') locked = mul(price, remaining, 'ceil');
        else {
          locked = remaining;
          lockedAsset = m.base;
        }
      } else {
        lockedAsset = PERP_COLLATERAL_ASSET;
        const lev = raw.reduceOnly === true ? null : await leverageOf(coin);
        // Initial margin of the open part at the account's leverage: our reading of the venue's rule, not a figure it reports.
        if (lev !== null) locked = div(mul(price, remaining, 'ceil'), parseAmount(String(lev)), 'ceil');
      }
    }
    return {
      venueOrderId: raw.oid !== undefined ? String(int(raw.oid, 'oid')) : null,
      venueClientOrderId: typeof raw.cloid === 'string' ? raw.cloid.toLowerCase() : null,
      symbol: m?.symbol ?? coin,
      side,
      type: /market/i.test(orderType) ? 'market' : 'limit',
      timeInForce: tif,
      price,
      amount: original,
      filled,
      remaining: live ? remaining : ZERO,
      averagePrice: null,
      status: resolved,
      locked,
      lockedAsset,
      reduceOnly: raw.reduceOnly === true,
    };
  }

  private leverageLookup(account: UserVenueAccount): (coin: string) => Promise<number | null> {
    const seen = new Map<string, Promise<number | null>>();
    return (coin) => {
      if (!seen.has(coin)) {
        seen.set(
          coin,
          this.info({ type: 'activeAssetData', user: this.user(account), coin }).then((d) => {
            const lev = obj(d, 'activeAssetData').leverage;
            return lev ? int(obj(lev, 'leverage').value, 'leverage value') : null;
          }),
        );
      }
      return seen.get(coin)!;
    };
  }

  async openOrders(account: UserVenueAccount): Promise<AsOf<readonly UserVenueOrder[]>> {
    const raw = arr(await this.info({ type: 'frontendOpenOrders', user: this.user(account) }), 'open orders');
    const lev = this.leverageLookup(account);
    const list: UserVenueOrder[] = [];
    for (const r of raw) list.push(await this.toOrder(account, obj(r, 'open order'), null, lev));
    return this.asOf(list);
  }

  async orderByClientId(account: UserVenueAccount, cloid: string): Promise<AsOf<UserVenueOrder | null>> {
    const answer = obj(await this.info({ type: 'orderStatus', user: this.user(account), oid: cloid.toLowerCase() }), 'orderStatus');
    if (answer.status === 'unknownOid') return this.asOf(null);
    const wrapped = obj(answer.order, 'orderStatus.order');
    const venueStatus = str(wrapped.status, 'order status');
    const raw = obj(wrapped.order, 'orderStatus.order.order');
    const status = mapOrderStatus(venueStatus);
    // An open order's part-filled state comes from its sizes.
    const order = await this.toOrder(account, raw, status === 'open' ? null : status, this.leverageLookup(account));
    return this.asOf(order, typeof wrapped.statusTimestamp === 'number' ? wrapped.statusTimestamp : undefined);
  }

  /**
   * Every fill since `since`. The venue caps one answer at `FILLS_PAGE_CAP`
   * fills (and keeps only the 10000 most recent), so this pages: each next
   * page starts at the last fill's millisecond, not after it, so fills that
   * share that millisecond are neither dropped nor counted twice (deduped by
   * the venue's `tid`). It stops on a short page, or a page that adds nothing.
   * The docs' general pagination note says ranged answers return 500
   * elements; the per-endpoint 2000 is the one used, and the "adds nothing"
   * stop keeps a smaller cap from looping.
   */
  async fills(account: UserVenueAccount, since: Date): Promise<AsOf<readonly UserVenueFill[]>> {
    const seen = new Map<string, { [key: string]: Json }>();
    let startTime = since.getTime();
    for (;;) {
      const page = arr(await this.info({ type: 'userFillsByTime', user: this.user(account), startTime, aggregateByTime: false }), 'fills');
      let added = 0;
      let lastTime = startTime;
      for (const entry of page) {
        const f = obj(entry, 'fill');
        const tid = String(int(f.tid, 'tid'));
        lastTime = Math.max(lastTime, int(f.time, 'fill time'));
        if (!seen.has(tid)) {
          seen.set(tid, f);
          added += 1;
        }
      }
      if (page.length < FILLS_PAGE_CAP || added === 0) break;
      if (lastTime === startTime) {
        // A full page all in one millisecond: the next page would be the same one. Refuse loudly rather than drop fills.
        throw refusal(this.venue.id, 'venue_rejected', `more than ${FILLS_PAGE_CAP} fills at ${startTime}: cannot page past them`);
      }
      startTime = lastTime;
    }
    const list: UserVenueFill[] = [];
    for (const f of seen.values()) {
      const coin = str(f.coin, 'fill coin');
      const m = await this.marketOfCoin(coin);
      const totalFee = amt(f.fee, 'fill fee');
      const builderFee = f.builderFee !== undefined ? amt(f.builderFee, 'fill builderFee') : ZERO;
      const dir = typeof f.dir === 'string' ? f.dir : '';
      const perp = m?.kind === 'perpetual';
      list.push({
        fillId: String(int(f.tid, 'tid')),
        venueClientOrderId: typeof f.cloid === 'string' ? f.cloid.toLowerCase() : null,
        symbol: m?.symbol ?? coin,
        side: f.side === 'B' ? 'buy' : 'sell',
        price: amt(f.px, 'fill px'),
        amount: amt(f.sz, 'fill sz'),
        role: f.crossed === true ? 'taker' : 'maker',
        // The venue's `fee` includes the builder fee (our reading; checked on the live run): the venue's own line is the rest.
        venueFee: sub(totalFee, builderFee),
        builderFee,
        feeAsset: str(f.feeToken, 'feeToken'),
        realisedPnl: perp && !dir.startsWith('Open') ? amt(f.closedPnl, 'closedPnl') : null,
        filledAt: new Date(int(f.time, 'fill time')),
      });
    }
    list.sort((x, y) => x.filledAt.getTime() - y.filledAt.getTime() || compareTid(x.fillId, y.fillId));
    return this.asOf(list);
  }

  async positions(account: UserVenueAccount): Promise<AsOf<readonly UserVenuePosition[]>> {
    const [state, ctxs] = await Promise.all([
      this.info({ type: 'clearinghouseState', user: this.user(account) }),
      this.info({ type: 'metaAndAssetCtxs' }),
    ]);
    // The mark comes from the same answer's own universe: its contexts are indexed by that list, not by a cached one.
    const both = arr(ctxs, 'metaAndAssetCtxs');
    const universe = arr(obj(both[0], 'metaAndAssetCtxs meta').universe, 'metaAndAssetCtxs universe');
    const assetCtxs = arr(both[1], 'asset contexts');
    const indexOfCoin = new Map<string, number>();
    universe.forEach((u, i) => indexOfCoin.set(str(obj(u, 'universe entry').name, 'universe name'), i));
    const markOf = (coin: string): Amount | null => {
      const i = indexOfCoin.get(coin);
      const ctx = i === undefined ? undefined : assetCtxs[i];
      return ctx ? amt(obj(ctx, 'asset ctx').markPx, 'markPx') : null;
    };
    const s = obj(state, 'clearinghouseState');
    const list: UserVenuePosition[] = [];
    for (const ap of arr(s.assetPositions, 'assetPositions')) {
      const p = obj(obj(ap, 'assetPosition').position, 'position');
      const coin = str(p.coin, 'position coin');
      const szi = amt(p.szi, 'szi');
      if (szi === ZERO) continue;
      const leverage = obj(p.leverage, 'position leverage');
      const mark = markOf(coin);
      if (mark === null) throw refusal(this.venue.id, 'venue_rejected', `no mark price reported for ${coin}`);
      list.push({
        symbol: await this.symbolOfCoin(coin),
        side: compare(szi, ZERO) > 0 ? 'long' : 'short',
        size: abs(szi),
        entryPrice: amt(p.entryPx, 'entryPx'),
        markPrice: mark,
        unrealisedPnl: amt(p.unrealizedPnl, 'unrealizedPnl'),
        marginMode: leverage.type === 'isolated' ? 'isolated' : 'cross',
        margin: amt(p.marginUsed, 'marginUsed'),
        leverageBps: int(leverage.value, 'leverage value') * BPS_PER_X,
        liquidationPrice: typeof p.liquidationPx === 'string' ? { known: true, value: parseAmount(p.liquidationPx) } : { known: false },
      });
    }
    list.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return this.asOf(list, typeof s.time === 'number' ? s.time : undefined);
  }

  async withdrawal(account: UserVenueAccount, nonce: string): Promise<AsOf<UserVenueWithdrawal | null>> {
    if (!/^\d+$/.test(nonce)) throw refusal(this.venue.id, 'venue_rejected', `nonce ${nonce} is not a millisecond nonce`);
    // The ledger entry is stamped at or after the signed nonce; start a minute before it in case of clock skew.
    const startTime = Math.max(0, Number(nonce) - 60_000);
    const raw = arr(await this.info({ type: 'userNonFundingLedgerUpdates', user: this.user(account), startTime }), 'ledger updates');
    for (const entry of raw) {
      const e = obj(entry, 'ledger update');
      const delta = obj(e.delta, 'ledger delta');
      if (delta.type !== 'withdraw' || String(delta.nonce) !== nonce) continue;
      return this.asOf(
        {
          nonce,
          // The asset the intent named: withdraw3 draws on the perpetual account's USDC.
          asset: PERP_COLLATERAL_ASSET,
          amount: amt(delta.usdc, 'withdraw usdc'),
          // The venue's ledger entry names no destination: we know it only for withdrawals this instance signed and sent;
          // otherwise it is honestly unknown (null), never a made-up value.
          destination: this.withdrawalDestinations.get(nonce) ?? null,
          // The ledger shows the debit; it does not report when the bridge paid out.
          status: 'pending',
          fee: typeof delta.fee === 'string' ? { known: true, value: parseAmount(delta.fee) } : { known: false },
        },
        typeof e.time === 'number' ? e.time : undefined,
      );
    }
    return this.asOf(null);
  }

  async builderFeeApproval(account: UserVenueAccount, builder: string): Promise<AsOf<Amount>> {
    const tenths = await this.info({ type: 'maxBuilderFee', user: account.owner.toLowerCase(), builder: builder.toLowerCase() });
    return this.asOf(tenthsToBps(int(tenths, 'maxBuilderFee')));
  }

  async agents(account: UserVenueAccount): Promise<AsOf<readonly UserVenueAgent[]>> {
    const raw = arr(await this.info({ type: 'extraAgents', user: account.owner.toLowerCase() }), 'extraAgents');
    return this.asOf(
      raw.map((entry) => {
        const a = obj(entry, 'agent');
        return {
          address: str(a.address, 'agent address').toLowerCase(),
          name: typeof a.name === 'string' ? a.name : '',
          validUntil: typeof a.validUntil === 'number' ? new Date(a.validUntil) : null,
        };
      }),
    );
  }

  async leverage(account: UserVenueAccount, symbol: string): Promise<AsOf<UserVenueLeverage | null>> {
    const m = await this.market(symbol);
    if (m.kind !== 'perpetual') return this.asOf(null);
    const data = obj(await this.info({ type: 'activeAssetData', user: this.user(account), coin: m.coin }), 'activeAssetData');
    if (!data.leverage) return this.asOf(null);
    const lev = obj(data.leverage, 'leverage');
    return this.asOf({
      symbol,
      leverageBps: int(lev.value, 'leverage value') * BPS_PER_X,
      marginMode: lev.type === 'isolated' ? 'isolated' : 'cross',
    });
  }
}

/** Venue trade ids are whole numbers as decimal strings: order them as numbers, without a `number`. */
function compareTid(x: string, y: string): number {
  return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
}

/** The venue's order status words to ours. An unknown word is loud, never guessed. */
export function mapOrderStatus(venueStatus: string): VenueOrderStatus {
  if (venueStatus === 'open' || venueStatus === 'triggered') return 'open';
  if (venueStatus === 'filled') return 'filled';
  if (venueStatus === 'rejected' || venueStatus.endsWith('Rejected')) return 'rejected';
  if (venueStatus === 'canceled' || venueStatus.endsWith('Canceled') || venueStatus === 'scheduledCancel') return 'canceled';
  throw new Error(`venue order status "${venueStatus}" is not one this adapter knows`);
}
