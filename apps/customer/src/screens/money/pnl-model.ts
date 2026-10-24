import {
  LOT_BOOK_METHODS,
  type LotBookAnswer,
  type LotBookLot,
  type LotBookMethod,
  type LotBookSale,
} from '@intafaced/contracts/tax-lot-book';
import { dec, decOrNull, ratio, sub, sumOf, times, type Scaled } from '../../data/decimal';
import type { Decimal } from '../../data';
import type { MoneyRow } from './portfolio-source';

/**
 * Profit and loss, as the customer sees it. The lot book (tax.lotBook) says what was bought and sold and at what dollar
 * cost; the Money screen's own valuation says what the coins are worth now. Every figure is a decimal string or null:
 * a figure that cannot be known is null with a reason, never a zero.
 */

export { basisWriteResultSchema, lotBookSchema, lotChoiceSavedSchema, missingBasisSchema } from '@intafaced/contracts/tax-lot-book';
export type { LotBookAnswer as LotBook, LotBookChoices, LotBookLot, LotBookSale, LotMethodSource } from '@intafaced/contracts/tax-lot-book';
import type { missingBasisSchema as MissingBasisSchema } from '@intafaced/contracts/tax-lot-book';
import type { z } from 'zod';
export type MissingBasis = z.infer<typeof MissingBasisSchema>;
export type MissingBasisItem = MissingBasis['items'][number];

/** The methods the screen offers, in the order of the switch. AVERAGE is one running cost per coin for each asset. */
export const LOT_METHODS = LOT_BOOK_METHODS;
export type LotMethod = LotBookMethod;

/**
 * `?method=` on /money/pnl: absent is the customer's saved choices (else the product default FIFO); one of the methods is a
 * preview of that method for every sale; anything else is refused.
 */
export function methodFromQuery(search: string): LotMethod | 'saved' | { unknown: string } {
  const raw = new URLSearchParams(search).get('method');
  if (raw === null || raw === '') return 'saved';
  const upper = raw.toUpperCase();
  return (LOT_METHODS as readonly string[]).includes(upper) ? (upper as LotMethod) : { unknown: raw };
}

export type UnknownReason = 'cost_unknown' | 'no_price' | 'not_reconciled';

export interface AssetPnl {
  asset: string;
  /** Quantity whose cost the trades tell us. */
  knownQty: Decimal;
  /** Quantity held that no trade accounts for (arrived by deposit or transfer, or left another way). */
  otherQty: Decimal;
  costUsd: Decimal | null;
  /** Cost per coin of the quantity still open (open cost / open quantity), buy fees included; null when the cost is unknown. */
  avgPriceUsd: Decimal | null;
  valueUsd: Decimal | null;
  unrealisedUsd: Decimal | null;
  /** Unrealised as a ratio of cost ("0.25"); null when cost is zero or unknown. */
  unrealisedRatio: Decimal | null;
  reason: UnknownReason | null;
}

export interface PnlView {
  assets: AssetPnl[];
  /** Sum over every asset; null when any asset's unrealised result is unknown. */
  unrealisedUsd: Decimal | null;
  realisedUsd: Decimal | null;
}

/** Quantity of `asset` held beyond what the open lots cover, never negative. */
function otherOf(held: Scaled | null, open: Scaled): Decimal {
  const left = held === null ? 0n : held - open;
  return decOrNull(left > 0n ? left : 0n) ?? '0';
}

export function pnlView(book: LotBookAnswer, rows: readonly MoneyRow[] | null): PnlView {
  const byAsset = new Map((rows ?? []).map((row) => [row.asset, row]));
  const assets: AssetPnl[] = [];
  for (const line of book.assets) {
    const open = dec(line.openQty);
    if (open === null || open <= 0n) continue;
    const price = byAsset.get(line.assetId);
    const cost = dec(line.openCostUsd);
    let reason: UnknownReason | null = null;
    let value: Scaled | null = null;
    if (cost === null)
      reason = book.residuals.includes('tax.lot_book_unreconciled') && dec(line.held)! < open ? 'not_reconciled' : 'cost_unknown';
    const total = dec(price?.amount);
    const worth = dec(price?.usdValue);
    if (total !== null && total > 0n && worth !== null) {
      const share = ratio(open, total);
      value = share === null ? null : times(worth, share > 10n ** 18n ? 10n ** 18n : share);
    } else if (reason === null) {
      reason = 'no_price';
    }
    const unrealised = cost !== null && value !== null ? sub(value, cost) : null;
    assets.push({
      asset: line.assetId,
      knownQty: line.openQty,
      otherQty: otherOf(dec(line.held), open),
      costUsd: line.openCostUsd,
      avgPriceUsd: cost === null ? null : decOrNull(ratio(cost, open)),
      valueUsd: decOrNull(value),
      unrealisedUsd: decOrNull(unrealised),
      unrealisedRatio: unrealised !== null && cost !== null && cost > 0n ? decOrNull(ratio(unrealised, cost)) : null,
      reason: unrealised === null ? (reason ?? 'cost_unknown') : null,
    });
  }
  const known = assets.map((a) => dec(a.unrealisedUsd));
  const unrealisedUsd = assets.length > 0 && known.every((v) => v !== null) ? decOrNull(sumOf(known as Scaled[])) : null;
  return { assets, unrealisedUsd, realisedUsd: book.realizedUsd };
}

