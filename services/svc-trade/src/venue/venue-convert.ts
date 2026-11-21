/**
 * CONVERT ON THE PERSON'S OWN VENUE ACCOUNT (J-cex-spot-11; docs/adr/2026-11-10-launch-money-model.md). We hold no customer
 * money at launch, so a conversion is one venue order the person's wallet signs, never a fill against our own book:
 *
 *   · A QUOTE holds nothing. It reads the venue's best price on the side the conversion meets, bounds it by the owner's
 *     slippage cap (`TRADE_MARKET_SLIPPAGE_CAP_BPS`) into the order's limit price, sizes the order so it never costs more
 *     than the typed spend, and asks the venue's own preview for the venue fee and our builder fee. Nothing is sent to the
 *     venue and nothing is locked. It is stored under `(userId, quoteId)`, the caller's own key for the ask.
 *   · ACCEPTING it prepares one venue order (an IOC limit at the quote's limit price) under the business key
 *     `convert:<owner>:<quoteId>`, through the user-venue door (one prepared action per key): a double press, the same
 *     quote id accepted twice and Check again all land on that one action. Past the quote's window
 *     (`TRADE_CONVERT_ACCEPT_WINDOW_MS`, an owner value) an action not yet signed is refused at accept and at submit, so
 *     nothing is signed on a stale price. The door reserves `convert:` keys to this module.
 *   · A LIMIT CONVERT rests one venue order (GTC at the target rate) under `convert:<owner>:limit:<limitKey>`.
 *   · A conversion's state, paid and received amounts and time are read from the venue by client id, never posted. The
 *     ledger posts nothing for the swap; a sell's builder fee is posted once per fill by the builder-fee poster, as for
 *     every order the door signed (src/builder-fee/builder-fee-poster.ts). A buy carries no builder fee.
 */
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { Principal } from '@intafaced/auth';
import { add, div, formatAmount, mul, parseAmount, sub, type Amount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  type MaybeKnown,
  type PlaceUserOrderIntent,
  type UserVenueFill,
  type VenueAssetAmount,
  type VenuePreviewFill,
  type VenueSignature,
} from '@intafaced/venue-contracts';
import { isCashCurrency } from '../convert/pairs.js';
import { NO_CASH_LEG, type CashLegOffer, type CashLegPort } from '../convert/cash-leg-client.js';
import type { BankCashLeg } from '@intafaced/contracts/bank-cash-leg-procedures';
import { requireMarketSlippageCapBps } from '../spot/risk.js';
import type { StoredVenueAction } from './prepared-action-store.js';
import {
  CONVERT_KEY_PREFIX,
  UserVenueDoorError,
  discountedBuilderFee,
  marketProtectionBound,
  type PreparedAnswer,
  type SubmitAnswer,
  type UserVenueDoor,
  type UserVenueDoorCode,
} from './user-venue-door.js';
import type { ListedVenueMarket } from './venue-listing.js';

export type ConvertSide = 'buy' | 'sell';

/** Our builder fee on the conversion: none on a buy (the venue charges builder fees on a spot sell only), else in the quote asset. */
export type ConvertBuilderFee =
  | { readonly kind: 'none'; readonly reason: 'buy' }
  | { readonly kind: 'quote_asset'; readonly bps: Amount; readonly amount: MaybeKnown<Amount> };

/**
 * The cash leg of a cash-through-a-coin convert (#11), as the quote priced it: the partner sells the venue's quote coin for
 * the person's cash and pays it into their own venue account, then the venue order spends `coinSpend` of it.
 */
export interface ConvertCashLeg {
  readonly asset: string;
  /** The venue's quote coin the partner pays in. */
  readonly coin: string;
  /** The coins one unit of cash buys, as the partner gave it when priced. */
  readonly rate: Amount;
  /** The coin the partner pays in and the venue order spends. */
  readonly coinSpend: Amount;
  readonly label: string;
  readonly test: boolean;
  /** When the person accepted it (the partner was asked to carry it), or null before. */
  readonly acceptedAt: Date | null;
}

export interface ConvertQuote {
  readonly quoteId: string;
  readonly userId: string;
  readonly venueId: string;
  /** Any venue but a live one is TEST, and so is every figure from it. */
  readonly test: boolean;
  readonly owner: string;
  readonly market: string;
  readonly side: ConvertSide;
  readonly from: string;
  readonly to: string;
  /** What is paid, in `from`: the quote asset on a buy, the coin on a sell. */
  readonly spend: Amount;
  /** The order's size in the base asset. On a buy, the most whole lots `spend` pays for at `limitPrice`. */
  readonly size: Amount;
  /** The venue's best ask (a buy) or bid (a sell) as read, with the venue's time. */
  readonly bestPrice: { readonly price: Amount; readonly asOf: Date };
  /** `bestPrice` moved by the slippage cap and rounded to the tick against the person: the worst price the order fills at. */
  readonly limitPrice: Amount;
  readonly slippageBps: number;
  readonly builderFee: ConvertBuilderFee;
  /** The venue's fee as its preview of this order reports it. */
  readonly venueFee: MaybeKnown<VenueAssetAmount>;
  /** What the venue's preview says fills now, and its average price. */
  readonly fill: MaybeKnown<VenuePreviewFill>;
  /** The end of the window this price may be accepted in. The venue holds no price: it is only how long ours is fresh. */
  readonly freshUntil: Date;
  readonly createdAt: Date;
  /** The partner's cash leg before the venue order, on a convert from a cash currency; null on a one-leg convert. */
  readonly cashLeg: ConvertCashLeg | null;
}

export interface ConvertQuoteStore {
  /** Stores `quote` unless the person already has one under its id; returns the one stored. */
  insert(quote: ConvertQuote): Promise<ConvertQuote>;
  get(userId: string, quoteId: string): Promise<ConvertQuote | null>;
  /** Notes once that the person accepted a quote's cash leg; a second note keeps the first time. */
  markCashAccepted(userId: string, quoteId: string, at: Date): Promise<void>;
  /** The person's accepted cash-leg quotes on one venue account. */
  cashAccepted(userId: string, owner: string): Promise<ConvertQuote[]>;
}

export class MemoryConvertQuoteStore implements ConvertQuoteStore {
  private readonly rows = new Map<string, ConvertQuote>();

