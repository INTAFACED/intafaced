import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TAX_COST_BASIS_UNAVAILABLE, TAX_LOT_BOOK_INCOMPLETE, TAX_LOT_BOOK_UNRECONCILED } from './codes.js';
import { runLots, type LotMethod, type LotMovement } from './lots.js';

/**
 * LOT BOOK. Profit and loss as an indicator, built only from the customer's own trade fills. Not a tax form and not tied to
 * a jurisdiction (that is the year pack). One fill is two legs of one ledger transaction: what the customer received (net of
 * the fee) and what left their order hold. A coin bought with a dollar coin has a real cost in dollars; a coin sold for a
 * dollar coin has real proceeds. A trade between two non-dollar coins has no dollar figure on either side (this platform
 * has no FX source and does not convert through a third market), so both sides stay unknown. Coins that arrived any other
 * way (deposits, transfers) have no lot at all, and a sale that reaches them is named, never guessed.
 */

/** Counted as exactly 1 USD, the same set the bank's total-value rule uses. */
export const PAR_ASSETS: ReadonlySet<string> = new Set(['USDT', 'USDC', 'USD']);

/** The method when the caller names none. A product default for an indicator, not a tax rule; any call may pass another. */
export const DEFAULT_LOT_BOOK_METHOD: LotMethod = 'FIFO';

export const INDICATOR_LABEL = 'indicator_not_tax_advice' as const;

export interface FillLeg {
  readonly assetId: string;
  readonly amount: Amount;
}

export interface Fill {
  readonly txId: string;
  readonly postedAt: Date;
  /** Credited to the customer's balance, net of fee. */
  readonly received: FillLeg;
  /** Left the customer's order hold. Null when the paying leg could not be read. */
  readonly paid: FillLeg | null;
}

export interface BookAsset {
  readonly assetId: string;
  /** Quantity still open in lots built from fills. */
  readonly openQty: string;
  /** USD cost of that open quantity; null if any open lot has no known cost, or the book does not reconcile. */
  readonly openCostUsd: string | null;
  /** Everything the customer holds of the asset now (main account, all lock kinds). */
  readonly held: string;
}

export interface BookSale {
  readonly assetId: string;
  readonly txId: string;
  readonly disposedAt: string;
  readonly qty: string;
  /** Part of the sale that reached no lot with a known cost (coins that arrived by deposit or transfer, or whose cost is unknown). */
  readonly unmatchedQty: string;
  readonly proceedsUsd: string | null;
  readonly costUsd: string | null;
  readonly realizedUsd: string | null;
}

export interface LotBook {
  readonly method: LotMethod;
  readonly indicator: typeof INDICATOR_LABEL;
  readonly assets: BookAsset[];
  readonly sales: BookSale[];
  /** Sum of every sale's result; null as soon as any sale's result is unknown. Null, not 0, when there is no sale. */
  readonly realizedUsd: string | null;
  readonly residuals: string[];
}

function movementsOf(fills: readonly Fill[], residuals: Set<string>): LotMovement[] {
  const out: LotMovement[] = [];
  for (const fill of fills) {
    const { received, paid } = fill;
    const receivedPar = PAR_ASSETS.has(received.assetId.toUpperCase());
    const paidPar = paid !== null && PAR_ASSETS.has(paid.assetId.toUpperCase());
    if (paid === null) {
      // The paying leg is unread: the receiving side is a real position change with an unknown other side.
      residuals.add(TAX_LOT_BOOK_INCOMPLETE);
      if (!receivedPar) {
        out.push({
          assetId: received.assetId,
          side: 'acquire',
          qty: received.amount,
          costBasis: null,
          proceeds: null,
          postedAt: fill.postedAt,
          txId: fill.txId,
          reason: 'trade.fill',
        });
      }
      continue;
    }
    if (receivedPar && paidPar) continue; // dollar coin for dollar coin: not a position in anything
    if (!receivedPar) {
      out.push({
        assetId: received.assetId,
        side: 'acquire',
        qty: received.amount,
        costBasis: paidPar ? paid.amount : null,
        proceeds: null,
        postedAt: fill.postedAt,
        txId: fill.txId,
        reason: 'trade.fill',
      });
    }
    if (!paidPar) {
      out.push({
        assetId: paid.assetId,
        side: 'dispose',
        qty: paid.amount,
        costBasis: null,
        proceeds: receivedPar ? received.amount : null,
        postedAt: fill.postedAt,
        txId: fill.txId,
        reason: 'trade.fill',
      });
    }
  }
  return out;
}

