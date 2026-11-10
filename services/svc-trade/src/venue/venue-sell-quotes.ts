/**
 * Convert's sell quotes on the customer's own venue account (J-cex-spot-17 #8, "a finance read of venue sell prices with
 * exact amounts"). We hold no customer money (OWNER 226), so a sell is priced by the venue, never by our own book: the
 * quote is the venue's own preview of a market sell of that size on the customer's account (`VenueOrderPreview.fill`,
 * B1's #7729), with the venue's fee, our builder fee and the venue's as-of time, stored exactly as the venue gave them.
 * A figure the venue does not give stays "not known" (`known: false`), never zero.
 *
 * A quote sends nothing to the venue and moves no money: the ledger posts nothing. It is stored under its business key
 * `venue-sell:<userId>:<quoteKey>` (AGENTS.md floor 3), so a retry of the same ask returns the quote first given, and
 * the same key with a different ask refuses `trade.venue_sell_quote_key_reused`.
 */
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import { type MaybeKnown, type PlaceUserOrderIntent, type VenueAssetAmount, type VenuePreviewFill } from '@intafaced/venue-contracts';
import { UserVenueDoorError, type UserVenueDoor } from './user-venue-door.js';

export interface VenueSellQuote {
  readonly quoteId: string;
  readonly userId: string;
  readonly venueId: string;
  /** The venue's proof level: anything but `live` is a TEST venue, and every figure from it is TEST. */
  readonly proofLevel: 'simulator' | 'partner-sandbox' | 'live';
  readonly owner: string;
  readonly symbol: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  /** What the customer asked to sell, in the base asset. */
  readonly amount: Amount;
  /** What would fill now on the venue's book, and its volume-weighted price (rounded down on a sell), as the venue says. */
  readonly fill: MaybeKnown<VenuePreviewFill>;
  readonly venueFee: MaybeKnown<VenueAssetAmount>;
  readonly builderFee: MaybeKnown<VenueAssetAmount>;
  /** The venue's own time for the preview. */
  readonly asOf: Date;
  readonly createdAt: Date;
}

export interface VenueSellQuoteStore {
  /** Stores `quote` unless its id is taken, and returns what is stored under the id. */
  insert(quote: VenueSellQuote): Promise<VenueSellQuote>;
  get(quoteId: string): Promise<VenueSellQuote | null>;
  /** Newest first. */
  latest(limit: number): Promise<VenueSellQuote[]>;
}

export class MemoryVenueSellQuoteStore implements VenueSellQuoteStore {
  private readonly rows = new Map<string, VenueSellQuote>();

  async insert(quote: VenueSellQuote): Promise<VenueSellQuote> {
    const had = this.rows.get(quote.quoteId);
    if (had) return had;
    this.rows.set(quote.quoteId, quote);
    return quote;
  }

  async get(quoteId: string): Promise<VenueSellQuote | null> {
    return this.rows.get(quoteId) ?? null;
  }

  async latest(limit: number): Promise<VenueSellQuote[]> {
    return [...this.rows.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.quoteId < b.quoteId ? 1 : -1))
      .slice(0, limit);
  }
}

interface Row {
  quote_id: string;
  user_id: string;
  venue_id: string;
  proof_level: VenueSellQuote['proofLevel'];
  owner: string;
  symbol: string;
  base_asset: string;
  quote_asset: string;
  amount: string;
  fill_known: boolean;
  fill_amount: string | null;
  fill_average_price: string | null;
  venue_fee_known: boolean;
  venue_fee_amount: string | null;
  venue_fee_asset: string | null;
  builder_fee_known: boolean;
  builder_fee_amount: string | null;
  builder_fee_asset: string | null;
  as_of: Date;
  created_at: Date;
}

const known = <T>(isKnown: boolean, value: () => T): MaybeKnown<T> => (isKnown ? { known: true, value: value() } : { known: false });
const assetAmount = (isKnown: boolean, amount: string | null, asset: string | null): MaybeKnown<VenueAssetAmount> =>
  known(isKnown && amount !== null && asset !== null, () => ({ asset: asset!, amount: parseAmount(amount!) }));

