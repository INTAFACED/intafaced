import { mul, type Amount } from '@intafaced/ledger-client';
import { TAX_COST_BASIS_UNAVAILABLE, TAX_LOT_PICK_UNUSABLE, TAX_LOT_UNDERFLOW } from './codes.js';

/**
 * LOT ENGINE for the lot book (the profit and loss indicator). The year pack keeps its own matcher in `lots.ts`.
 *
 * Every lot has a deterministic id (`lot:<acquireTxId>:<assetId>`), a source (a trade, a deposit, a reward, a move in from
 * another account) and a basis that is either a dollar amount or null. Null is never zero: a sale that draws on a lot with
 * no basis has an unknown cost for that part, and the rest of the sale keeps its known figures (this is finer than the
 * year pack's matcher, which stops at the first unknown lot). Under HIFO a lot with no basis cannot be ranked, so a sale
 * that would have to rank it is unknown as a whole: its quantity is still drawn (oldest first) so the open quantity stays
 * right, and the lots left have an unknown basis, since which of them is open is not known.
 *
 * AVERAGE keeps one running cost per asset: a sale takes quantity at the current average cost per coin and leaves the
 * average unchanged. The lots list still shows which arrivals are left, oldest first, each at that average.
 */

export const ENGINE_METHODS = ['FIFO', 'LIFO', 'HIFO', 'AVERAGE'] as const;
export type EngineMethod = (typeof ENGINE_METHODS)[number];

export type LotSource = 'trade' | 'deposit' | 'reward' | 'transfer_in' | 'other_in';

/** The dollar value of an arrival at the time it arrived, and where that price came from. */
export interface ValuedAt {
  readonly usd: Amount;
  /** The market whose candle priced it, e.g. `BTC/USDT`, or `par` for a dollar coin. */
  readonly market: string;
  /** Candle size used (`1m`, `1h`, `1d`), null for `par`. */
  readonly timeframe: string | null;
  /** Start of the candle whose close priced it. */
  readonly candleAt: Date | null;
  readonly price: Amount;
}

export interface EngineAcquire {
  readonly side: 'acquire';
  readonly txId: string;
  readonly postedAt: Date;
  readonly assetId: string;
  readonly qty: Amount;
  /** What it cost in dollars; null when not known. */
  readonly costUsd: Amount | null;
  readonly source: LotSource;
  /** Reason on the ledger line, kept for the audit view. */
  readonly reason: string;
  readonly valuedAt: ValuedAt | null;
}

export interface EngineDispose {
  readonly side: 'dispose';
  readonly txId: string;
  readonly postedAt: Date;
  readonly assetId: string;
  readonly qty: Amount;
  readonly proceedsUsd: Amount | null;
}

export type EngineMovement = EngineAcquire | EngineDispose;

export interface LotMatch {
  readonly lotId: string;
  readonly qty: Amount;
  readonly costUsd: Amount | null;
  readonly proceedsUsd: Amount | null;
  readonly realizedUsd: Amount | null;
  /** The cost of this part came from a price the customer entered. Absent otherwise. */
  readonly customerEntered?: true;
}

/**
 * How one sale is matched: the method, and optionally one lot the customer picked for it. A picked lot is drawn first (as
 * much of it as is still open); anything left of the sale goes by the method. `source` says where the method came from and
 * is passed through untouched.
 */
export interface SaleRule {
  readonly method: EngineMethod;
  readonly lotId?: string | null;
  readonly source: string;
}

export type SaleRules = EngineMethod | ((sale: EngineDispose) => SaleRule);

export interface EngineSale {
  readonly rule: SaleRule;
  /** The picked lot, when it was open at the sale and so was used; null when there was no pick or it could not be used. */
  readonly pickedLotId: string | null;
  readonly assetId: string;
  readonly txId: string;
  readonly postedAt: Date;
  readonly qty: Amount;
  /** Quantity no open lot covered. */
  readonly unmatchedQty: Amount;
  readonly proceedsUsd: Amount | null;
  /** Null as soon as any part is unknown or uncovered. */
  readonly costUsd: Amount | null;
  readonly realizedUsd: Amount | null;
  readonly matches: readonly LotMatch[];
}

export interface EngineLot {
  readonly id: string;
  readonly assetId: string;
  readonly acquiredAt: Date;
  readonly acquireTxId: string;
  readonly source: LotSource;
  readonly reason: string;
  readonly qty: Amount;
  readonly remaining: Amount;
  /** Basis of the whole arrival; null when unknown. */
  readonly costUsd: Amount | null;
  /** Basis of what is left; null when unknown. */
  readonly remainingCostUsd: Amount | null;
  readonly valuedAt: ValuedAt | null;
  /** The arrival's cost came from a price the customer entered. Absent otherwise. */
  readonly customerEntered?: true;
}

