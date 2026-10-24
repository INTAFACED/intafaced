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
 *
 * OWN-ACCOUNT CARRY (LB-6). Lots sit in the customer's main account or in one of their spaces. A move between two of the
 * customer's own accounts in one transaction is not a sale and not a new arrival: it takes the open lots the method in force
 * would draw on next (under AVERAGE, quantity oldest first at the average cost, which leaves the average unchanged), and each
 * part it takes becomes a lot in the account it reached with the same acquired date, source and share of basis (`carriedFrom`
 * names the lot it came from). Sales are trades, and trades happen in the main account, so a sale
 * draws on main-account lots only. A move with too few open coins behind it carries what there is; the rest arrives with
 * no basis, named.
 *
 * MOVED OUT (LB-4). A withdrawal to outside is a disposal from the main account like a sale, matched by the method in force,
 * with the value when it left as its proceeds. It is not a sale: the lot book says whether it counts.
 *
 * KEPT APART. When the customer leaves deposits and withdrawals out of their figures, the lots that came in from outside are
 * a pool of their own in the main account: a sale draws on the other lots first (ranked, averaged and picked among them
 * alone) and reaches the lots kept apart only for quantity the others do not cover, and a withdrawal does the reverse. So a
 * deposit's cost never reaches the cost of a trade, under any method, and coins in and out of the platform net first.
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
  /** The space it arrived in; absent or null: the main account. */
  readonly space?: string | null;
}

export interface EngineDispose {
  readonly side: 'dispose';
  readonly txId: string;
  readonly postedAt: Date;
  readonly assetId: string;
  readonly qty: Amount;
  readonly proceedsUsd: Amount | null;
  /** `moved_out`: a withdrawal to outside, drawn by the method in force (a lot pick is for a sale only). Absent: a sale. */
  readonly kind?: 'sale' | 'moved_out';
}

/** A move of the customer's own coins between two of their accounts in one transaction. Null: the main account. */
export interface EngineMove {
  readonly side: 'move';
  readonly txId: string;
  readonly postedAt: Date;
  readonly assetId: string;
  readonly qty: Amount;
  readonly from: string | null;
  readonly to: string | null;
}

export type EngineMovement = EngineAcquire | EngineDispose | EngineMove;

/** The lot a carried lot was split from, and the move that carried it. */
export interface CarriedFrom {
  readonly lotId: string;
  readonly txId: string;
  readonly movedAt: Date;
}

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
  readonly source: MethodSource;
}

/** Where a sale's method came from, most specific first. `preview`: one method asked for every sale. */
export type MethodSource = 'preview' | 'day' | 'asset' | 'account' | 'default';

export type SaleRules = EngineMethod | ((sale: EngineDispose) => SaleRule);

export interface EngineSale {
  readonly kind: 'sale' | 'moved_out';
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
  /** The lot id that price is stored under, when it is another lot's (a carried lot keeps the price of the lot it left). */
  readonly priceLotId?: string;
  /** The space the lot sits in; null: the main account. */
  readonly space: string | null;
  /** Present when the lot was carried in by a move between the customer's own accounts. */
  readonly carriedFrom?: CarriedFrom;
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
  readonly lot: Omit<EngineLot, 'remaining' | 'remainingCostUsd' | 'customerEntered' | 'priceLotId'>;
  remaining: Amount;
  remainingCost: Amount | null;
  customerEntered: boolean;
  /** The lot id the customer's price is stored under, when this lot's cost came from exactly one such price. */
  priceLotId: string | null;
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
  /** Lot sources kept in a pool of their own (KEPT APART); absent: one pool. */
  apart?: ReadonlySet<LotSource>,
): EngineRun {
  const ruleOf = typeof rules === 'string' ? (): SaleRule => ({ method: rules, source: 'default' }) : rules;
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
    // Same instant: arrivals, then moves, then departures, so a fill that buys and a sale in one transaction keep their order.
    list.sort(
      (a, b) => a.postedAt.getTime() - b.postedAt.getTime() || SIDE_ORDER[a.side] - SIDE_ORDER[b.side] || a.txId.localeCompare(b.txId),
    );
    // Open lots per account, oldest first. `MAIN` is the main account.
    const openIn = new Map<string, OpenLot[]>();
    const openAt = (space: string | null | undefined): OpenLot[] => {
      const key = space ?? MAIN;
      let list = openIn.get(key);
      if (!list) {
        list = [];
        openIn.set(key, list);
      }
      return list;
    };
    const all: OpenLot[] = [];
    const nextId = (base: string): string => {
      let id = base;
      for (let n = 2; usedIds.has(id); n++) id = `${base}:${n}`;
      usedIds.add(id);
      return id;
    };
    for (const m of list) {
      if (m.side === 'move') {
        // A move uses the method a sale at that moment would (a pick is for a sale, so none applies to a move).
        const { method } = ruleOf({
          side: 'dispose',
          txId: m.txId,
          postedAt: m.postedAt,
          assetId: m.assetId,
          qty: m.qty,
          proceedsUsd: null,
        });
        all.push(...carry(m, method, openAt(m.from), openAt(m.to), nextId, residuals, overridePricePerUnit));
        continue;
      }
      if (m.side === 'acquire') {
        // Two arrivals of one coin in one transaction get `:2`, `:3` in history order, so ids stay unique and repeatable.
        const id = nextId(lotIdOf(m.txId, m.assetId));
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
            space: m.space ?? null,
          },
          remaining: m.qty,
          remainingCost: costUsd,
          customerEntered: entered,
          priceLotId: entered ? id : null,
        };
        openAt(m.space).push(entry);
        all.push(entry);
        continue;
      }
      const rule = ruleOf(m);
      // A withdrawal draws by the method in force; a lot picked for a sale does not apply to it.
      sales.push(dispose(m, openAt(null), m.kind === 'moved_out' ? { method: rule.method, source: rule.source } : rule, residuals, apart));
    }
    for (const entry of all) {
      lots.push({
        ...entry.lot,
        remaining: entry.remaining,
        remainingCostUsd: entry.remaining === 0n ? 0n : entry.remainingCost,
        ...(entry.customerEntered ? { customerEntered: true as const } : {}),
        ...(entry.customerEntered && entry.priceLotId !== null && entry.priceLotId !== entry.lot.id
          ? { priceLotId: entry.priceLotId }
          : {}),
      });
      if (entry.remaining > 0n && entry.remainingCost === null) residuals.add(TAX_COST_BASIS_UNAVAILABLE);
    }
  }
  lots.sort((a, b) => a.acquiredAt.getTime() - b.acquiredAt.getTime() || a.id.localeCompare(b.id));
  sales.sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime() || a.txId.localeCompare(b.txId));
  return { lots, sales, residuals: [...residuals].sort() };
}