  async insert(quote: ConvertQuote): Promise<ConvertQuote> {
    const id = `${quote.userId}\u0000${quote.quoteId}`;
    const had = this.rows.get(id);
    if (had) return had;
    this.rows.set(id, quote);
    return quote;
  }

  async get(userId: string, quoteId: string): Promise<ConvertQuote | null> {
    return this.rows.get(`${userId}\u0000${quoteId}`) ?? null;
  }

  async markCashAccepted(userId: string, quoteId: string, at: Date): Promise<void> {
    const id = `${userId}\u0000${quoteId}`;
    const q = this.rows.get(id);
    if (q?.cashLeg && !q.cashLeg.acceptedAt) this.rows.set(id, { ...q, cashLeg: { ...q.cashLeg, acceptedAt: at } });
  }

  async cashAccepted(userId: string, owner: string): Promise<ConvertQuote[]> {
    return [...this.rows.values()].filter((q) => q.userId === userId && q.owner === owner && q.cashLeg?.acceptedAt);
  }
}

const Row = z.object({
  user_id: z.string(),
  quote_id: z.string(),
  venue_id: z.string(),
  test: z.boolean(),
  owner: z.string(),
  market: z.string(),
  side: z.enum(['buy', 'sell']),
  from_asset: z.string(),
  to_asset: z.string(),
  spend: z.string(),
  size: z.string(),
  best_price: z.string(),
  best_as_of: z.date(),
  limit_price: z.string(),
  slippage_bps: z.number().int(),
  builder_fee_bps: z.string().nullable(),
  builder_fee_amount: z.string().nullable(),
  venue_fee_amount: z.string().nullable(),
  venue_fee_asset: z.string().nullable(),
  fill_known: z.boolean(),
  fill_amount: z.string().nullable(),
  fill_average_price: z.string().nullable(),
  fresh_until: z.date(),
  created_at: z.date(),
  cash_asset: z.string().nullable(),
  cash_coin: z.string().nullable(),
  cash_rate: z.string().nullable(),
  cash_coin_spend: z.string().nullable(),
  cash_label: z.string().nullable(),
  cash_test: z.boolean().nullable(),
  cash_accepted_at: z.date().nullable(),
});
type Row = z.infer<typeof Row>;

const maybe = (value: string | null): MaybeKnown<Amount> =>
  value === null ? { known: false } : { known: true, value: parseAmount(value) };

function fromRow(r: Row): ConvertQuote {
  const builderFee: ConvertBuilderFee =
    r.builder_fee_bps === null
      ? { kind: 'none', reason: 'buy' }
      : { kind: 'quote_asset', bps: parseAmount(r.builder_fee_bps), amount: maybe(r.builder_fee_amount) };
  const venueFee: MaybeKnown<VenueAssetAmount> =
    r.venue_fee_amount === null || r.venue_fee_asset === null
      ? { known: false }
      : { known: true, value: { asset: r.venue_fee_asset, amount: parseAmount(r.venue_fee_amount) } };
  const fill: MaybeKnown<VenuePreviewFill> =
    !r.fill_known || r.fill_amount === null
      ? { known: false }
      : {
          known: true,
          value: {
            amount: parseAmount(r.fill_amount),
            averagePrice: r.fill_average_price === null ? null : parseAmount(r.fill_average_price),
          },
        };
  return {
    quoteId: r.quote_id,
    userId: r.user_id,
    venueId: r.venue_id,
    test: r.test,
    owner: r.owner,
    market: r.market,
    side: r.side,
    from: r.from_asset,
    to: r.to_asset,
    spend: parseAmount(r.spend),
    size: parseAmount(r.size),
    bestPrice: { price: parseAmount(r.best_price), asOf: r.best_as_of },
    limitPrice: parseAmount(r.limit_price),
    slippageBps: r.slippage_bps,
    builderFee,
    venueFee,
    fill,
    freshUntil: r.fresh_until,
    createdAt: r.created_at,
    cashLeg:
      r.cash_asset === null ||
      r.cash_coin === null ||
      r.cash_rate === null ||
      r.cash_coin_spend === null ||
      r.cash_label === null ||
      r.cash_test === null
        ? null
        : {
            asset: r.cash_asset,
            coin: r.cash_coin,
            rate: parseAmount(r.cash_rate),
            coinSpend: parseAmount(r.cash_coin_spend),
            label: r.cash_label,
            test: r.cash_test,
            acceptedAt: r.cash_accepted_at,
          },
  };
}

const COLUMNS = `user_id, quote_id, venue_id, test, owner, market, side, from_asset, to_asset, spend::text, size::text,
  best_price::text, best_as_of, limit_price::text, slippage_bps, builder_fee_bps::text,
  builder_fee_amount::text, venue_fee_amount::text, venue_fee_asset, fill_known, fill_amount::text,
  fill_average_price::text, fresh_until, created_at, cash_asset, cash_coin, cash_rate::text, cash_coin_spend::text, cash_label, cash_test,
  cash_accepted_at`;

export class SqlConvertQuoteStore implements ConvertQuoteStore {
  constructor(private readonly sql: Sql) {}

