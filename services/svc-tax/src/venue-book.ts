import { formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { TradeVenueAccountActivity, TradeVenueActivityResult } from '@intafaced/contracts';
import type { LotBookVenue } from '@intafaced/contracts/tax-lot-book';
import { TAX_VENUE_OFF, TAX_VENUE_UNAVAILABLE, TAX_VENUE_UNWIRED } from './codes.js';
import { buildLotBook, PAR_ASSETS, type Fill, type LotBook } from './lot-book.js';

/**
 * VENUE BOOK (J-cex-spot-01 #11). The person's own venue accounts in their profit and loss indicator: each account is a
 * book of its own, built by the same lot engine from the venue's own spot fills and checked against the venue's own
 * balances, then listed beside the ledger book. Nothing is stored: the fills and balances are read through svc-trade at
 * the moment of the read (`venue.ownActivity`), with the venue's as-of time. INTAFACED holds none of it, and the ledger
 * posts nothing for it.
 *
 * Each account stays apart: a venue sale draws only on that account's lots, and a ledger sale never draws on a venue lot.
 * Coins move between the venue and our ledger only through a wallet, which neither book follows, so a coin that arrived
 * on the venue other than by a fill does not reconcile and its figures are unknown, named, never guessed.
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

type BookShared = Pick<Parameters<typeof buildLotBook>[0], 'method' | 'rules' | 'preview' | 'choices' | 'includeTransfers' | 'now'>;

/** One venue account's book, every lot, sale and coin keyed by the account. */
export function buildVenueAccountBook(activity: TradeVenueAccountActivity, shared: BookShared): LotBook {
  const account = venueAccountKey(activity);
  const held = new Map<string, Amount>();
  for (const b of activity.balances) {
    const total = parseAmount(b.total);
    if (total > 0n) held.set(b.asset, (held.get(b.asset) ?? 0n) + total);
  }
  const book = buildLotBook({ ...shared, fills: activity.fills.map((f) => venueFillToFill(account, f)), held, truncated: false });
  return {
    ...book,
    lots: book.lots.map((lot) => ({ ...lot, venueAccount: account })),
    sales: book.sales.map((sale) => ({ ...sale, venueAccount: account })),
    assets: book.assets
      // A dollar coin is not a position: the ledger book does not list one it holds, nor does a venue account.
      .filter((a) => !PAR_ASSETS.has(a.assetId.toUpperCase()))
      .map((a) => ({ ...a, venueAccount: account })),
  };
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
export function withVenue(main: LotBook, activity: TradeVenueActivityResult | null, shared: BookShared): LotBook {
  let venue: LotBookVenue;
  let books: LotBook[] = [];
  if (activity === null) venue = { status: 'unwired', code: TAX_VENUE_UNWIRED };
  else if (activity.state === 'off') venue = { status: 'off', code: TAX_VENUE_OFF };
  else if (activity.state === 'unavailable') venue = { status: 'unavailable', code: TAX_VENUE_UNAVAILABLE };
  else {
    books = activity.accounts.map((a) => buildVenueAccountBook(a, shared));
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