const MAIN = '';
const SIDE_ORDER: Record<EngineMovement['side'], number> = { acquire: 0, move: 1, dispose: 2 };

/**
 * One own-account move: open lots leave `from` oldest first, and each part taken arrives in `to` as a lot with the same
 * acquired date, source and share of basis. The lot it left keeps its history with less remaining. Quantity no open lot
 * covered arrives with no basis (source `transfer_in`), so the lots in `to` still add up to what was moved.
 */
function carry(
  m: EngineMove,
  method: EngineMethod,
  from: OpenLot[],
  to: OpenLot[],
  nextId: (base: string) => string,
  residuals: Set<string>,
  overridePricePerUnit?: ReadonlyMap<string, Amount>,
): OpenLot[] {
  const made: OpenLot[] = [];
  let remaining = m.qty;
  const arrive = (entry: OpenLot) => {
    // Keep the destination oldest first, so a later move or sale there draws in acquired order.
    let at = to.length;
    while (at > 0 && to[at - 1]!.lot.acquiredAt.getTime() > entry.lot.acquiredAt.getTime()) at--;
    to.splice(at, 0, entry);
    made.push(entry);
  };
  // AVERAGE: what moves goes at the account's average cost per coin, and what stays keeps that average, so a move changes no
  // later figure. The other methods move the lots the method would draw on next.
  const pool = method === 'AVERAGE' ? averagePoolOf(from) : null;
  let unranked = false;
  let taken = 0n;
  while (remaining > 0n && from.length > 0) {
    let idx = method === 'LIFO' ? from.length - 1 : method === 'HIFO' ? pick(from, 'HIFO') : 0;
    if (idx === null) {
      // HIFO cannot rank a lot with no basis: which coins moved is not known, so neither is the cost of any of them.
      unranked = true;
      residuals.add(TAX_COST_BASIS_UNAVAILABLE);
      idx = 0;
    }
    const lot = from[idx]!;
    const take = remaining < lot.remaining ? remaining : lot.remaining;
    const id = nextId(`${lot.lot.id}>${m.txId}`);
    const own = unranked
      ? null
      : pool !== null
        ? pool.cost === null
          ? null
          : share(pool.cost, pool.qty, take)
        : lot.remainingCost === null
          ? null
          : share(lot.remainingCost, lot.remaining, take);
    // A carried part with no basis takes a price the customer entered for it, the same as any lot with no cost.
    const price = own === null ? overridePricePerUnit?.get(id) : undefined;
    const entered = price !== undefined && price > 0n;
    const cost = entered ? mul(price, take) : own;
    const valuedAt = lot.lot.valuedAt === null ? null : { ...lot.lot.valuedAt, usd: share(lot.lot.valuedAt.usd, lot.lot.qty, take) };
    const inherited = !entered && own !== null && (lot.customerEntered || (pool?.entered ?? false));
    arrive({
      lot: {
        ...lot.lot,
        id,
        qty: take,
        costUsd: cost,
        valuedAt,
        space: m.to,
        carriedFrom: { lotId: lot.lot.id, txId: m.txId, movedAt: m.postedAt },
      },
      remaining: take,
      remainingCost: cost,
      customerEntered: entered || inherited,
      priceLotId: entered ? id : inherited && pool === null ? lot.priceLotId : null,
    });
    if (own !== null) taken += own;
    if (pool === null) lot.remainingCost = lot.remainingCost === null || own === null ? null : lot.remainingCost - own;
    lot.remaining -= take;
    remaining -= take;
    if (lot.remaining === 0n) from.splice(idx, 1);
  }
  if (pool !== null) restateAtAverage(from, pool, taken);
  if (unranked) for (const lot of from) lot.remainingCost = null;
  if (remaining > 0n) {
    const id = nextId(lotIdOf(m.txId, m.assetId));
    const price = overridePricePerUnit?.get(id);
    const entered = price !== undefined && price > 0n;
    const cost = entered ? mul(price, remaining) : null;
    arrive({
      lot: {
        id,
        assetId: m.assetId,
        acquiredAt: m.postedAt,
        acquireTxId: m.txId,
        source: 'transfer_in',
        reason: 'own_account.move',
        qty: remaining,
        costUsd: cost,
        valuedAt: null,
        space: m.to,
      },
      remaining,
      remainingCost: cost,
      customerEntered: entered,
      priceLotId: entered ? id : null,
    });
  }
  return made;
}