  async insert(q: ConvertQuote): Promise<ConvertQuote> {
    const fee = q.builderFee.kind === 'quote_asset' ? q.builderFee : null;
    const venueFee = q.venueFee.known ? q.venueFee.value : null;
    const fill = q.fill.known ? q.fill.value : null;
    await this.sql`
      INSERT INTO trade.venue_convert_quotes (
        user_id, quote_id, venue_id, test, owner, market, side, from_asset, to_asset, spend, size, best_price, best_as_of,
        limit_price, slippage_bps, builder_fee_bps, builder_fee_known, builder_fee_amount, venue_fee_known, venue_fee_amount,
        venue_fee_asset, fill_known, fill_amount, fill_average_price, fresh_until, created_at, cash_asset, cash_coin, cash_rate,
        cash_coin_spend, cash_label, cash_test
      ) VALUES (
        ${q.userId}, ${q.quoteId}, ${q.venueId}, ${q.test}, ${q.owner}, ${q.market}, ${q.side}, ${q.from}, ${q.to},
        ${formatAmount(q.spend)}, ${formatAmount(q.size)}, ${formatAmount(q.bestPrice.price)}, ${q.bestPrice.asOf.toISOString()},
        ${formatAmount(q.limitPrice)}, ${q.slippageBps}, ${fee ? formatAmount(fee.bps) : null}, ${fee ? fee.amount.known : false},
        ${fee && fee.amount.known ? formatAmount(fee.amount.value) : null}, ${q.venueFee.known},
        ${venueFee ? formatAmount(venueFee.amount) : null}, ${venueFee ? venueFee.asset : null}, ${q.fill.known},
        ${fill ? formatAmount(fill.amount) : null}, ${fill && fill.averagePrice !== null ? formatAmount(fill.averagePrice) : null},
        ${q.freshUntil.toISOString()}, ${q.createdAt.toISOString()}, ${q.cashLeg?.asset ?? null}, ${q.cashLeg?.coin ?? null},
        ${q.cashLeg ? formatAmount(q.cashLeg.rate) : null}, ${q.cashLeg ? formatAmount(q.cashLeg.coinSpend) : null},
        ${q.cashLeg?.label ?? null}, ${q.cashLeg ? q.cashLeg.test : null}
      )
      ON CONFLICT (user_id, quote_id) DO NOTHING`;
    const stored = await this.get(q.userId, q.quoteId);
    if (!stored) throw new Error(`convert quote ${q.quoteId} was not stored`);
    return stored;
  }