export interface EngineRun {
  readonly lots: EngineLot[];
  readonly sales: EngineSale[];
  readonly residuals: string[];
}

export function isEngineMethod(value: string): value is EngineMethod {
  return (ENGINE_METHODS as readonly string[]).includes(value);
}

export function lotIdOf(acquireTxId: string, assetId: string): string {
  return `lot:${acquireTxId}:${assetId}`;
}

interface OpenLot {
  readonly lot: Omit<EngineLot, 'remaining' | 'remainingCostUsd' | 'customerEntered'>;
  remaining: Amount;
  remainingCost: Amount | null;
  customerEntered: boolean;
}

/** total * take / qty, floored at the ledger's places; the whole when all is taken. */
function share(total: Amount, qty: Amount, take: Amount): Amount {
  return take === qty ? total : (total * take) / qty;
}

function pick(open: readonly OpenLot[], method: EngineMethod): number | null {
  if (method === 'LIFO') return open.length - 1;
  if (method !== 'HIFO') return 0; // FIFO, and AVERAGE draws quantity oldest first
  let best = 0;
  for (let i = 0; i < open.length; i++) {
    const a = open[i]!;
    if (a.remainingCost === null) return null; // cannot rank a lot with no basis
    const b = open[best]!;
    if (b.remainingCost === null) return null;
    if (a.remainingCost * b.remaining > b.remainingCost * a.remaining) best = i;
  }
  return best;
}

export function runLotEngine(
  movements: readonly EngineMovement[],
  rules: SaleRules,
  /** Price per unit, in dollars, for a lot whose own cost is null. Keyed by the lot id this function assigns. */
  overridePricePerUnit?: ReadonlyMap<string, Amount>,
): EngineRun {
  const ruleOf = typeof rules === 'string' ? (): SaleRule => ({ method: rules, source: 'call' }) : rules;
  const byAsset = new Map<string, EngineMovement[]>();
  for (const m of movements) {
    if (m.qty <= 0n) continue;
    byAsset.set(m.assetId, [...(byAsset.get(m.assetId) ?? []), m]);
  }
  const lots: EngineLot[] = [];
  const sales: EngineSale[] = [];
  const residuals = new Set<string>();

  const usedIds = new Set<string>();
  for (const list of byAsset.values()) {
    // Same instant: arrivals before departures, so a fill that buys and a sale in one transaction keep their order.
    list.sort(
      (a, b) =>
        a.postedAt.getTime() - b.postedAt.getTime() || (a.side === b.side ? a.txId.localeCompare(b.txId) : a.side === 'acquire' ? -1 : 1),
    );
    const open: OpenLot[] = [];
    const all: OpenLot[] = [];
    for (const m of list) {
      if (m.side === 'acquire') {
        // Two arrivals of one coin in one transaction get `:2`, `:3` in history order, so ids stay unique and repeatable.
        let id = lotIdOf(m.txId, m.assetId);
        for (let n = 2; usedIds.has(id); n++) id = `${lotIdOf(m.txId, m.assetId)}:${n}`;
        usedIds.add(id);
        const price = m.costUsd === null ? overridePricePerUnit?.get(id) : undefined;
        const entered = price !== undefined && price > 0n;
        const costUsd = entered ? mul(price, m.qty) : m.costUsd;
        const entry: OpenLot = {
          lot: {
            id,
            assetId: m.assetId,
            acquiredAt: m.postedAt,
            acquireTxId: m.txId,
            source: m.source,
            reason: m.reason,
            qty: m.qty,
            costUsd,
            valuedAt: m.valuedAt,
          },
          remaining: m.qty,
          remainingCost: costUsd,
          customerEntered: entered,
        };
        open.push(entry);
        all.push(entry);
        continue;
      }
      sales.push(dispose(m, open, ruleOf(m), residuals));
    }
    for (const entry of all) {
      lots.push({
        ...entry.lot,
        remaining: entry.remaining,
        remainingCostUsd: entry.remaining === 0n ? 0n : entry.remainingCost,
        ...(entry.customerEntered ? { customerEntered: true as const } : {}),
      });
      if (entry.remaining > 0n && entry.remainingCost === null) residuals.add(TAX_COST_BASIS_UNAVAILABLE);
    }
  }
  lots.sort((a, b) => a.acquiredAt.getTime() - b.acquiredAt.getTime() || a.id.localeCompare(b.id));
  sales.sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime() || a.txId.localeCompare(b.txId));
  return { lots, sales, residuals: [...residuals].sort() };
}

