import { MoneyError, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import {
  TAX_BASIS_DATE_INVALID,
  TAX_BASIS_DATE_UNSET,
  TAX_BASIS_LOT_UNKNOWN,
  TAX_BASIS_NOTE_UNSET,
  TAX_BASIS_PRICE_INVALID,
  TAX_BASIS_PRICE_UNSET,
  TAX_COST_BASIS_UNAVAILABLE,
  TAX_LOT_UNDERFLOW,
  TAX_MANUAL_POSITION_INCOMPLETE,
  UNKNOWN_SHARE,
  TaxError,
} from './codes.js';
import type { LotBook } from './lot-book.js';
import type { BasisWrite } from './basis-store.js';

const MANUAL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface MissingBasisItem {
  readonly lotId: string | null;
  readonly assetId: string;
  readonly kind: 'open' | 'disposal';
  readonly qty: string;
  readonly code: typeof TAX_COST_BASIS_UNAVAILABLE | typeof TAX_LOT_UNDERFLOW;
  readonly effect: typeof UNKNOWN_SHARE;
  readonly saleTxId: string | null;
}

export interface BasisSetInput {
  readonly userId: string;
  readonly lotId: string;
  readonly pricePerUnit: string;
  readonly date: string;
  readonly sourceNote: string;
  readonly assetId?: string;
  readonly qty?: string;
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

function requirePrice(raw: string): Amount {
  if (blank(raw)) throw new TaxError(TAX_BASIS_PRICE_UNSET, 'a customer basis needs a price per unit; a blank price is not zero');
  let price: Amount;
  try {
    price = parseAmount(raw.trim());
  } catch (err) {
    if (err instanceof MoneyError) throw new TaxError(TAX_BASIS_PRICE_INVALID, 'price per unit must be a positive decimal string');
    throw err;
  }
  if (price <= 0n) throw new TaxError(TAX_BASIS_PRICE_INVALID, 'price per unit must be a positive decimal string');
  return price;
}

function requireWhen(raw: string): string {
  if (blank(raw)) throw new TaxError(TAX_BASIS_DATE_UNSET, 'a customer basis needs the day the coins were acquired');
  const at = new Date(raw.trim());
  if (Number.isNaN(at.getTime())) throw new TaxError(TAX_BASIS_DATE_INVALID, 'the acquired day is not a real instant');
  return at.toISOString();
}

function requireNote(raw: string): string {
  if (blank(raw)) throw new TaxError(TAX_BASIS_NOTE_UNSET, 'a customer basis needs a note of where the price came from');
  return raw.trim();
}

/** Turns a write into the canonical row fields. Does not look at the book. */
export function parseBasisSet(input: BasisSetInput): BasisWrite {
  const lotId = input.lotId.trim();
  if (lotId.length === 0) throw new TaxError(TAX_BASIS_LOT_UNKNOWN, 'a basis write needs a lot id');
  const price = requirePrice(input.pricePerUnit);
  const acquiredAt = requireWhen(input.date);
  const sourceNote = requireNote(input.sourceNote);
  const manual = lotId.startsWith('manual:');
  if (manual) {
    const token = lotId.slice(`manual:${input.userId}:`.length);
    if (!lotId.startsWith(`manual:${input.userId}:`) || !MANUAL_TOKEN.test(token)) {
      throw new TaxError(TAX_BASIS_LOT_UNKNOWN, 'a manual position id is manual:<your account>:<token>');
    }
    if (blank(input.assetId) || blank(input.qty)) {
      throw new TaxError(TAX_MANUAL_POSITION_INCOMPLETE, 'a manual position needs an asset and a quantity, and it is not a balance');
    }
    let qty: Amount;
    try {
      qty = parseAmount(input.qty!.trim());
    } catch (err) {
      if (err instanceof MoneyError) {
        throw new TaxError(TAX_MANUAL_POSITION_INCOMPLETE, 'a manual position quantity must be a positive decimal string');
      }
      throw err;
    }
    if (qty <= 0n) throw new TaxError(TAX_MANUAL_POSITION_INCOMPLETE, 'a manual position quantity must be a positive decimal string');
    return {
      userId: input.userId,
      lotId,
      kind: 'manual',
      pricePerUnit: formatAmount(price),
      acquiredAt,
      sourceNote,
      assetId: input.assetId!.trim(),
      qty: formatAmount(qty),
    };
  }
  if (!blank(input.assetId) || !blank(input.qty)) {
    throw new TaxError(TAX_BASIS_LOT_UNKNOWN, 'a ledger lot takes its asset and quantity from the book');
  }
  return {
    userId: input.userId,
    lotId,
    kind: 'override',
    pricePerUnit: formatAmount(price),
    acquiredAt,
    sourceNote,
    assetId: null,
    qty: null,
  };
}

/** Open lots and disposals whose basis is still null. The effect is the words "unknown share", never a figure. */
export function listMissingBasis(book: Pick<LotBook, 'lots' | 'sales'>): MissingBasisItem[] {
  const items: MissingBasisItem[] = [];
  for (const lot of book.lots) {
    if (lot.remaining === '0') continue;
    if (lot.costUsd !== null && lot.remainingCostUsd !== null) continue;
    items.push({
      lotId: lot.id,
      assetId: lot.assetId,
      kind: 'open',
      qty: lot.remaining,
      code: TAX_COST_BASIS_UNAVAILABLE,
      effect: UNKNOWN_SHARE,
      saleTxId: null,
    });
  }
  for (const sale of book.sales) {
    for (const match of sale.matches) {
      if (match.costUsd !== null) continue;
      items.push({
        lotId: match.lotId,
        assetId: sale.assetId,
        kind: 'disposal',
        qty: match.qty,
        code: TAX_COST_BASIS_UNAVAILABLE,
        effect: UNKNOWN_SHARE,
        saleTxId: sale.txId,
      });
    }
    if (sale.unmatchedQty !== '0') {
      items.push({
        lotId: null,
        assetId: sale.assetId,
        kind: 'disposal',
        qty: sale.unmatchedQty,
        code: TAX_LOT_UNDERFLOW,
        effect: UNKNOWN_SHARE,
        saleTxId: sale.txId,
      });
    }
  }
  items.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.assetId.localeCompare(b.assetId) ||
      (a.lotId ?? '').localeCompare(b.lotId ?? '') ||
      (a.saleTxId ?? '').localeCompare(b.saleTxId ?? ''),
  );
  return items;
}