  async get(userId: string, quoteId: string): Promise<ConvertQuote | null> {
    const rows = Row.array().parse(
      await this
        .sql`SELECT ${this.sql.unsafe(COLUMNS)} FROM trade.venue_convert_quotes WHERE user_id = ${userId} AND quote_id = ${quoteId}`,
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async markCashAccepted(userId: string, quoteId: string, at: Date): Promise<void> {
    await this.sql`
      UPDATE trade.venue_convert_quotes SET cash_accepted_at = ${at.toISOString()}
      WHERE user_id = ${userId} AND quote_id = ${quoteId} AND cash_asset IS NOT NULL AND cash_accepted_at IS NULL`;
  }

  async cashAccepted(userId: string, owner: string): Promise<ConvertQuote[]> {
    return Row.array()
      .parse(
        await this.sql`SELECT ${this.sql.unsafe(COLUMNS)} FROM trade.venue_convert_quotes
          WHERE user_id = ${userId} AND owner = ${owner} AND cash_accepted_at IS NOT NULL ORDER BY created_at DESC LIMIT 200`,
      )
      .map(fromRow);
  }
}

/** One market Convert may use now, with what the room checks before asking for a price. */
export interface VenueConvertPair {
  readonly symbol: string;
  readonly base: string;
  readonly quote: string;
  /** Our largest routed order's notional, else the venue's own, in the quote asset; `null` when neither is set. */
  readonly maxPerConvert: Amount | null;
  /** The venue's smallest order value in the quote asset, or `null` when it publishes none. */
  readonly minOrderNotional: Amount | null;
  readonly lotSize: Amount;
  readonly tickSize: Amount;
}

export interface VenueConvertPairs {
  readonly venueId: string;
  readonly test: boolean;
  readonly pairs: readonly VenueConvertPair[];
  /** Every coin of a pair above, sorted. */
  readonly assets: readonly string[];
  /** Coins listed only on markets Convert may not use now (routing stopped, not open, delisted, halted): never offered. */
  readonly restricted: readonly string[];
  /** The operator's Convert switch is off (`TRADE_CONVERT_ENABLED`): nothing is priced or sent; the way on is Spot. */
  readonly paused: boolean;
  /** Cash currencies the partner converts through a coin for this person now (#11), each with its rate and the cash it holds. */
  readonly cash: readonly CashLegOffer[];
  /** Why no cash currency is offered, when none is. */
  readonly cashReason: string | null;
}

export interface ConvertAsk {
  readonly owner: string;
  readonly from: string;
  readonly to: string;
  /** The typed amount of `from`. */
  readonly amount: Amount;
  /** The caller's own id for this ask (letters, digits, `_`, `-`), reused on a retry of the same ask. */
  readonly quoteKey: string;
}

export interface LimitConvertAsk {
  readonly owner: string;
  readonly from: string;
  readonly to: string;
  readonly amount: Amount;
  /** The target rate: 1 base in the quote asset. */
  readonly price: Amount;
  readonly limitKey: string;
}

export type ConversionState = 'filled' | 'partially_filled' | 'resting' | 'not_filled' | 'rejected' | 'unknown';

/** One accepted conversion, as the venue records it. */
export interface Conversion {
  readonly actionKey: string;
  readonly kind: 'instant' | 'limit';
  readonly quoteId: string | null;
  readonly market: string;
  readonly side: ConvertSide;
  readonly from: string;
  readonly to: string;
  readonly venueClientOrderId: string | null;
  readonly limitPrice: Amount;
  readonly state: ConversionState;
  /** What the venue's fills took and gave, fees included where the venue charged them in that asset. Zero before a fill. */
  readonly paid: VenueAssetAmount;
  readonly received: VenueAssetAmount;
  readonly venueFee: VenueAssetAmount | null;
  readonly builderFee: VenueAssetAmount | null;
  readonly fills: number;
  /** The last fill's venue time, or `null` before one. */
  readonly filledAt: Date | null;
  readonly acceptedAt: Date;
  /**
   * A convert from a cash currency (#11) is one record of two linked legs: the partner's cash leg as svc-bank reads it
   * (`unread` when the partner could not be asked), then the venue order (null while it is not signed).
   */
  readonly cashLeg?: BankCashLeg | 'unread';
  readonly venueLeg?: { readonly state: ConversionState; readonly paid: VenueAssetAmount; readonly received: VenueAssetAmount } | null;
}

export interface VenueConvertDeps {
  readonly store: ConvertQuoteStore;
  readonly now: () => Date;
  /** The operator's Convert switch (TRADE_CONVERT_ENABLED). */
  readonly enabled: boolean;
  /** TRADE_CONVERT_ACCEPT_WINDOW_MS, or null when blank: every quote refuses `trade.convert_window_unset`. */
  readonly windowMs: number | null;
  /** TRADE_MARKET_SLIPPAGE_CAP_BPS, or null when blank: every quote refuses `trade.slippage_cap_unset`. */
  readonly slippageCapBps: number | null;
  /** The partner's cash leg through svc-bank (#11); absent, no cash currency is offered. */
  readonly cashLeg?: CashLegPort;
}

/** The edge-signed principal of the person's own request, passed on to svc-bank for the cash leg; empty, nothing is asked. */
export type Forwarded = Record<string, string>;
const NONE: Forwarded = {};

const KEY_RE = /^[A-Za-z0-9_-]{8,80}$/;
const LIMIT_PART = 'limit';

const refuse = (message: string, code: UserVenueDoorCode, status: number): never => {
  throw new UserVenueDoorError(message, code, status);
};
const bad = (message: string): never => refuse(message, 'trade.venue_request_invalid', 400);

/** The business key an accepted quote's one order is stored and placed under. */
export const convertKey = (owner: string, quoteId: string) => `${CONVERT_KEY_PREFIX}${owner}:${quoteId}`;
/** The business key of a quote's cash leg at the partner: one leg per accepted quote. */
export const cashLegKey = (owner: string, quoteId: string) => `convert-cash:${owner}:${quoteId}`;
/** The coin's smallest unit the partner pays in: 6 decimal places. */
const COIN_STEP = 10n ** 12n;
const limitConvertKey = (owner: string, limitKey: string) => `${CONVERT_KEY_PREFIX}${owner}:${LIMIT_PART}:${limitKey}`;

/** `{ quoteId }` for an instant conversion's key, `{ limitKey }` for a limit convert's, `null` for anything else. */
function partsOf(key: string): { owner: string; quoteId: string | null; limitKey: string | null } | null {
  if (!key.startsWith(CONVERT_KEY_PREFIX)) return null;
  const [owner = '', second = '', third, ...rest] = key.slice(CONVERT_KEY_PREFIX.length).split(':');
  if (rest.length > 0 || !owner) return null;
  if (third === undefined) return KEY_RE.test(second) ? { owner, quoteId: second, limitKey: null } : null;
  return second === LIMIT_PART && KEY_RE.test(third) ? { owner, quoteId: null, limitKey: third } : null;
}

function convertible(m: ListedVenueMarket): boolean {
  return (
    m.kind === 'spot' &&
    m.listing.routing === 'show' &&
    m.listing.open &&
    !m.listing.delisted &&
    (m.status === null || m.status === 'trading')
  );
}

const onGrid = (value: Amount, step: Amount) => step > 0n && value % step === 0n;

export class VenueConverts {
  constructor(
    private readonly deps: VenueConvertDeps,
    /** The person's own request, passed on to svc-bank for the cash leg (#11); empty, the partner is not asked. */
    private readonly forwarded: Forwarded = NONE,
  ) {}

  /** The same Convert, asking the partner's cash leg as the person whose request this is (#11). */
  forPerson(forwarded: Forwarded): VenueConverts {
    return new VenueConverts(this.deps, forwarded);
  }

  /** What can be converted now: the pairs, their coins, the coins never offered, and whether Convert is paused. */
  async pairs(door: UserVenueDoor): Promise<VenueConvertPairs> {
    const venue = await door.venue();
    const listed = (await door.markets()).value;
    const open = listed.filter(convertible);
    const pairs = open
      .map((m) => ({
        symbol: m.symbol,
        base: m.baseAsset,
        quote: m.quoteAsset,
        maxPerConvert: m.listing.maxOrderNotional ?? m.maxOrderNotional ?? null,
        minOrderNotional: m.minOrderNotional ?? null,
        lotSize: m.lotSize,
        tickSize: m.tickSize,
      }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
    const assets = new Set(pairs.flatMap((p) => [p.base, p.quote]));
    const restricted = new Set(listed.filter((m) => m.kind === 'spot' && !convertible(m)).flatMap((m) => [m.baseAsset, m.quoteAsset]));
    // A cash currency is offered only where the partner offers its cash leg into a coin Convert can spend.
    const read = await (this.deps.cashLeg ?? NO_CASH_LEG).offers(this.forwarded);
    const cash = read.offers.filter((o) => isCashCurrency(o.cash) && pairs.some((p) => p.quote === o.coin));
    return {
      cash,
      cashReason: cash.length ? null : read.reason || 'no partner offers a cash leg here',
      venueId: venue.venue.id,
      test: venue.venue.proofLevel !== 'live',
      pairs,
      assets: [...assets].sort(),
      restricted: [...restricted].filter((a) => !assets.has(a)).sort(),
      paused: !this.deps.enabled,
    };
  }

  /**
   * How `from` converts to `to` (#11): the one venue market joining them, bought or sold. A cash currency needs a partner
   * for its cash leg, and none is set: `trade.convert_cash_not_offered`, never one leg priced alone.
   */
  async route(
    door: UserVenueDoor,
    from: string,
    to: string,
  ): Promise<{ market: ListedVenueMarket; side: ConvertSide; cash: CashLegOffer | null }> {
    if (typeof from !== 'string' || typeof to !== 'string' || !from.trim() || !to.trim() || from === to)
      bad('from and to are two different assets');
    const open = (await door.markets()).value.filter(convertible);
    const buy = open.find((m) => m.baseAsset === to && m.quoteAsset === from);
    if (buy) return { market: buy, side: 'buy', cash: null };
    const sell = open.find((m) => m.baseAsset === from && m.quoteAsset === to);
    if (sell) return { market: sell, side: 'sell', cash: null };
    if (isCashCurrency(from) && !isCashCurrency(to)) {
      // Two linked legs: the partner's cash for a coin, then that coin for `to` on the venue (#11).
      const read = await (this.deps.cashLeg ?? NO_CASH_LEG).offers(this.forwarded);
      for (const offer of read.offers.filter((o) => o.cash === from)) {
        const second = open.find((m) => m.baseAsset === to && m.quoteAsset === offer.coin);
        if (second) return { market: second, side: 'buy', cash: offer };
      }
      refuse(
        `${from} to ${to} needs a cash leg through a partner, and no partner offers one here (${read.reason || `none gives ${from} for a coin that buys ${to}`}); nothing was priced`,
        'trade.convert_cash_not_offered',
        422,
      );
    }
    if (isCashCurrency(from) || isCashCurrency(to))
      refuse(
        `${from} to ${to} needs a cash leg through a partner, and no partner offers one here: the partner converts cash to coins only; nothing was priced`,
        'trade.convert_cash_not_offered',
        422,
      );
    return refuse(`no market converts ${from} to ${to}; nothing was priced`, 'trade.convert_pair_unlisted', 422);
  }

  /** A price for converting `amount` of `from` to `to` on the person's own venue account. Holds nothing and sends nothing. */
  async quote(door: UserVenueDoor, principal: Principal, ask: ConvertAsk): Promise<ConvertQuote> {
    this.assertOpen();
    const windowMs = this.deps.windowMs;
    if (windowMs === null || !Number.isInteger(windowMs) || windowMs < 1)
      return refuse('the window a convert price may be accepted in is not set (owner value blank)', 'trade.convert_window_unset', 503);
    if (typeof ask.quoteKey !== 'string' || !KEY_RE.test(ask.quoteKey))
      bad('quoteKey must be 8 to 80 letters, digits, "_" or "-", made once per ask and reused on a retry');
    if (typeof ask.amount !== 'bigint' || ask.amount <= 0n) bad('amount must be a positive decimal string');
    const owner = (await door.account(ask.owner)).owner;
    const had = await this.deps.store.get(principal.userId, ask.quoteKey);
    if (had) return same(had, owner, ask);

    const { market, side, cash } = await this.route(door, ask.from, ask.to);
    // On a cash convert the venue order spends the coin the partner pays for the typed cash, never more.
    const coinSpend = cash ? (mul(ask.amount, cash.rate, 'floor') / COIN_STEP) * COIN_STEP : null;
    if (cash && cash.available !== null && cash.available < ask.amount)
      refuse(
        `not enough ${cash.cash}: the partner holds ${formatAmount(cash.available)} ${cash.cash} for you; nothing was priced`,
        'trade.convert_cash_not_enough',
        422,
      );
    const cap = requireMarketSlippageCapBps(this.deps.slippageCapBps);
    const venue = await door.venue();
    const best = venue.bestPrices ? await venue.bestPrices(market.symbol) : null;
    const reference = best ? (side === 'buy' ? best.value.ask : best.value.bid) : null;
    const limitPrice = best ? marketProtectionBound(side, best.value, cap, market.tickSize) : null;
    if (!best || reference === null || limitPrice === null)
      return refuse(
        `the venue has no ${side === 'buy' ? 'ask' : 'bid'} on ${market.symbol} to price this conversion; nothing was priced`,
        'trade.convert_no_price',
        422,
      );
    const size = this.sizeOf({ side, amount: coinSpend ?? ask.amount, price: limitPrice, market });
    const intent = orderOf({
      symbol: market.symbol,
      side,
      amount: size,
      price: limitPrice,
      timeInForce: 'IOC',
      clientOrderKey: convertKey(owner, ask.quoteKey),
    });
    const preview = await door.preview(principal, owner, intent);
    let builderFee: ConvertBuilderFee = { kind: 'none', reason: 'buy' };
    if (side === 'sell') {
      const published = await door.builderFeeFor(market.symbol, 'sell', 'spot');
      // A spot sell always carries ours; a blank one was refused by the preview above, and is refused here again by name.
      if (!published?.carries)
        throw new VenueRefusalError({
          venueId: venue.venue.id,
          code: 'builder_fee_not_published',
          detail: 'our builder fee is not published (owner value blank), so no sell is priced',
        });
      const discount = preview.value.feeDiscount;
      builderFee = {
        kind: 'quote_asset',
        bps: discount ? discountedBuilderFee(published.feeBps, discount.bps) : published.feeBps,
        amount: preview.value.builderFee.known ? { known: true, value: preview.value.builderFee.value.amount } : { known: false },
      };
    }
    const now = this.deps.now();
    const stored = await this.deps.store.insert({
      quoteId: ask.quoteKey,
      userId: principal.userId,
      venueId: venue.venue.id,
      test: venue.venue.proofLevel !== 'live',
      owner,
      market: market.symbol,
      side,
      from: ask.from,
      to: ask.to,
      spend: ask.amount,
      size,
      bestPrice: { price: reference, asOf: best.asOf },
      limitPrice,
      slippageBps: cap,
      builderFee,
      venueFee: preview.value.venueFee,
      fill: preview.value.fill,
      freshUntil: new Date(now.getTime() + windowMs),
      createdAt: now,
      cashLeg:
        cash && coinSpend !== null
          ? { asset: cash.cash, coin: cash.coin, rate: cash.rate, coinSpend, label: cash.label, test: cash.test, acceptedAt: null }
          : null,
    });
    return same(stored, owner, ask);
  }

  /**
   * Accept a quote: its one venue order, prepared for the owner's wallet to sign under `convert:<owner>:<quoteId>`. The
   * same quote accepted again is that same action. Past the window, an action not yet signed is refused and nothing is
   * prepared; one already signed is the conversion it was, and is answered as it stands.
   */
  async accept(
    door: UserVenueDoor,
    principal: Principal,
    ask: { owner: string; quoteId: string },
  ): Promise<PreparedAnswer & { cashLeg?: BankCashLeg }> {
    this.assertOpen();
    const q = await this.quoteOf(principal, ask.quoteId);
    const owner = (await door.account(ask.owner)).owner;
    if (owner !== q.owner) refuse('no such quote for this venue account', 'trade.convert_quote_unknown', 404);
    const key = convertKey(q.owner, q.quoteId);
    const stored = await door.stored(principal, key);
    if (!stored?.signature) this.assertFresh(q);
    if (q.cashLeg) {
      const cashLeg = await this.carryCash(door, principal, { q, leg: q.cashLeg });
      const prepared = await door.prepare(
        principal,
        {
          owner,
          signer: { role: 'owner', address: owner },
          intent: orderOf({ symbol: q.market, side: q.side, amount: q.size, price: q.limitPrice, timeInForce: 'IOC', clientOrderKey: key }),
        },
        { convert: true },
      );
      return { ...prepared, cashLeg };
    }
    return door.prepare(
      principal,
      {
        owner,
        signer: { role: 'owner', address: owner },
        intent: orderOf({ symbol: q.market, side: q.side, amount: q.size, price: q.limitPrice, timeInForce: 'IOC', clientOrderKey: key }),
      },
      { convert: true },
    );
  }

  /** A limit convert: one venue order resting at the target rate, under `convert:<owner>:limit:<limitKey>`. */
  async limit(door: UserVenueDoor, principal: Principal, ask: LimitConvertAsk): Promise<PreparedAnswer> {
    this.assertOpen();
    if (typeof ask.limitKey !== 'string' || !KEY_RE.test(ask.limitKey))
      bad('limitKey must be 8 to 80 letters, digits, "_" or "-", made once per limit convert and reused on a retry');
    if (typeof ask.amount !== 'bigint' || ask.amount <= 0n) bad('amount must be a positive decimal string');
    if (typeof ask.price !== 'bigint' || ask.price <= 0n) bad('price must be the positive target rate as a decimal string');
    const owner = (await door.account(ask.owner)).owner;
    const { market, side, cash } = await this.route(door, ask.from, ask.to);
    if (cash)
      refuse(
        'a limit convert from cash is not offered: convert now, or set a target rate on the coin',
        'trade.convert_cash_not_offered',
        422,
      );
    if (!onGrid(ask.price, market.tickSize))
      refuse(
        `the target rate must be a multiple of ${formatAmount(market.tickSize)} ${market.quoteAsset}`,
        'trade.convert_price_not_on_tick',
        422,
      );
    const size = this.sizeOf({ side, amount: ask.amount, price: ask.price, market });
    return door.prepare(
      principal,
      {
        owner,
        signer: { role: 'owner', address: owner },
        intent: orderOf({
          symbol: market.symbol,
          side,
          amount: size,
          price: ask.price,
          timeInForce: 'GTC',
          clientOrderKey: limitConvertKey(owner, ask.limitKey),
        }),
      },
      { convert: true },
    );
  }

  /** Send a conversion's prepared order with the wallet's signature. A quote past its window is never signed here. */
  async submit(
    door: UserVenueDoor,
    principal: Principal,
    { actionKey, signature }: { actionKey: string; signature: VenueSignature | undefined },
  ): Promise<SubmitAnswer> {
    const key = (actionKey ?? '').trim();
    if (!signature) return bad('signature is required: the wallet signs the prepared order');
    const parts = partsOf(key);
    if (!parts) return bad('actionKey must be the key a convert accept or limit convert answered');
    const row = await door.stored(principal, key);
    if (row && !row.signature) {
      this.assertOpen();
      if (parts.quoteId) this.assertFresh(await this.quoteOf(principal, parts.quoteId));
    }
    return door.submit(principal, key, signature, { convert: true });
  }

  /**
   * The person's accepted conversions on one venue account, newest first, as the venue records them: each order's state,
   * what its fills took and gave, and when. Quotes never accepted are not listed: only signed actions are.
   */
  async history(door: UserVenueDoor, principal: Principal, owner: string): Promise<{ conversions: Conversion[]; asOf: Date | null }> {
    const account = await door.account(owner);
    const rows = (await door.storedByPrefix(principal, `${CONVERT_KEY_PREFIX}${account.owner}:`)).filter(
      (r) => r.signature !== null && r.prepared.intent.kind === 'place_order' && partsOf(r.businessKey) !== null,
    );
    // A cash convert (#11) is listed once its cash leg was accepted, signed venue order or not: one record, two legs.
    const linked = new Map((await this.deps.store.cashAccepted(principal.userId, account.owner)).map((q) => [q.quoteId, q]));
    if (rows.length === 0 && linked.size === 0) return { conversions: [], asOf: null };
    const venue = await door.venue();
    const since = new Date(
      Math.min(...rows.map((r) => r.createdAt.getTime()), ...[...linked.values()].map((q) => q.createdAt.getTime())) - 60_000,
    );
    const [fills, markets] = await Promise.all([venue.fills(account, since), venue.markets(null)]);
    const bySymbol = new Map(markets.value.map((m) => [m.symbol, m]));
    const conversions: Conversion[] = [];
    for (const row of rows) {
      const intent = row.prepared.intent;
      const parts = partsOf(row.businessKey);
      if (intent.kind !== 'place_order' || !parts) continue;
      const market = bySymbol.get(intent.symbol);
      if (!market) continue;
      const cloid = row.prepared.venueClientOrderId;
      const order = cloid ? (await venue.orderByClientId(account, cloid)).value : null;
      const mine = fills.value.filter((f) => cloid !== null && f.venueClientOrderId === cloid);
      const venueLeg = conversionOf({
        row,
        parts,
        intent,
        base: market.baseAsset,
        quote: market.quoteAsset,
        status: order?.status ?? null,
        fills: mine,
      });
      const q = parts.quoteId ? linked.get(parts.quoteId) : undefined;
      if (q) {
        linked.delete(q.quoteId);
        conversions.push(await this.linkedOf(q, venueLeg));
      } else conversions.push(venueLeg);
    }
    for (const q of linked.values()) conversions.push(await this.linkedOf(q, null));
    conversions.sort((a, b) => b.acceptedAt.getTime() - a.acceptedAt.getTime());
    return { conversions, asOf: fills.asOf };
  }

  /**
   * The quote's cash leg at the partner, under `convert-cash:<owner>:<quoteId>`: asked again it is the same leg, made once.
   * Noted as accepted before the partner is asked, so the conversion is listed even when its answer is lost. A partner
   * refusal moved nothing and is passed on by name; no answer is `trade.convert_cash_leg_unknown`, and Check again (the
   * same accept) asks under the same key.
   */
  private async carryCash(
    door: UserVenueDoor,
    principal: Principal,
    { q, leg }: { q: ConvertQuote; leg: ConvertCashLeg },
  ): Promise<BankCashLeg> {
    const venue = await door.venue();
    await this.deps.store.markCashAccepted(principal.userId, q.quoteId, this.deps.now());
    const answer = await (this.deps.cashLeg ?? NO_CASH_LEG).carry(this.forwarded, {
      legKey: cashLegKey(q.owner, q.quoteId),
      cash: leg.asset,
      coin: leg.coin,
      spend: formatAmount(q.spend),
      least: formatAmount(leg.coinSpend),
      venue: { venueId: venue.venue.id, owner: q.owner },
    });
    if (answer.state === 'carried') return answer.leg;
    if (answer.state === 'refused')
      return refuse(
        `the partner refused the cash leg (${answer.code}): ${answer.message || 'nothing was moved'}`,
        answer.code === 'bank.partner_insufficient_funds' ? 'trade.convert_cash_not_enough' : 'trade.convert_cash_leg_refused',
        422,
      );
    return refuse(
      'the partner did not answer for the cash leg; Check again asks under the same key, so it is made once',
      'trade.convert_cash_leg_unknown',
      503,
    );
  }

  /** One cash convert as one record: the partner's cash leg as svc-bank reads it, then its venue order, when signed. */
  private async linkedOf(q: ConvertQuote, venueLeg: Conversion | null): Promise<Conversion> {
    const leg = q.cashLeg;
    if (!leg) return venueLeg ?? refuse('a cash conversion lost its cash leg', 'trade.convert_quote_unknown', 404);
    const read = await (this.deps.cashLeg ?? NO_CASH_LEG).leg(this.forwarded, cashLegKey(q.owner, q.quoteId));
    const cashLeg: BankCashLeg | 'unread' = read === null || read === 'unread' ? 'unread' : read;
    return {
      actionKey: venueLeg?.actionKey ?? convertKey(q.owner, q.quoteId),
      kind: 'instant',
      quoteId: q.quoteId,
      market: q.market,
      side: q.side,
      from: leg.asset,
      to: q.to,
      venueClientOrderId: venueLeg?.venueClientOrderId ?? null,
      limitPrice: q.limitPrice,
      state: venueLeg?.state ?? 'not_filled',
      paid: { asset: leg.asset, amount: cashLeg === 'unread' ? 0n : parseAmount(cashLeg.paid) },
      received: venueLeg?.received ?? { asset: q.to, amount: 0n },
      venueFee: venueLeg?.venueFee ?? null,
      builderFee: venueLeg?.builderFee ?? null,
      fills: venueLeg?.fills ?? 0,
      filledAt: venueLeg?.filledAt ?? null,
      acceptedAt: leg.acceptedAt ?? q.createdAt,
      cashLeg,
      venueLeg: venueLeg ? { state: venueLeg.state, paid: venueLeg.paid, received: venueLeg.received } : null,
    };
  }

  private assertOpen(): void {
    if (!this.deps.enabled)
      refuse('Convert is paused on this platform; nothing was priced or sent. Spot is open', 'trade.convert_disabled', 409);
  }

  private assertFresh(q: ConvertQuote): void {
    if (this.deps.now().getTime() > q.freshUntil.getTime())
      refuse(
        `this price was fresh until ${q.freshUntil.toISOString()}; get a new price. Nothing was signed or sent`,
        'trade.convert_quote_expired',
        409,
      );
  }

  private async quoteOf(principal: Principal, quoteId: string): Promise<ConvertQuote> {
    if (typeof quoteId !== 'string' || !KEY_RE.test(quoteId)) bad('quoteId is the quoteKey the quote was asked with');
    const q = await this.deps.store.get(principal.userId, quoteId);
    if (!q) return refuse('no such quote', 'trade.convert_quote_unknown', 404);
    return q;
  }

  /**
   * The order's size in the base asset: on a buy the most whole lots `amount` (the quote asset) pays for at `price`, so
   * the order never costs more than typed; on a sell the typed coins, which must be whole lots. Too small for the venue's
   * smallest order value refuses before anything is asked of the venue.
   */
  private sizeOf({ side, amount, price, market }: { side: ConvertSide; amount: Amount; price: Amount; market: ListedVenueMarket }): Amount {
    const lot = market.lotSize;
    let size = amount;
    if (side === 'buy') {
      const most = div(amount, price, 'floor');
      size = lot > 0n ? (most / lot) * lot : most;
    } else if (!onGrid(amount, lot)) {
      refuse(`sell in steps of ${formatAmount(lot)} ${market.baseAsset}`, 'trade.convert_amount_not_on_lot', 422);
    }
    const min = market.minOrderNotional ?? null;
    if (size <= 0n || (min !== null && mul(size, price, 'ceil') < min))
      refuse(
        `too small: the venue's smallest order on ${market.symbol} is ${min === null ? 'one lot' : `${formatAmount(min)} ${market.quoteAsset}`}`,
        'trade.convert_amount_too_small',
        422,
      );
    return size;
  }
}

function orderOf({
  symbol,
  side,
  amount,
  price,
  timeInForce,
  clientOrderKey,
}: {
  symbol: string;
  side: ConvertSide;
  amount: Amount;
  price: Amount;
  timeInForce: 'IOC' | 'GTC';
  clientOrderKey: string;
}): PlaceUserOrderIntent {
  return {
    kind: 'place_order',
    symbol,
    side,
    type: 'limit',
    amount,
    price,
    timeInForce,
    reduceOnly: false,
    clientOrderKey,
    builderFee: null,
  };
}

/** The quote stored under a key answers only the ask it was made for. */
function same(q: ConvertQuote, owner: string, ask: ConvertAsk): ConvertQuote {
  if (q.owner !== owner || q.from !== ask.from || q.to !== ask.to || q.spend !== ask.amount)
    refuse('this quoteKey already priced a different conversion: make a new key for a new ask', 'trade.convert_quote_key_reused', 409);
  return q;
}

function conversionOf({
  row,
  parts,
  intent,
  base,
  quote,
  status,
  fills,
}: {
  row: StoredVenueAction;
  parts: NonNullable<ReturnType<typeof partsOf>>;
  intent: PlaceUserOrderIntent;
  base: string;
  quote: string;
  status: string | null;
  fills: readonly UserVenueFill[];
}): Conversion {
  let baseAmount = 0n;
  let quoteAmount = 0n;
  let venueFee = 0n;
  let builderFee = 0n;
  let feesInBase = 0n;
  let feesInQuote = 0n;
  let filledAt: Date | null = null;
  let feeAsset: string | null = null;
  for (const f of fills) {
    baseAmount = add(baseAmount, f.amount);
    quoteAmount = add(quoteAmount, mul(f.price, f.amount));
    venueFee = add(venueFee, f.venueFee);
    builderFee = add(builderFee, f.builderFee);
    const fee = add(f.venueFee, f.builderFee);
    if (f.feeAsset === base) feesInBase = add(feesInBase, fee);
    else if (f.feeAsset === quote) feesInQuote = add(feesInQuote, fee);
    feeAsset = f.feeAsset;
    if (!filledAt || f.filledAt.getTime() > filledAt.getTime()) filledAt = f.filledAt;
  }
  const buy = intent.side === 'buy';
  const paid = buy ? { asset: quote, amount: add(quoteAmount, feesInQuote) } : { asset: base, amount: add(baseAmount, feesInBase) };
  const received = buy ? { asset: base, amount: sub(baseAmount, feesInBase) } : { asset: quote, amount: sub(quoteAmount, feesInQuote) };
  const recorded = row.lastOutcome;
  const state: ConversionState =
    status === 'filled'
      ? 'filled'
      : status === 'partially_filled'
        ? 'partially_filled'
        : status === 'open'
          ? 'resting'
          : status === 'canceled' || status === 'expired'
            ? baseAmount > 0n
              ? 'partially_filled'
              : 'not_filled'
            : status === 'rejected' || (recorded?.definite && !recorded.accepted)
              ? 'rejected'
              : 'unknown';
  return {
    actionKey: row.businessKey,
    kind: parts.limitKey ? 'limit' : 'instant',
    quoteId: parts.quoteId,
    market: intent.symbol,
    side: intent.side,
    from: buy ? quote : base,
    to: buy ? base : quote,
    venueClientOrderId: row.prepared.venueClientOrderId,
    limitPrice: intent.price,
    state,
    paid,
    received,
    venueFee: feeAsset ? { asset: feeAsset, amount: venueFee } : null,
    builderFee: feeAsset ? { asset: feeAsset, amount: builderFee } : null,
    fills: fills.length,
    filledAt,
    acceptedAt: row.createdAt,
  };
}

const assetAmount = (v: VenueAssetAmount) => ({ asset: v.asset, amount: formatAmount(v.amount) });

/** A quote as the room and the API read it: every amount a decimal string, a figure the venue does not give `known: false`. */
export function presentConvertQuote(q: ConvertQuote) {
  return {
    quoteId: q.quoteId,
    venueId: q.venueId,
    test: q.test,
    owner: q.owner,
    market: q.market,
    side: q.side,
    from: q.from,
    to: q.to,
    spend: formatAmount(q.spend),
    size: formatAmount(q.size),
    /** What the order can cost at most: its size at its limit price, never more than `spend` on a buy. */
    maxCost: q.side === 'buy' ? formatAmount(mul(q.size, q.limitPrice, 'ceil')) : formatAmount(q.size),
    bestPrice: { price: formatAmount(q.bestPrice.price), asOf: q.bestPrice.asOf.toISOString() },
    limitPrice: formatAmount(q.limitPrice),
    slippageBps: q.slippageBps,
    builderFee:
      q.builderFee.kind === 'none'
        ? q.builderFee
        : {
            kind: q.builderFee.kind,
            bps: formatAmount(q.builderFee.bps),
            amount: q.builderFee.amount.known
              ? { known: true as const, value: formatAmount(q.builderFee.amount.value) }
              : { known: false as const },
          },
    venueFee: q.venueFee.known
      ? { known: true as const, asset: q.venueFee.value.asset, amount: formatAmount(q.venueFee.value.amount) }
      : { known: false as const },
    fill: q.fill.known
      ? {
          known: true as const,
          amount: formatAmount(q.fill.value.amount),
          averagePrice: q.fill.value.averagePrice === null ? null : formatAmount(q.fill.value.averagePrice),
        }
      : { known: false as const },
    /** The venue holds no price and nothing is locked: `freshUntil` is only how long this one may be accepted. */
    held: false as const,
    freshUntil: q.freshUntil.toISOString(),
    createdAt: q.createdAt.toISOString(),
    /** A cash convert's first leg (#11): the partner's cash for `coin`, which the venue order then spends. */
    cashLeg: q.cashLeg
      ? {
          cash: q.cashLeg.asset,
          coin: q.cashLeg.coin,
          rate: formatAmount(q.cashLeg.rate),
          coinSpend: formatAmount(q.cashLeg.coinSpend),
          label: q.cashLeg.label,
          test: q.cashLeg.test,
        }
      : null,
  };
}

export function presentConversion(c: Conversion) {
  return {
    actionKey: c.actionKey,
    kind: c.kind,
    quoteId: c.quoteId,
    market: c.market,
    side: c.side,
    from: c.from,
    to: c.to,
    venueClientOrderId: c.venueClientOrderId,
    limitPrice: formatAmount(c.limitPrice),
    state: c.state,
    paid: assetAmount(c.paid),
    received: assetAmount(c.received),
    venueFee: c.venueFee ? assetAmount(c.venueFee) : null,
    builderFee: c.builderFee ? assetAmount(c.builderFee) : null,
    fills: c.fills,
    filledAt: c.filledAt?.toISOString() ?? null,
    acceptedAt: c.acceptedAt.toISOString(),
    ...(c.cashLeg === undefined
      ? {}
      : {
          legs: {
            cash: c.cashLeg === 'unread' ? { unread: true as const } : c.cashLeg,
            venue: c.venueLeg
              ? { state: c.venueLeg.state, paid: assetAmount(c.venueLeg.paid), received: assetAmount(c.venueLeg.received) }
              : null,
          },
        }),
  };
}

export function presentPairs(p: VenueConvertPairs) {
  return {
    venueId: p.venueId,
    test: p.test,
    paused: p.paused,
    assets: p.assets,
    restricted: p.restricted,
    cash: p.cash.map((c) => ({
      asset: c.cash,
      via: c.coin,
      rate: formatAmount(c.rate),
      available: c.available === null ? null : formatAmount(c.available),
      label: c.label,
      test: c.test,
    })),
    cashReason: p.cashReason,
    pairs: p.pairs.map((x) => ({
      symbol: x.symbol,
      base: x.base,
      quote: x.quote,
      maxPerConvert: x.maxPerConvert === null ? null : { amount: formatAmount(x.maxPerConvert), asset: x.quote },
      minOrderNotional: x.minOrderNotional === null ? null : formatAmount(x.minOrderNotional),
      lotSize: formatAmount(x.lotSize),
      tickSize: formatAmount(x.tickSize),
    })),
  };
}
