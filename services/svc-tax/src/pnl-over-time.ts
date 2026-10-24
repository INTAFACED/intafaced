import { formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import { PNL_BREAKDOWN_MAX_DAYS, type PnlOverTime, type PnlSeriesInterval } from '@intafaced/contracts/tax-lot-book';
import { PAR_ASSETS, type LotBook } from './lot-book.js';
import { SERIES_TIMEFRAME_MS, type CloseSeries } from './prices.js';
import { TaxError, TAX_PNL_BREAKDOWN_MISMATCH, TAX_PNL_RANGE_INVALID } from './codes.js';

/**
 * PROFIT AND LOSS OVER TIME (J-portfolio-05 #4-#5), worked out from the finished lot book, never stored.
 *
 * The cumulative result at a moment T is what the indicator would have said at T:
 *
 *   realised(T)   = the result of every counted sale made by T (the book matches each sale with only what came
 *                   before it, so a sale's result does not change with what came later);
 *   unrealised(T) = for each coin, what the counted main-account lots open at T were worth at T, less their cost.
 *
 * The lots open at T are rebuilt from the book itself: each lot from when it reached the main account (its purchase,
 * or the move that carried it back), less what sales and moves had taken from it by T. That is the same pool cost
 * whatever the method, because every sale's part records the cost it took. At the book's own time this lands on the
 * book's open lots exactly (the tests hold it to that).
 *
 * The price at T is the close of the last candle that had ended by T, on the coin's USDT market, else USDC; only the
 * range's last moment, when it is now, may use the candle still open (its close is the latest trade). A moment where a
 * coin held then has no price, or a cost or a sale result is unknown, is missing: null with what is missing named.
 *
 * The breakdown splits the change over the range three ways that add up to it exactly (refused if they do not):
 * by coin, by market (each market's sales in the range, plus `held`: the price move on what is held), and by day.
 */

export const HELD_KEY = 'held';

/** Most points a chart is drawn with, and most candles one read may span to now (svc-trade answers whole windows). */
const MAX_POINTS = 400;
const MAX_CANDLES_TO_NOW = 718;
/** Most days the by-day breakdown lists. Past it the rows are left out, and the answer says so. */
export const MAX_BREAKDOWN_DAYS = PNL_BREAKDOWN_MAX_DAYS;

const INTERVALS: readonly PnlSeriesInterval[] = ['5m', '1h', '4h', '1d', '1w'];

/** The finest candle size whose points fit a chart and whose window to now fits one read; null when none does. */
export function chooseInterval(from: Date, to: Date, now: Date): PnlSeriesInterval | null {
  const span = to.getTime() - from.getTime();
  const back = now.getTime() - from.getTime();
  for (const interval of INTERVALS) {
    const ms = SERIES_TIMEFRAME_MS[interval];
    if (span / ms <= MAX_POINTS && back / ms <= MAX_CANDLES_TO_NOW) return interval;
  }
  return null;
}

/** The moments drawn: `from`, every candle boundary strictly inside the range, and `to`. */
export function samplesOf(from: Date, to: Date, interval: PnlSeriesInterval): Date[] {
  const ms = SERIES_TIMEFRAME_MS[interval];
  const out = [from];
  for (let t = Math.floor(from.getTime() / ms) * ms + ms; t < to.getTime(); t += ms) out.push(new Date(t));
  if (to.getTime() > from.getTime()) out.push(to);
  return out;
}

/** Midnights in the customer's time zone strictly inside the range: the edges of the days of the breakdown. */
export function dayEdges(from: Date, to: Date, utcOffsetMinutes: number): Date[] {
  const shift = utcOffsetMinutes * 60_000;
  const day = 86_400_000;
  const out: Date[] = [];
  for (let local = Math.floor((from.getTime() + shift) / day) * day + day; local - shift < to.getTime(); local += day) {
    out.push(new Date(local - shift));
  }
  return out;
}

/** `YYYY-MM-DD` of the customer's day that starts at or contains `at`. */
function dayKey(at: Date, utcOffsetMinutes: number): string {
  return new Date(at.getTime() + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

interface Missing {
  readonly assetId: string;
  readonly reason: 'no_price' | 'cost_unknown';
}

/** One coin's figures at one moment: realised by then, and the open position's value less cost; null when unknown. */
interface CoinAt {
  readonly realized: Amount | null;
  readonly unrealized: Amount | null;
  readonly missing: Missing | null;
}

interface Position {
  qty: Amount;
  cost: Amount | null;
}

const num = (v: string | null | undefined): Amount | null => (v === null || v === undefined ? null : parseAmount(v));
const sub = (a: Amount | null, b: Amount | null): Amount | null => (a === null || b === null ? null : a - b);

/** What the figures at a moment are built from: the book's lots and sales, keyed for lookups. */
export class BookTimeline {
  private readonly lots: LotBook['lots'];
  private readonly mainLotIds: ReadonlySet<string>;
  private readonly assets: readonly string[];
  private readonly sales: LotBook['sales'];
  /** Every lot of the book, spaces included: a move out of the main account is found on the lot it made. */
  private readonly allLots: LotBook['lots'];
  /** Coins the book could not reconcile (coins came or went in a way it cannot see): unknown at every moment. */
  private readonly unknown: ReadonlySet<string>;

  constructor(book: LotBook) {
    this.allLots = book.lots;
    this.unknown = new Set(
      book.residuals.includes('tax.lot_book_unreconciled')
        ? book.assets.filter((a) => a.openCostUsd === null && parseAmount(a.openQty) > 0n).map((a) => a.assetId)
        : [],
    );
    // The main account only, and only what counts: the same lots the book's own unrealised figure counts.
    this.lots = book.lots.filter((lot) => lot.spaceId === undefined && lot.counted && !PAR_ASSETS.has(lot.assetId.toUpperCase()));
    this.mainLotIds = new Set(this.lots.map((lot) => lot.id));
    this.sales = book.sales;
    const assets = new Set<string>(this.lots.map((lot) => lot.assetId));
    for (const sale of book.sales) if (sale.counted !== 'none') assets.add(sale.assetId);
    this.assets = [...assets].sort();
  }

  coins(): readonly string[] {
    return this.assets;
  }

  /** The counted main-account position in each coin at T. */
  positionsAt(at: Date): Map<string, Position> {
    const t = at.getTime();
    const out = new Map<string, Position>();
    const add = (assetId: string, qty: Amount, cost: Amount | null) => {
      const p = out.get(assetId) ?? { qty: 0n, cost: 0n };
      p.qty += qty;
      p.cost = p.cost === null || cost === null ? null : p.cost + cost;
      out.set(assetId, p);
    };
    for (const lot of this.lots) {
      const arrived = new Date(lot.carriedFrom?.movedAt ?? lot.acquiredAt).getTime();
      if (arrived <= t) add(lot.assetId, parseAmount(lot.qty), num(lot.costUsd));
    }
    // What sales took from those lots by T, counted or not: a left-out withdrawal still took the coins.
    for (const sale of this.sales) {
      if (new Date(sale.disposedAt).getTime() > t) continue;
      for (const m of sale.matches) {
        if (!this.mainLotIds.has(m.lotId)) continue;
        const cost = num(m.costUsd);
        add(sale.assetId, -parseAmount(m.qty), cost === null ? null : -cost);
      }
    }
    // What moves carried out of those lots by T (to a space): the carried lot names the lot it came from.
    const byId = new Map(this.lots.map((lot) => [lot.id, lot]));
    for (const carried of this.allLots) {
      const from = carried.carriedFrom;
      if (from === undefined || !this.mainLotIds.has(from.lotId)) continue;
      if (new Date(from.movedAt).getTime() > t) continue;
      const source = byId.get(from.lotId)!;
      const cost = num(carried.costUsd);
      add(source.assetId, -parseAmount(carried.qty), cost === null ? null : -cost);
    }
    return out;
  }

  isUnknown(assetId: string): boolean {
    return this.unknown.has(assetId);
  }

  /** The realised result of each coin's counted sales made by T (inclusive), and of those in (after, T]. */
  realizedBy(at: Date, after: Date | null = null): Map<string, Amount | null> {
    const t = at.getTime();
    const out = new Map<string, Amount | null>();
    for (const sale of this.sales) {
      if (sale.counted === 'none') continue;
      const when = new Date(sale.disposedAt).getTime();
      if (when > t || (after !== null && when <= after.getTime())) continue;
      const prior = out.has(sale.assetId) ? out.get(sale.assetId)! : 0n;
      const r = num(sale.realizedUsd);
      out.set(sale.assetId, prior === null || r === null ? null : prior + r);
    }
    return out;
  }

  /** The counted sales in (after, at], by market. A sale with no market (a withdrawal) is under its coin's name. */
  realizedByMarket(after: Date, at: Date): Map<string, Amount | null> {
    const out = new Map<string, Amount | null>();
    for (const sale of this.sales) {
      if (sale.counted === 'none') continue;
      const when = new Date(sale.disposedAt).getTime();
      if (when <= after.getTime() || when > at.getTime()) continue;
      const key = sale.market ?? `${sale.assetId} moved out`;
      const prior = out.has(key) ? out.get(key)! : 0n;
      const r = num(sale.realizedUsd);
      out.set(key, prior === null || r === null ? null : prior + r);
    }
    return out;
  }

  /** Trading fees inside the figures for what happened in (after, at]: counted sales' fees and bought lots' fees. */
  feesIn(after: Date, at: Date): Amount | null {
    const inside = (iso: string) => {
      const t = new Date(iso).getTime();
      return t > after.getTime() && t <= at.getTime();
    };
    let total: Amount = 0n;
    const feeUsd = (fee: LotBook['sales'][number]['fee']): Amount | null =>
      fee === undefined ? 0n : fee.status === 'known' ? (fee.usd === null ? null : parseAmount(fee.usd)) : null;
    for (const sale of this.sales) {
      if (sale.kind !== 'sale' || sale.counted === 'none' || !inside(sale.disposedAt)) continue;
      const usd = feeUsd(sale.fee);
      if (usd === null) return null;
      total += usd;
    }
    for (const lot of this.lots) {
      if (lot.source !== 'trade' || lot.carriedFrom !== undefined || !inside(lot.acquiredAt)) continue;
      const usd = feeUsd(lot.fee);
      if (usd === null) return null;
      total += usd;
    }
    return total;
  }
}

/** The close of the last candle that had ended by T; the candle still open only when T is the live end of the range. */
export function closeAt(series: CloseSeries, interval: PnlSeriesInterval, at: Date, live: boolean): Amount | null {
  const ms = SERIES_TIMEFRAME_MS[interval];
  const t = at.getTime();
  let found: Amount | null = null;
  for (const [openAt, close] of series.candles) {
    if (openAt + ms <= t || (live && openAt <= t)) found = close;
    else if (openAt > t) break;
  }
  return found;
}

export interface PnlInputs {
  readonly book: LotBook;
  readonly from: Date;
  readonly to: Date;
  readonly now: Date;
  readonly interval: PnlSeriesInterval;
  readonly utcOffsetMinutes: number;
  /** Each coin's candles in the interval's size; null: the coin has no market. */
  readonly closes: ReadonlyMap<string, CloseSeries | null>;
}

export function pnlOverTime(input: PnlInputs): PnlOverTime {
  const { book, from, to, now, interval, utcOffsetMinutes } = input;
  if (!(from.getTime() < to.getTime())) throw new TaxError(TAX_PNL_RANGE_INVALID, 'the range must start before it ends');
  const timeline = new BookTimeline(book);
  const coins = timeline.coins();
  const liveEnd = to.getTime() >= now.getTime();

  const coinsAt = (at: Date): Map<string, CoinAt> => {
    const live = liveEnd && at.getTime() === to.getTime();
    const positions = timeline.positionsAt(at);
    const realized = timeline.realizedBy(at);
    const out = new Map<string, CoinAt>();
    for (const assetId of coins) {
      const r = realized.has(assetId) ? realized.get(assetId)! : 0n;
      const p = positions.get(assetId) ?? { qty: 0n, cost: 0n };
      let unrealized: Amount | null = 0n;
      if (timeline.isUnknown(assetId)) {
        out.set(assetId, { realized: null, unrealized: null, missing: { assetId, reason: 'cost_unknown' } });
        continue;
      }
      let missing: Missing | null = r === null ? { assetId, reason: 'cost_unknown' } : null;
      if (p.qty !== 0n) {
        const series = input.closes.get(assetId) ?? null;
        const price = series === null ? null : closeAt(series, interval, at, live);
        if (p.cost === null) {
          unrealized = null;
          missing = { assetId, reason: 'cost_unknown' };
        } else if (price === null) {
          unrealized = null;
          missing = missing ?? { assetId, reason: 'no_price' };
        } else unrealized = mul(p.qty, price) - p.cost;
      }
      out.set(assetId, { realized: r, unrealized, missing });
    }
    return out;
  };

  const totals = (byCoin: Map<string, CoinAt>) => {
    let realized: Amount | null = 0n;
    let unrealized: Amount | null = 0n;
    const missing: Missing[] = [];
    for (const c of byCoin.values()) {
      realized = realized === null || c.realized === null ? null : realized + c.realized;
      unrealized = unrealized === null || c.unrealized === null ? null : unrealized + c.unrealized;
      if (c.missing !== null) missing.push(c.missing);
    }
    const total = realized === null || unrealized === null ? null : realized + unrealized;
    return { realized, unrealized, total, missing };
  };

  // A book that is incomplete or did not reconcile cannot say what was open when: every figure from it is unknown.
  const blank = book.residuals.includes('tax.lot_book_incomplete');
  const points = samplesOf(from, to, interval).map((at) => {
    const t = totals(coinsAt(at));
    return {
      at: at.toISOString(),
      totalUsd: blank || t.total === null ? null : formatAmount(t.total),
      realizedUsd: blank || t.realized === null ? null : formatAmount(t.realized),
      unrealizedUsd: blank || t.unrealized === null ? null : formatAmount(t.unrealized),
      missing: t.missing,
    };
  });

  const start = coinsAt(from);
  const end = coinsAt(to);
  const startT = totals(start);
  const endT = totals(end);
  const period = blank ? null : sub(endT.total, startT.total);

  // By coin: each coin's own change, cumulative at `to` less at `from`.
  const byAsset = coins.map((assetId) => {
    const a = start.get(assetId)!;
    const b = end.get(assetId)!;
    const atA = a.realized === null || a.unrealized === null ? null : a.realized + a.unrealized;
    const atB = b.realized === null || b.unrealized === null ? null : b.realized + b.unrealized;
    return { key: assetId, usd: blank ? null : sub(atB, atA) };
  });

  // By market: the sales made in the range, each under its market, and the price move on what is held.
  const markets = timeline.realizedByMarket(from, to);
  const byMarket = [...markets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, usd]) => ({ key, usd: blank ? null : usd }));
  byMarket.push({ key: HELD_KEY, usd: blank ? null : sub(endT.unrealized, startT.unrealized) });

  // By day: cumulative at each midnight in the customer's time zone, differenced. The days telescope to the period.
  let byDay: Array<{ key: string; usd: Amount | null }> | null = null;
  const edges = dayEdges(from, to, utcOffsetMinutes);
  if (edges.length + 1 <= MAX_BREAKDOWN_DAYS) {
    const marks = [from, ...edges, to];
    const cumulative = marks.map((at, i) => (i === 0 ? startT.total : i === marks.length - 1 ? endT.total : totals(coinsAt(at)).total));
    byDay = [];
    for (let i = 1; i < marks.length; i++) {
      byDay.push({ key: dayKey(marks[i - 1]!, utcOffsetMinutes), usd: blank ? null : sub(cumulative[i]!, cumulative[i - 1]!) });
    }
  }

  // Each way of splitting must add up to the period exactly; parts that cannot be known leave the sum unknown.
  if (period !== null) {
    for (const [name, rows] of [
      ['coin', byAsset],
      ['market', byMarket],
      ['day', byDay ?? []],
    ] as const) {
      if (name === 'day' && byDay === null) continue;
      if (rows.some((r) => r.usd === null)) continue;
      const sum = rows.reduce((s, r) => s + (r.usd as Amount), 0n);
      if (sum !== period) throw new TaxError(TAX_PNL_BREAKDOWN_MISMATCH, `the ${name} breakdown does not add up to the period`);
    }
  }

  const fees = timeline.feesIn(from, to);
  const fmt = (rows: ReadonlyArray<{ key: string; usd: Amount | null }>) =>
    rows.map((r) => ({ key: r.key, usd: r.usd === null ? null : formatAmount(r.usd) }));
  return {
    indicator: 'indicator_not_tax_advice',
    from: from.toISOString(),
    to: to.toISOString(),
    interval,
    includeTransfers: book.includeTransfers,
    points,
    periodUsd: period === null ? null : formatAmount(period),
    feesUsd: fees === null ? null : formatAmount(fees),
    byAsset: fmt(byAsset),
    byMarket: fmt(byMarket),
    byDay: byDay === null ? null : fmt(byDay),
    utcOffsetMinutes,
    residuals: book.residuals,
  };
}
