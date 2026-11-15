import { formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { TradeVenueAccountActivity, TradeVenueActivityResult } from '@intafaced/contracts';
import type { InflowLine } from './ledger-reads.js';
import type { LotBookVenue } from '@intafaced/contracts/tax-lot-book';
import { TAX_VENUE_OFF, TAX_VENUE_UNAVAILABLE, TAX_VENUE_UNWIRED } from './codes.js';
import { buildLotBook, PAR_ASSETS, type BookLot, type CarriedLot, type Fill, type Inflow, type LotBook } from './lot-book.js';
import type { OwnMove } from './own-moves.js';

/**
 * VENUE BOOK (J-cex-spot-01 #11). The person's own venue accounts in their profit and loss indicator: each account is a
 * book of its own, built by the same lot engine from the venue's own spot fills and checked against the venue's own
 * balances, then listed beside the ledger book. Nothing is stored: the fills and balances are read through svc-trade at
 * the moment of the read (`venue.ownActivity`), with the venue's as-of time. INTAFACED holds none of it, and the ledger
 * posts nothing for it.
 *
 * Each account stays apart: a venue sale draws only on that account's lots, and a ledger sale never draws on a venue lot.
 * Coins move between the venue and our ledger only through a wallet, which neither book follows. A coin the venue credited
 * from outside (a deposit or a transfer in, J-portfolio-02 #6) is a lot of its own when the venue's adapter reads those
 * credits (`arrivals`): it has no cost unless the owner's deposit policy gives one or the person enters one, never zero.
 * Without that read, a coin that arrived other than by a fill does not reconcile and its figures are unknown, named.
 *
 * MOVES TO THE PERSON'S OWN SUB-ACCOUNT (J-portfolio-04 #2). A move from a main account into one of its own sub-accounts,
 * signed by the person's wallet and settled by the venue (`transfers` on the main account), is not a sale: the main
 * account's book carries the lots the method in force would draw on next (lot-engine.ts OWN-ACCOUNT CARRY), and each part
 * arrives in the sub-account's book at the move as that lot, with its acquired date, source and share of basis. A move
 * back out of a sub-account is not followed yet: the coins it moved arrive on the main account other than by a fill, so
 * both accounts' figures for that coin are unknown, named, never guessed.
 */

/** `venue:<venueId>:<owner>`, and `:<subAccount>` for a venue sub-account: the key on its lots, sales and coins. */
export function venueAccountKey(a: { venueId: string; owner: string; subAccount: string | null }): string {
  return `venue:${a.venueId}:${a.owner}${a.subAccount === null ? '' : `:${a.subAccount}`}`;
}

/**
 * One venue spot fill as the two legs the lot book reads. A buy received the coin less any fee taken in it and paid the
 * fill's price times its amount (rounded up, as the venue settles it) plus any fee taken in the coin paid; a sale the
 * other way round.
 */
export function venueFillToFill(account: string, f: TradeVenueAccountActivity['fills'][number]): Fill {
  const amount = parseAmount(f.amount);
  const notional = mul(parseAmount(f.price), amount, 'ceil');
  const fee = parseAmount(f.fee);
  const [got, gave] = f.side === 'buy' ? [f.base, f.quote] : [f.quote, f.base];
  const [gotQty, gaveQty] = f.side === 'buy' ? [amount, notional] : [notional, amount];
  const inGot = f.feeAsset === got;
  const inGave = f.feeAsset === gave;
  return {
    txId: `${account}:${f.fillId}`,
    postedAt: new Date(f.filledAt),
    received: { assetId: got, amount: inGot ? gotQty - fee : gotQty },
    paid: { assetId: gave, amount: inGave ? gaveQty + fee : gaveQty },
    // A fee in a third coin is not inside either leg: it is not known what it cost in this pair, so it is unknown.
    fee: inGot || inGave ? fee : null,
    ...(inGot ? {} : { feeAssetId: f.feeAsset }),
  };
}

/** The reason a venue credit carries into the lot book: a deposit is `deposit.*`, a transfer in this (inflowSource). */
export const VENUE_TRANSFER_IN = 'venue.transfer_in';

/** One venue account's credits from outside, as arrivals the lot book values and turns into lots (none: no `arrivals`). */
export function venueArrivalLines(activity: TradeVenueAccountActivity): InflowLine[] {
  const account = venueAccountKey(activity);
  return (activity.arrivals ?? []).map((a) => ({
    txId: `${account}:arrival:${a.arrivalId}`,
    postedAt: new Date(a.arrivedAt),
    assetId: a.asset,
    amount: parseAmount(a.amount),
    reason: a.kind === 'deposit' ? 'deposit.venue' : VENUE_TRANSFER_IN,
  }));
}

/** What a venue account's book takes besides its activity: its valued arrivals by account key, and customer prices. */
export interface VenueExtras {
  readonly inflows?: ReadonlyMap<string, readonly Inflow[]>;
  readonly overridePricePerUnit?: ReadonlyMap<string, Amount>;
}

type BookShared = Pick<Parameters<typeof buildLotBook>[0], 'method' | 'rules' | 'preview' | 'choices' | 'includeTransfers' | 'now'>;

/** The moves into a sub-account a main account's activity lists, as moves to the sub-account's key (the lots go along). */
export function venueOwnMoves(activity: TradeVenueAccountActivity): OwnMove[] {
  const account = venueAccountKey(activity);
  return (activity.transfers ?? [])
    .filter((t) => t.direction === 'into_sub_account')
    .map((t) => ({
      txId: `${account}:move:${t.moveId}`,
      postedAt: new Date(t.settledAt),
      assetId: t.asset,
      amount: parseAmount(t.amount),
      from: null,
      to: venueAccountKey({ venueId: activity.venueId, owner: activity.owner, subAccount: t.subAccount }),
    }));
}

/**
 * A lot the main account's book put in a sub-account, as the sub-account's book takes it in: a part carried from a lot,
 * or a part no open lot covered (no basis), which arrived at `move`.
 */
function carriedLotOf(lot: BookLot, move: OwnMove): CarriedLot {
  const from = lot.carriedFrom;
  return {
    lotId: lot.id,
    assetId: lot.assetId,
    acquiredAt: new Date(lot.acquiredAt),
    source: lot.source,
    reason: 'moved to your venue sub-account',
    qty: parseAmount(lot.qty),
    costUsd: lot.costUsd === null ? null : parseAmount(lot.costUsd),
    valuedAt:
      lot.valuedAt === null
        ? null
        : {
            usd: parseAmount(lot.valuedAt.usd),
            price: parseAmount(lot.valuedAt.price),
            market: lot.valuedAt.market,
            timeframe: lot.valuedAt.timeframe,
            candleAt: lot.valuedAt.candleAt === null ? null : new Date(lot.valuedAt.candleAt),
          },
    txId: move.txId,
    movedAt: move.postedAt,
    ...(from === undefined ? {} : { from: { lotId: from.lotId, txId: from.txId, movedAt: new Date(from.movedAt) } }),
    ...(lot.basisSource === 'customer-entered' ? { customerEntered: true } : {}),
    ...(lot.basisLotId === undefined ? {} : { priceLotId: lot.basisLotId }),
  };
}

/**
 * One venue account's book, every lot, sale and coin keyed by the account. `carriedIn`: the lots a move from its main
 * account brought (a sub-account). The lots this account's own moves carried to a sub-account are that sub-account's,
 * returned as `carriedOut` by the sub-account's key and never listed here.
 */
function venueAccountBook(
  activity: TradeVenueAccountActivity,
  shared: BookShared,
  carriedIn: readonly CarriedLot[],
  extras: VenueExtras = {},
): { book: LotBook; carriedOut: Map<string, CarriedLot[]> } {
  const account = venueAccountKey(activity);
  const held = new Map<string, Amount>();
  for (const b of activity.balances) {
    const total = parseAmount(b.total);
    if (total > 0n) held.set(b.asset, (held.get(b.asset) ?? 0n) + total);
  }
  const moves = venueOwnMoves(activity);
  const book = buildLotBook({
    ...shared,
    fills: activity.fills.map((f) => venueFillToFill(account, f)),
    held,
    truncated: false,
    moves,
    carriedIn,
    // Read arrivals (even none) make the account's book follow its credits from outside, each a lot of its own.
    ...(activity.arrivals === undefined ? {} : { inflows: extras.inflows?.get(account) ?? [] }),
    ...(extras.overridePricePerUnit ? { overridePricePerUnit: extras.overridePricePerUnit } : {}),
  });
  const carriedOut = new Map<string, CarriedLot[]>();
  for (const lot of book.lots) {
    if (lot.spaceId === undefined) continue;
    // The move that put it there: the one it was carried by, else the one at its arrival (a part no lot covered).
    const move =
      moves.find((m) => m.txId === lot.carriedFrom?.txId) ??
      moves.find((m) => m.to === lot.spaceId && m.postedAt.toISOString() === lot.acquiredAt && m.assetId === lot.assetId);
    if (move === undefined) continue;
    carriedOut.set(lot.spaceId, [...(carriedOut.get(lot.spaceId) ?? []), carriedLotOf(lot, move)]);
  }
  return {
    carriedOut,
    book: {
      ...book,
      lots: book.lots.filter((lot) => lot.spaceId === undefined).map((lot) => ({ ...lot, venueAccount: account })),
      sales: book.sales.map((sale) => ({ ...sale, venueAccount: account })),
      assets: book.assets
        // A dollar coin is not a position: the ledger book does not list one it holds, nor does a venue account.
        .filter((a) => !PAR_ASSETS.has(a.assetId.toUpperCase()))
        .map((a) => ({ ...a, venueAccount: account })),
    },
  };
}

/** One venue account's book on its own (with no lots carried in). */
export function buildVenueAccountBook(activity: TradeVenueAccountActivity, shared: BookShared, extras: VenueExtras = {}): LotBook {
  return venueAccountBook(activity, shared, [], extras).book;
}

/**
 * Every venue account's book, in the order the accounts came. Each main account's book is built first, so the lots its
 * moves carried to one of its sub-accounts arrive in that sub-account's book.
 */
export function venueBooks(accounts: readonly TradeVenueAccountActivity[], shared: BookShared, extras: VenueExtras = {}): LotBook[] {
  const built = new Map<string, LotBook>();
  const carried = new Map<string, CarriedLot[]>();
  for (const a of accounts.filter((x) => x.subAccount === null)) {
    const { book, carriedOut } = venueAccountBook(a, shared, [], extras);
    built.set(venueAccountKey(a), book);
    for (const [to, lots] of carriedOut) carried.set(to, [...(carried.get(to) ?? []), ...lots]);
  }
  for (const a of accounts.filter((x) => x.subAccount !== null)) {
    built.set(venueAccountKey(a), venueAccountBook(a, shared, carried.get(venueAccountKey(a)) ?? [], extras).book);
  }
  return accounts.map((a) => built.get(venueAccountKey(a))!);
}

/** Sum of decimal strings; null as soon as one is null. */
function sumOrNull(values: ReadonlyArray<string | null>): string | null {
  let total = 0n;
  for (const v of values) {
    if (v === null) return null;
    total += parseAmount(v);
  }
  return formatAmount(total);
}

const countedSales = (book: LotBook) => book.sales.filter((sale) => sale.counted !== 'none');

/**
 * The ledger book with the person's venue accounts beside it. The realised total and the fees are the ledger's and every
 * venue account's together: null when any part is null, and null when the venue could not be read (a venue sale may be
 * missing from it). Null, not 0, when nothing anywhere was sold.
 */
export function withVenue(main: LotBook, activity: TradeVenueActivityResult | null, shared: BookShared, extras: VenueExtras = {}): LotBook {
  let venue: LotBookVenue;
  let books: LotBook[] = [];
  if (activity === null) venue = { status: 'unwired', code: TAX_VENUE_UNWIRED };
  else if (activity.state === 'off') venue = { status: 'off', code: TAX_VENUE_OFF };
  else if (activity.state === 'unavailable') venue = { status: 'unavailable', code: TAX_VENUE_UNAVAILABLE };
  else {
    books = venueBooks(activity.accounts, shared, extras);
    venue = {
      status: 'read',
      test: activity.test,
      accounts: activity.accounts.map((a) => ({
        account: venueAccountKey(a),
        venueId: a.venueId,
        owner: a.owner,
        subAccount: a.subAccount,
        asOf: a.asOf,
      })),
    };
  }
  const unread = venue.status === 'unavailable';
  const all = [main, ...books];
  const selling = all.filter((book) => countedSales(book).length > 0);
  const realizedUsd = unread ? null : selling.length === 0 ? null : sumOrNull(selling.map((book) => book.realizedUsd));
  const feesUsd = unread ? null : sumOrNull(all.map((book) => book.feesUsd));
  const residuals = new Set(all.flatMap((book) => book.residuals));
  if (unread) residuals.add(TAX_VENUE_UNAVAILABLE);
  return {
    ...main,
    assets: [...main.assets, ...books.flatMap((b) => b.assets)],
    sales: [...main.sales, ...books.flatMap((b) => b.sales)],
    lots: [...main.lots, ...books.flatMap((b) => b.lots)],
    realizedUsd,
    feesUsd,
    residuals: [...residuals].sort(),
    venue,
  };
}