function dispose(m: EngineDispose, open: OpenLot[], rule: SaleRule, residuals: Set<string>): EngineSale {
  const { method } = rule;
  const matches: LotMatch[] = [];
  // A picked lot is used only if it is still open when the sale happens; otherwise the pick is named and the method decides.
  let picked: OpenLot | null = null;
  if (rule.lotId) {
    picked = open.find((lot) => lot.lot.id === rule.lotId) ?? null;
    if (picked === null) residuals.add(TAX_LOT_PICK_UNUSABLE);
  }
  let remaining = m.qty;
  let proceedsLeft = m.proceedsUsd;
  let unknown = false;
  let unranked = false;

  // AVERAGE: one cost per coin for the whole open quantity, fixed for this sale.
  let averagePool: { qty: Amount; cost: Amount | null } | null = null;
  if (method === 'AVERAGE') {
    let qty = 0n;
    let cost: Amount | null = 0n;
    for (const lot of open) {
      qty += lot.remaining;
      cost = cost === null || lot.remainingCost === null ? null : cost + lot.remainingCost;
    }
    averagePool = { qty, cost };
  }
  const poolEntered = averagePool !== null && averagePool.cost !== null && open.some((lot) => lot.customerEntered);

  while (remaining > 0n && open.length > 0) {
    const pickedAt = picked === null ? -1 : open.indexOf(picked);
    let idx = pickedAt >= 0 ? pickedAt : pick(open, method);
    if (idx === null) {
      // HIFO cannot rank a lot with no basis. The coins still left: draw the quantity oldest first so the open quantity stays
      // right, but which lot really went is not known, so this sale's cost and the cost of every lot left are unknown.
      unknown = true;
      unranked = true;
      residuals.add(TAX_COST_BASIS_UNAVAILABLE);
      idx = 0;
    }
    const lot = open[idx]!;
    const take = remaining < lot.remaining ? remaining : lot.remaining;
    let cost: Amount | null;
    if (unranked) {
      cost = null;
    } else if (averagePool !== null) {
      cost = averagePool.cost === null ? null : share(averagePool.cost, averagePool.qty, take);
    } else {
      cost = lot.remainingCost === null ? null : share(lot.remainingCost, lot.remaining, take);
    }
    const proceeds = proceedsLeft === null ? null : share(proceedsLeft, remaining, take);
    if (cost === null) {
      unknown = true;
      residuals.add(TAX_COST_BASIS_UNAVAILABLE);
    }
    const fromCustomer = cost !== null && (lot.customerEntered || poolEntered);
    matches.push({
      lotId: lot.lot.id,
      qty: take,
      costUsd: cost,
      proceedsUsd: proceeds,
      realizedUsd: cost === null || proceeds === null ? null : proceeds - cost,
      ...(fromCustomer ? { customerEntered: true as const } : {}),
    });
    remaining -= take;
    if (proceedsLeft !== null && proceeds !== null) proceedsLeft -= proceeds;
    // Under AVERAGE the lots left are restated at the pool's cost per coin after the loop.
    if (averagePool === null) lot.remainingCost = lot.remainingCost === null || cost === null ? null : lot.remainingCost - cost;
    lot.remaining -= take;
    if (lot.remaining === 0n) open.splice(idx, 1);
  }
  if (averagePool !== null) {
    // The average is unchanged by a sale: every lot still open is restated at that cost per coin. The pool's cost left is
    // exactly what it had less what this sale took, so the rounding remainder goes to the last lot and nothing drifts.
    if (averagePool.cost === null) {
      for (const lot of open) lot.remainingCost = null;
    } else {
      const taken = matches.reduce((sum, x) => sum + (x.costUsd ?? 0n), 0n);
      let left = averagePool.cost - taken;
      const pool = { qty: averagePool.qty, cost: averagePool.cost };
      open.forEach((lot, i) => {
        const part = i === open.length - 1 ? left : share(pool.cost, pool.qty, lot.remaining);
        lot.remainingCost = part;
        if (poolEntered) lot.customerEntered = true;
        left -= part;
      });
    }
  }
  if (unranked) for (const lot of open) lot.remainingCost = null;
  if (remaining > 0n && open.length === 0) residuals.add(TAX_LOT_UNDERFLOW);

  const covered = remaining === 0n && !unknown;
  const sum = (pickOf: (x: LotMatch) => Amount | null): Amount | null => {
    let total = 0n;
    for (const x of matches) {
      const v = pickOf(x);
      if (v === null) return null;
      total += v;
    }
    return total;
  };
  const costUsd = covered ? sum((x) => x.costUsd) : null;
  return {
    rule,
    pickedLotId: picked === null ? null : picked.lot.id,
    assetId: m.assetId,
    txId: m.txId,
    postedAt: m.postedAt,
    qty: m.qty,
    unmatchedQty: remaining,
    proceedsUsd: m.proceedsUsd,
    costUsd,
    realizedUsd: costUsd === null || m.proceedsUsd === null ? null : m.proceedsUsd - costUsd,
    matches,
  };
}
