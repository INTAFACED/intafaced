import { formatAmount, isZero, type Amount } from '@intafaced/ledger-client';
import { TAX_COST_BASIS_UNAVAILABLE, TAX_LOT_UNDERFLOW } from './codes.js';

export const LOT_METHODS = ['FIFO', 'LIFO', 'HIFO'] as const;
export type LotMethod = (typeof LOT_METHODS)[number];

export function isLotMethod(value: string): value is LotMethod {
  return (LOT_METHODS as readonly string[]).includes(value);
}

export interface LotMovement {
  readonly assetId: string;
  readonly side: 'acquire' | 'dispose';
  readonly qty: Amount;
  readonly costBasis: Amount | null;
  readonly proceeds: Amount | null;
  readonly postedAt: Date;
  readonly txId: string;
  readonly reason: string;
}

export interface ClosedLot {
  readonly assetId: string;
  readonly qty: string;
  readonly acquiredAt: string;
  readonly disposedAt: string;
  readonly acquireTxId: string;
  readonly disposeTxId: string;
  readonly costBasis: string | null;
  readonly proceeds: string | null;
  readonly realized: string | null;
}

export interface OpenLot {
  readonly assetId: string;
  readonly qtyRemaining: string;
  readonly acquiredAt: string;
  readonly acquireTxId: string;
  readonly costBasis: string | null;
}

export interface LotRun {
  readonly lotsClosed: readonly ClosedLot[];
  readonly lotsOpen: readonly OpenLot[];
  readonly realized: string | null;
  readonly unrealized: string | null;
  readonly residuals: readonly string[];
}

interface OpenInternal {
  assetId: string;
  qtyRemaining: Amount;
  acquiredAt: Date;
  acquireTxId: string;
  costBasis: Amount | null;
}

function anyUnknownBasis(open: readonly OpenInternal[]): boolean {
  return open.some((lot) => lot.costBasis === null);
}

function pickIndex(open: readonly OpenInternal[], method: LotMethod): number {
  if (open.length === 0) return -1;
  if (method === 'FIFO') return 0;
  if (method === 'LIFO') return open.length - 1;

  let best = 0;
  for (let i = 1; i < open.length; i++) {
    const a = open[i]!;
    const b = open[best]!;
    // Caller must not reach here with a null basis — unknown lots refuse matching.
    if (a.costBasis === null || b.costBasis === null) return -1;
    const left = a.costBasis * b.qtyRemaining;
    const right = b.costBasis * a.qtyRemaining;
    if (left > right) best = i;
  }
  return best;
}

function splitCost(total: Amount | null, qty: Amount, take: Amount): { taken: Amount | null; left: Amount | null } {
  if (total === null) return { taken: null, left: null };
  if (take === qty) return { taken: total, left: 0n };
  const taken = (total * take) / qty;
  return { taken, left: total - taken };
}

function moneyOrNull(value: Amount | null): string | null {
  return value === null ? null : formatAmount(value);
}

/**
 * Lot-match acquire/dispose movements.
 * Missing cost basis is never 0 and never a FIFO/LIFO/HIFO pairing — residual, lots stay open.
 * Aggregate realized is null unless every matched lot has a basis.
 * Unrealized stays null: LotMovement has no market price, so open cost is not PnL.
 */
export function runLots(movements: readonly LotMovement[], method: LotMethod): LotRun {
  const byAsset = new Map<string, LotMovement[]>();
  for (const m of movements) {
    if (isZero(m.qty)) continue;
    const list = byAsset.get(m.assetId) ?? [];
    list.push(m);
    byAsset.set(m.assetId, list);
  }

  const lotsClosed: ClosedLot[] = [];
  const lotsOpen: OpenLot[] = [];
  const residuals = new Set<string>();
  let realizedSum: Amount | null = 0n;
  let anyClosed = false;

  for (const [, list] of byAsset) {
    list.sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime() || a.txId.localeCompare(b.txId));
    const open: OpenInternal[] = [];

    for (const m of list) {
      if (m.side === 'acquire') {
        open.push({
          assetId: m.assetId,
          qtyRemaining: m.qty,
          acquiredAt: m.postedAt,
          acquireTxId: m.txId,
          costBasis: m.costBasis,
        });
        continue;
      }

      let remaining = m.qty;
      let proceedsLeft = m.proceeds;
      while (remaining > 0n && open.length > 0) {
        if (anyUnknownBasis(open)) {
          residuals.add(TAX_COST_BASIS_UNAVAILABLE);
          realizedSum = null;
          break;
        }
        const idx = pickIndex(open, method);
        if (idx < 0) {
          residuals.add(TAX_COST_BASIS_UNAVAILABLE);
          realizedSum = null;
          break;
        }
        const lot = open[idx]!;
        if (lot.costBasis === null) {
          residuals.add(TAX_COST_BASIS_UNAVAILABLE);
          realizedSum = null;
          break;
        }
        const take = remaining < lot.qtyRemaining ? remaining : lot.qtyRemaining;
        const costSplit = splitCost(lot.costBasis, lot.qtyRemaining, take);
        const proceedsSplit = splitCost(proceedsLeft, remaining, take);

        let realized: Amount | null = null;
        if (costSplit.taken !== null && proceedsSplit.taken !== null) {
          realized = proceedsSplit.taken - costSplit.taken;
        } else {
          residuals.add(TAX_COST_BASIS_UNAVAILABLE);
          realizedSum = null;
        }

        lotsClosed.push({
          assetId: m.assetId,
          qty: formatAmount(take),
          acquiredAt: lot.acquiredAt.toISOString(),
          disposedAt: m.postedAt.toISOString(),
          acquireTxId: lot.acquireTxId,
          disposeTxId: m.txId,
          costBasis: moneyOrNull(costSplit.taken),
          proceeds: moneyOrNull(proceedsSplit.taken),
          realized: moneyOrNull(realized),
        });
        anyClosed = true;
        if (realizedSum !== null && realized !== null) realizedSum += realized;
        else realizedSum = null;

        remaining -= take;
        proceedsLeft = proceedsSplit.left;
        lot.qtyRemaining -= take;
        lot.costBasis = costSplit.left;
        if (lot.qtyRemaining === 0n) open.splice(idx, 1);
      }

      if (remaining > 0n && open.length === 0) residuals.add(TAX_LOT_UNDERFLOW);
    }

    for (const lot of open) {
      if (lot.costBasis === null) residuals.add(TAX_COST_BASIS_UNAVAILABLE);
      lotsOpen.push({
        assetId: lot.assetId,
        qtyRemaining: formatAmount(lot.qtyRemaining),
        acquiredAt: lot.acquiredAt.toISOString(),
        acquireTxId: lot.acquireTxId,
        costBasis: moneyOrNull(lot.costBasis),
      });
    }
  }

  return {
    lotsClosed,
    lotsOpen,
    realized: anyClosed ? moneyOrNull(realizedSum) : null,
    unrealized: null,
    residuals: [...residuals].sort(),
  };
}