export function buildLotBook(input: {
  fills: readonly Fill[];
  held: ReadonlyMap<string, Amount>;
  method: LotMethod;
  /** The read stopped before the start of history. */
  truncated: boolean;
}): LotBook {
  const residuals = new Set<string>();
  if (input.truncated) residuals.add(TAX_LOT_BOOK_INCOMPLETE);
  const movements = movementsOf(input.fills, residuals);
  const run = runLots(movements, input.method);
  for (const r of run.residuals) residuals.add(r);

  // Sales: every dispose movement, with what the lots matched.
  const sales: BookSale[] = [];
  for (const m of movements) {
    if (m.side !== 'dispose') continue;
    const closed = run.lotsClosed.filter((c) => c.disposeTxId === m.txId && c.assetId === m.assetId);
    const matched = closed.reduce<Amount>((sum, c) => sum + toAmount(c.qty), 0n);
    const known = (pick: (c: (typeof closed)[number]) => string | null): Amount | null => {
      let sum = 0n;
      for (const c of closed) {
        const v = pick(c);
        if (v === null) return null;
        sum += toAmount(v);
      }
      return sum;
    };
    const unmatched = m.qty - matched;
    const costUsd = unmatched > 0n ? null : known((c) => c.costBasis);
    const proceedsUsd = m.proceeds;
    const realized = unmatched > 0n || closed.length === 0 ? null : known((c) => c.realized);
    sales.push({
      assetId: m.assetId,
      txId: m.txId,
      disposedAt: m.postedAt.toISOString(),
      qty: formatAmount(m.qty),
      unmatchedQty: formatAmount(unmatched),
      proceedsUsd: proceedsUsd === null ? null : formatAmount(proceedsUsd),
      costUsd: costUsd === null ? null : formatAmount(costUsd),
      realizedUsd: realized === null ? null : formatAmount(realized),
    });
  }
  sales.sort((a, b) => (a.disposedAt === b.disposedAt ? a.txId.localeCompare(b.txId) : a.disposedAt < b.disposedAt ? 1 : -1));

  // Open lots per asset. If more is open than the customer holds, coins left some other way (a withdrawal, a transfer) and
  // there is no way to say which lot they were: the cost of that asset is unknown, not a guess.
  const openByAsset = new Map<string, { qty: Amount; cost: Amount | null }>();
  for (const lot of run.lotsOpen) {
    const entry = openByAsset.get(lot.assetId) ?? { qty: 0n, cost: 0n as Amount | null };
    entry.qty += toAmount(lot.qtyRemaining);
    entry.cost = entry.cost === null || lot.costBasis === null ? null : entry.cost + toAmount(lot.costBasis);
    openByAsset.set(lot.assetId, entry);
  }
  const assetIds = [...new Set([...openByAsset.keys(), ...input.held.keys()])].sort();
  const assets: BookAsset[] = [];
  const outside = new Set<string>();
  for (const assetId of assetIds) {
    const open = openByAsset.get(assetId);
    const held = input.held.get(assetId) ?? 0n;
    if (open === undefined && held === 0n) continue;
    // The book only knows coins that came from fills. Held more (a deposit, a transfer in, interest) and a sale may have
    // used those coins first; held less and some left another way. Either way which lot is open is not known.
    const reconciled = (open?.qty ?? 0n) === held || PAR_ASSETS.has(assetId.toUpperCase());
    if (!reconciled) {
      residuals.add(TAX_LOT_BOOK_UNRECONCILED);
      outside.add(assetId);
    }
    if (open?.cost === null) residuals.add(TAX_COST_BASIS_UNAVAILABLE);
    assets.push({
      assetId,
      openQty: formatAmount(open?.qty ?? 0n),
      openCostUsd: open === undefined || !reconciled || input.truncated || open.cost === null ? null : formatAmount(open.cost),
      held: formatAmount(held),
    });
  }
  const unknownSale = (sale: BookSale): BookSale =>
    input.truncated || outside.has(sale.assetId) ? { ...sale, costUsd: null, realizedUsd: null } : sale;
  const finalSales = sales.map(unknownSale);
  let realizedTotal: Amount | null = 0n;
  for (const sale of finalSales) {
    if (sale.realizedUsd === null) {
      realizedTotal = null;
      break;
    }
    realizedTotal += toAmount(sale.realizedUsd);
  }

  return {
    method: input.method,
    indicator: INDICATOR_LABEL,
    assets,
    sales: finalSales,
    realizedUsd: finalSales.length === 0 ? null : realizedTotal === null ? null : formatAmount(realizedTotal),
    residuals: [...residuals].sort(),
  };
}

function toAmount(decimal: string): Amount {
  return parseAmount(decimal);
}