function fromRow(r: Row): VenueSellQuote {
  return {
    quoteId: r.quote_id,
    userId: r.user_id,
    venueId: r.venue_id,
    proofLevel: r.proof_level,
    owner: r.owner,
    symbol: r.symbol,
    baseAsset: r.base_asset,
    quoteAsset: r.quote_asset,
    amount: parseAmount(r.amount),
    fill: known(r.fill_known && r.fill_amount !== null, () => ({
      amount: parseAmount(r.fill_amount!),
      averagePrice: r.fill_average_price === null ? null : parseAmount(r.fill_average_price),
    })),
    venueFee: assetAmount(r.venue_fee_known, r.venue_fee_amount, r.venue_fee_asset),
    builderFee: assetAmount(r.builder_fee_known, r.builder_fee_amount, r.builder_fee_asset),
    asOf: r.as_of,
    createdAt: r.created_at,
  };
}

export class SqlVenueSellQuoteStore implements VenueSellQuoteStore {
  constructor(private readonly sql: Sql) {}

  async insert(q: VenueSellQuote): Promise<VenueSellQuote> {
    const fill = q.fill.known ? q.fill.value : null;
    const venueFee = q.venueFee.known ? q.venueFee.value : null;
    const builderFee = q.builderFee.known ? q.builderFee.value : null;
    await this.sql`
      INSERT INTO trade.venue_sell_quotes (
        quote_id, user_id, venue_id, proof_level, owner, symbol, base_asset, quote_asset, amount,
        fill_known, fill_amount, fill_average_price,
        venue_fee_known, venue_fee_amount, venue_fee_asset,
        builder_fee_known, builder_fee_amount, builder_fee_asset,
        as_of, created_at
      ) VALUES (
        ${q.quoteId}, ${q.userId}, ${q.venueId}, ${q.proofLevel}, ${q.owner}, ${q.symbol}, ${q.baseAsset}, ${q.quoteAsset},
        ${formatAmount(q.amount)},
        ${q.fill.known}, ${fill ? formatAmount(fill.amount) : null},
        ${fill && fill.averagePrice !== null ? formatAmount(fill.averagePrice) : null},
        ${q.venueFee.known}, ${venueFee ? formatAmount(venueFee.amount) : null}, ${venueFee ? venueFee.asset : null},
        ${q.builderFee.known}, ${builderFee ? formatAmount(builderFee.amount) : null}, ${builderFee ? builderFee.asset : null},
        ${q.asOf.toISOString()}, ${q.createdAt.toISOString()}
      )
      ON CONFLICT (quote_id) DO NOTHING`;
    const stored = await this.get(q.quoteId);
    if (!stored) throw new Error(`venue sell quote ${q.quoteId} was not stored`);
    return stored;
  }

  async get(quoteId: string): Promise<VenueSellQuote | null> {
    const rows = await this.sql<Row[]>`
      SELECT quote_id, user_id, venue_id, proof_level, owner, symbol, base_asset, quote_asset, amount::text,
             fill_known, fill_amount::text, fill_average_price::text,
             venue_fee_known, venue_fee_amount::text, venue_fee_asset,
             builder_fee_known, builder_fee_amount::text, builder_fee_asset, as_of, created_at
        FROM trade.venue_sell_quotes WHERE quote_id = ${quoteId}`;
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async latest(limit: number): Promise<VenueSellQuote[]> {
    const rows = await this.sql<Row[]>`
      SELECT quote_id, user_id, venue_id, proof_level, owner, symbol, base_asset, quote_asset, amount::text,
             fill_known, fill_amount::text, fill_average_price::text,
             venue_fee_known, venue_fee_amount::text, venue_fee_asset,
             builder_fee_known, builder_fee_amount::text, builder_fee_asset, as_of, created_at
        FROM trade.venue_sell_quotes ORDER BY created_at DESC, quote_id DESC LIMIT ${limit}`;
    return rows.map(fromRow);
  }
}

/** A quote key the caller makes once per ask (the screen's request id), reused on a retry. */
const QUOTE_KEY_RE = /^[A-Za-z0-9:_-]{8,80}$/;

export interface VenueSellQuoteAsk {
  readonly owner: string;
  readonly symbol: string;
  readonly amount: Amount;
  readonly quoteKey: string;
}

export interface VenueSellQuoteDeps {
  readonly door: UserVenueDoor;
  readonly store: VenueSellQuoteStore;
  readonly now: () => Date;
}

const bad = (message: string): never => {
  throw new UserVenueDoorError(message, 'trade.venue_request_invalid', 400);
};

export class VenueSellQuotes {
  constructor(private readonly deps: VenueSellQuoteDeps) {}