/** The assets that have lots, in the book's order (by first arrival). */
export function lotAssets(book: LotBookAnswer): string[] {
  return [...new Set(book.lots.map((lot) => lot.assetId))];
}

/** `?asset=` picks the lots shown; absent or unknown falls back to the first asset that has lots. */
export function lotAssetFromQuery(search: string, assets: readonly string[]): string | null {
  const raw = new URLSearchParams(search).get('asset')?.toUpperCase() ?? null;
  return raw !== null && assets.includes(raw) ? raw : (assets[0] ?? null);
}

export function lotsOf(book: LotBookAnswer, asset: string, account: LotAccount = 'all'): LotBookLot[] {
  return book.lots.filter(
    (lot) => lot.assetId === asset && (account === 'all' || (account === 'main' ? lot.spaceId === undefined : lot.spaceId === account)),
  );
}

/** Where a lot sits: the main account, or one of the customer's named spaces (by id). `all`: every account. */
export type LotAccount = 'all' | 'main' | string;

/** A named space the book follows, by id; null when the book does not list it. */
export function spaceOf(book: LotBookAnswer, spaceId: string): { name: string; archived: boolean } | null {
  if (book.spaces?.status !== 'read') return null;
  const space = book.spaces.list.find((s) => s.spaceId === spaceId);
  return space === undefined ? null : { name: space.name, archived: space.archived };
}

/** The accounts that hold lots of this coin: main first, then each space in the order the book lists them. */
export function lotAccounts(book: LotBookAnswer, asset: string): string[] {
  const held = new Set(lotsOf(book, asset).map((lot) => lot.spaceId ?? 'main'));
  const spaces = book.spaces?.status === 'read' ? book.spaces.list.map((s) => s.spaceId) : [];
  return ['main', ...spaces].filter((id) => held.has(id));
}

/** `?account=` picks whose lots are shown; absent or unknown is every account. */
export function lotAccountFromQuery(search: string, accounts: readonly string[]): LotAccount {
  const raw = new URLSearchParams(search).get('account');
  return raw !== null && accounts.includes(raw) ? raw : 'all';
}

/** The parts of one sale that reached a lot with no cost (or no lot at all), from the missing list; empty when every part has a cost. */
export function unknownShareOf(missing: MissingBasis, sale: { txId: string; assetId: string }): MissingBasisItem[] {
  return missing.items.filter((item) => item.kind === 'disposal' && item.saleTxId === sale.txId && item.assetId === sale.assetId);
}

/** The open lots with no cost, each once, in the order the missing list names them. */
export function lotsMissingCost(missing: MissingBasis): MissingBasisItem[] {
  const seen = new Set<string>();
  return missing.items.filter((item) => {
    if (item.kind !== 'open' || item.lotId === null || seen.has(item.lotId)) return false;
    seen.add(item.lotId);
    return true;
  });
}

/**
 * The lots a sale could draw on: the same coin, arrived by the time of the sale, and still open then. A lot was open at
 * the sale if some of it is open now or this sale or a later one drew on it; one used up by earlier sales is not offered.
 */
export function pickableLots(book: LotBookAnswer, sale: LotBookSale): LotBookLot[] {
  const usedFromHere = new Set(
    book.sales.filter((s) => s.assetId === sale.assetId && s.disposedAt >= sale.disposedAt).flatMap((s) => s.matches.map((m) => m.lotId)),
  );
  return book.lots.filter(
    (lot) => lot.assetId === sale.assetId && lot.acquiredAt <= sale.disposedAt && (lot.remaining !== '0' || usedFromHere.has(lot.id)),
  );
}

/** The coin's own saved method, or null when it follows the account. */
export function coinMethod(book: LotBookAnswer, asset: string): LotMethod | null {
  return book.choices.status === 'saved' ? (book.choices.assetMethods.find((m) => m.assetId === asset)?.method ?? null) : null;
}