/** One cost per coin for the whole open quantity; null when any open lot has no basis. */
function averagePoolOf(open: readonly OpenLot[]): { qty: Amount; cost: Amount | null; entered: boolean } {
  let qty = 0n;
  let cost: Amount | null = 0n;
  for (const lot of open) {
    qty += lot.remaining;
    cost = cost === null || lot.remainingCost === null ? null : cost + lot.remainingCost;
  }
  return { qty, cost, entered: cost !== null && open.some((lot) => lot.customerEntered) };
}

/**
 * The average is unchanged by what left: every lot still open is restated at that cost per coin. The pool's cost left is
 * exactly what it had less what was taken, so the rounding remainder goes to the last lot and nothing drifts.
 */
function restateAtAverage(open: readonly OpenLot[], pool: { qty: Amount; cost: Amount | null; entered: boolean }, taken: Amount): void {
  if (pool.cost === null) {
    for (const lot of open) lot.remainingCost = null;
    return;
  }
  const total = pool.cost;
  let left = total - taken;
  open.forEach((lot, i) => {
    const part = i === open.length - 1 ? left : share(total, pool.qty, lot.remaining);
    lot.remainingCost = part;
    if (pool.entered) lot.customerEntered = true;
    left -= part;
  });
}

function dispose(m: EngineDispose, open: OpenLot[], rule: SaleRule, residuals: Set<string>, apart?: ReadonlySet<LotSource>): EngineSale {
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

  // KEPT APART: a sale draws on the lots not kept apart first, a withdrawal on the lots kept apart first. One pool otherwise.
  const keptApart = (lot: OpenLot) => apart !== undefined && apart.has(lot.lot.source);
  const firstApart = m.kind === 'moved_out';
  const pools =
    apart === undefined
      ? [open.slice()]
      : [open.filter((l) => keptApart(l) === firstApart), open.filter((l) => keptApart(l) !== firstApart)];

  for (const pool of pools) {
    if (remaining === 0n) break;
    let unranked = false;
    // AVERAGE: one cost per coin for the whole open quantity of this pool, fixed for this sale.
    const averagePool = method === 'AVERAGE' ? averagePoolOf(pool) : null;
    const poolEntered = averagePool?.entered ?? false;
    let drew = false;
    let takenCost = 0n;

    while (remaining > 0n && pool.length > 0) {
      drew = true;
      const pickedAt = picked === null ? -1 : pool.indexOf(picked);
      let idx = pickedAt >= 0 ? pickedAt : pick(pool, method);
      if (idx === null) {
        // HIFO cannot rank a lot with no basis. The coins still left: draw the quantity oldest first so the open quantity stays
        // right, but which lot really went is not known, so this sale's cost and the cost of every lot left are unknown.
        unknown = true;
        unranked = true;
        residuals.add(TAX_COST_BASIS_UNAVAILABLE);
        idx = 0;
      }
      const lot = pool[idx]!;
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
      takenCost += cost ?? 0n;
      if (proceedsLeft !== null && proceeds !== null) proceedsLeft -= proceeds;
      // Under AVERAGE the lots left are restated at the pool's cost per coin after the loop.
      if (averagePool === null) lot.remainingCost = lot.remainingCost === null || cost === null ? null : lot.remainingCost - cost;
      lot.remaining -= take;
      if (lot.remaining === 0n) pool.splice(idx, 1);
    }
    if (drew && averagePool !== null) {
      restateAtAverage(pool, averagePool, takenCost);
    }
    if (unranked) for (const lot of pool) lot.remainingCost = null;
  }
  // What was used up leaves the account's open lots (the pools were copies of it).
  for (let i = open.length - 1; i >= 0; i--) if (open[i]!.remaining === 0n) open.splice(i, 1);
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
    kind: m.kind ?? 'sale',
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