  /** The venue's price for selling `amount` on the customer's own venue account now, stored under its business key. */
  async quote(principal: Principal, ask: VenueSellQuoteAsk): Promise<VenueSellQuote> {
    if (typeof ask.quoteKey !== 'string' || !QUOTE_KEY_RE.test(ask.quoteKey))
      bad('quoteKey must be 8 to 80 letters, digits, ":", "_" or "-", made once per ask and reused on a retry');
    if (typeof ask.amount !== 'bigint' || ask.amount <= 0n) bad('amount must be a positive decimal string');
    if (typeof ask.symbol !== 'string' || !ask.symbol.trim()) bad('symbol is required');
    const quoteId = `venue-sell:${principal.userId}:${ask.quoteKey}`;
    const owner = (await this.deps.door.account(ask.owner)).owner;
    const had = await this.deps.store.get(quoteId);
    if (had) return this.same(had, owner, ask);

    const venue = await this.deps.door.venue();
    const market = (await venue.markets(null)).value.find((m) => m.symbol === ask.symbol);
    if (!market)
      throw new UserVenueDoorError(`${ask.symbol} is not a market of ${venue.venue.id}`, 'trade.venue_sell_quote_market_unknown', 422);
    if (market.kind !== 'spot')
      throw new UserVenueDoorError(`${ask.symbol} is not a spot market: Convert sells spot only`, 'trade.venue_sell_quote_not_spot', 422);
    // A market sell of the whole amount at the venue's depth now: its worst price is one tick, so the preview walks every
    // bid, and `fill` says how much of the amount the book takes and at what average price.
    const intent: PlaceUserOrderIntent = {
      kind: 'place_order',
      symbol: market.symbol,
      side: 'sell',
      type: 'market',
      amount: ask.amount,
      price: market.tickSize,
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: `convert-quote:${principal.userId}:${ask.quoteKey}`,
      builderFee: null,
    };
    const preview = await this.deps.door.preview(principal, owner, intent);
    const stored = await this.deps.store.insert({
      quoteId,
      userId: principal.userId,
      venueId: preview.venueId,
      proofLevel: venue.venue.proofLevel,
      owner,
      symbol: market.symbol,
      baseAsset: market.baseAsset,
      quoteAsset: market.quoteAsset,
      amount: ask.amount,
      fill: preview.value.fill,
      venueFee: preview.value.venueFee,
      builderFee: preview.value.builderFee,
      asOf: preview.asOf,
      createdAt: this.deps.now(),
    });
    return this.same(stored, owner, ask);
  }

  /** The quote stored under a key answers only the ask it was made for. */
  private same(q: VenueSellQuote, owner: string, ask: VenueSellQuoteAsk): VenueSellQuote {
    if (q.owner !== owner || q.symbol !== ask.symbol || q.amount !== ask.amount)
      throw new UserVenueDoorError(
        'this quoteKey already priced a different sell: make a new key for a new ask',
        'trade.venue_sell_quote_key_reused',
        409,
      );
    return q;
  }
}

/** A quote as the customer and finance read it: every amount a decimal string, an unknown figure `known: false`. */
export function presentVenueSellQuote(q: VenueSellQuote) {
  const amountOf = (v: MaybeKnown<VenueAssetAmount>) =>
    v.known ? { known: true as const, asset: v.value.asset, amount: formatAmount(v.value.amount) } : { known: false as const };
  return {
    quoteId: q.quoteId,
    userId: q.userId,
    venueId: q.venueId,
    test: q.proofLevel !== 'live',
    owner: q.owner,
    symbol: q.symbol,
    baseAsset: q.baseAsset,
    quoteAsset: q.quoteAsset,
    amount: formatAmount(q.amount),
    fill: q.fill.known
      ? {
          known: true as const,
          amount: formatAmount(q.fill.value.amount),
          averagePrice: q.fill.value.averagePrice === null ? null : formatAmount(q.fill.value.averagePrice),
        }
      : { known: false as const },
    venueFee: amountOf(q.venueFee),
    builderFee: amountOf(q.builderFee),
    asOf: q.asOf.toISOString(),
    createdAt: q.createdAt.toISOString(),
  };
}
