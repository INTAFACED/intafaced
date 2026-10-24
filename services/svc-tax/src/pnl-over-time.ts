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
 * The change over the range is the sales made in it plus the change in what the open lots were worth less their cost:
 * the same as cumulative at the end less at the start whenever both are known, and still known when an older sale's
 * result is not. It is split three ways that add up to it exactly (refused if they do not): by coin, by market (each
 * market's sales in the range, plus `held`: the price move on what is held), and by day. A row that cannot be known
 * (a day with no price) is null, and then that split does not add up.
 */

export const HELD_KEY = 'held';
/** A withdrawal counted as a sale (transfers on) has no market: it is listed as `moved:<coin>`. */
export const MOVED_KEY_PREFIX = 'moved:';
/** A coin traded for another coin: the fill does not say which way round the market is listed, so none is named. */
export const SWAP_KEY_PREFIX = 'swap:';

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
const plus = (a: Amount | null, b: Amount | null): Amount | null => (a === null || b === null ? null : a + b);
const at = (iso: string) => new Date(iso).getTime();

/** A lot as the timeline reads it: parsed once. */
interface TimelineLot {
  readonly assetId: string;
  /** When it reached the main account: its purchase, or the move that carried it back. */
  readonly arrived: number;
  readonly qty: Amount;
  readonly cost: Amount | null;
}

/** What took coins out of a main-account lot: a sale's part or a move to a space. */
interface Draw {
  readonly lotId: string;
  readonly when: number;
  readonly qty: Amount;
  readonly cost: Amount | null;
}

interface TimelineSale {
  readonly assetId: string;
  readonly when: number;
  readonly realized: Amount | null;
  readonly marketKey: string;
}

/** What the figures at a moment are built from: the book's lots and sales, parsed once and keyed for lookups. */
export class BookTimeline {
  private readonly lots = new Map<string, TimelineLot>();
  private readonly draws: Draw[] = [];
  private readonly assets: readonly string[];
  /** The counted sales, oldest first. */
  private readonly sales: TimelineSale[] = [];
  private readonly fees: Array<{ when: number; usd: Amount | null }> = [];
  /** Coins the book could not reconcile (coins came or went in a way it cannot see): unknown at every moment. */
  private readonly unknown: ReadonlySet<string>;

  constructor(book: LotBook) {
    this.unknown = new Set(book.outsideAssets ?? []);
    // The main account only, and only what counts: the same lots the book's own unrealised figure counts.
    for (const lot of book.lots) {
      if (lot.spaceId !== undefined || !lot.counted || PAR_ASSETS.has(lot.assetId.toUpperCase())) continue;
      this.lots.set(lot.id, {
        assetId: lot.assetId,
        arrived: at(lot.carriedFrom?.movedAt ?? lot.acquiredAt),
        qty: parseAmount(lot.qty),
        cost: num(lot.costUsd),
      });
    }
    const feeUsd = (fee: LotBook['sales'][number]['fee']): Amount | null =>
      fee === undefined ? 0n : fee.status === 'known' ? (fee.usd === null ? null : parseAmount(fee.usd)) : null;
    for (const sale of book.sales) {
      const when = at(sale.disposedAt);
      // What sales took from those lots, counted or not: a left-out withdrawal still took the coins.
      for (const m of sale.matches) {
        if (this.lots.has(m.lotId)) this.draws.push({ lotId: m.lotId, when, qty: parseAmount(m.qty), cost: num(m.costUsd) });
      }
      if (sale.counted === 'none') continue;
      const marketKey = sale.market ?? (sale.kind === 'sale' ? `${SWAP_KEY_PREFIX}${sale.assetId}` : `${MOVED_KEY_PREFIX}${sale.assetId}`);
      this.sales.push({ assetId: sale.assetId, when, realized: num(sale.realizedUsd), marketKey });
      if (sale.kind === 'sale') this.fees.push({ when, usd: feeUsd(sale.fee) });
    }
    // What moves carried out of those lots (to a space): the carried lot names the lot it came from.
    for (const carried of book.lots) {
      const from = carried.carriedFrom;
      if (from === undefined || !this.lots.has(from.lotId)) continue;
      this.draws.push({ lotId: from.lotId, when: at(from.movedAt), qty: parseAmount(carried.qty), cost: num(carried.costUsd) });
    }
    for (const lot of book.lots) {
      if (!this.lots.has(lot.id) || lot.source !== 'trade' || lot.carriedFrom !== undefined) continue;
      this.fees.push({ when: at(lot.acquiredAt), usd: feeUsd(lot.fee) });
    }
    this.sales.sort((a, b) => a.when - b.when);
    const assets = new Set<string>([...this.lots.values()].map((lot) => lot.assetId));
    for (const sale of this.sales) assets.add(sale.assetId);
    this.assets = [...assets].sort();
  }

  coins(): readonly string[] {
    return this.assets;
  }

  /**
   * The counted main-account position in each coin at T. The cost is pooled per coin (an average-cost sale takes the
   * pool's cost, not one lot's), but a lot with no known cost makes it unknown only while some of that lot is open.
   */
  positionsAt(time: Date): Map<string, Position> {
    const t = time.getTime();
    const left = new Map<string, Amount>();
    const out = new Map<string, Position>();
    const pool = (assetId: string) => {
      const p = out.get(assetId) ?? { qty: 0n, cost: 0n };
      out.set(assetId, p);
      return p;
    };
    for (const [id, lot] of this.lots) {
      if (lot.arrived > t) continue;
      left.set(id, lot.qty);
      const p = pool(lot.assetId);
      p.qty += lot.qty;
      if (lot.cost !== null) p.cost = plus(p.cost, lot.cost);
    }
    for (const draw of this.draws) {
      const remaining = left.get(draw.lotId);
      if (draw.when > t || remaining === undefined) continue;
      left.set(draw.lotId, remaining - draw.qty);
      const lot = this.lots.get(draw.lotId)!;
      const p = pool(lot.assetId);
      p.qty -= draw.qty;
      // A draw from a lot with no cost takes none from the pool; one from a costed lot with no cost leaves it unknown.
      if (lot.cost !== null) p.cost = sub(p.cost, draw.cost);
    }
    for (const [id, remaining] of left) {
      const lot = this.lots.get(id)!;
      if (lot.cost === null && remaining !== 0n) pool(lot.assetId).cost = null;
    }
    for (const [assetId, p] of out) if (p.qty === 0n && p.cost !== null) out.set(assetId, { qty: 0n, cost: 0n });
    return out;
  }

  isUnknown(assetId: string): boolean {
    return this.unknown.has(assetId);
  }

  /** The realised result of each coin's counted sales in (after, T]: all of them by T when `after` is null. */
  realizedBy(time: Date, after: Date | null = null): Map<string, Amount | null> {
    return this.realizedIn(after, time, (sale) => sale.assetId);
  }

  /** The counted sales in (after, at], by market: a withdrawal under `moved:<coin>`, a coin-for-coin swap under `swap:<coin>`. */
  realizedByMarket(after: Date, time: Date): Map<string, Amount | null> {
    return this.realizedIn(after, time, (sale) => sale.marketKey);
  }

  private realizedIn(after: Date | null, time: Date, keyOf: (sale: TimelineSale) => string): Map<string, Amount | null> {
    const t = time.getTime();
    const a = after === null ? -Infinity : after.getTime();
    const out = new Map<string, Amount | null>();
    for (const sale of this.sales) {
      if (sale.when > t) break;
      if (sale.when <= a) continue;
      const key = keyOf(sale);
      out.set(key, plus(out.has(key) ? out.get(key)! : 0n, sale.realized));
    }
    return out;
  }

  /** Trading fees inside the figures for what happened in (after, at]: counted sales' fees and bought lots' fees. */
  feesIn(after: Date, time: Date): Amount | null {
    let total: Amount | null = 0n;
    for (const fee of this.fees) if (fee.when > after.getTime() && fee.when <= time.getTime()) total = plus(total, fee.usd);
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
  /** The book's timeline, when the caller already built it. */
  readonly timeline?: BookTimeline;
}

export function pnlOverTime(input: PnlInputs): PnlOverTime {
  const { book, from, to, now, interval, utcOffsetMinutes } = input;
  if (!(from.getTime() < to.getTime())) throw new TaxError(TAX_PNL_RANGE_INVALID, 'the range must start before it ends');
  const timeline = input.timeline ?? new BookTimeline(book);
  const coins = timeline.coins();
  const liveEnd = to.getTime() >= now.getTime();

  // A day edge is often a point too: each moment is worked out once.
  const seen = new Map<number, Map<string, CoinAt>>();
  const coinsAt = (time: Date): Map<string, CoinAt> => {
    const cached = seen.get(time.getTime());
    if (cached) return cached;
    const live = liveEnd && time.getTime() === to.getTime();
    const positions = timeline.positionsAt(time);
    const realized = timeline.realizedBy(time);
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
        const price = series === null ? null : closeAt(series, interval, time, live);
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
    seen.set(time.getTime(), out);
    return out;
  };

  const totals = (byCoin: Map<string, CoinAt>) => {
    let realized: Amount | null = 0n;
    let unrealized: Amount | null = 0n;
    const missing: Missing[] = [];
    for (const c of byCoin.values()) {
      realized = plus(realized, c.realized);
      unrealized = plus(unrealized, c.unrealized);
      if (c.missing !== null) missing.push(c.missing);
    }
    return { realized, unrealized, total: plus(realized, unrealized), missing };
  };

  /**
   * What each coin made between two moments: its sales in between, plus the change in what its open lots were worth
   * less their cost. An old sale with an unknown result leaves the cumulative line unknown but not this.
   */
  const changeBetween = (a: Date, b: Date): Map<string, Amount | null> => {
    const atA = coinsAt(a);
    const atB = coinsAt(b);
    const sold = timeline.realizedBy(b, a);
    const out = new Map<string, Amount | null>();
    for (const assetId of coins) {
      if (timeline.isUnknown(assetId)) {
        out.set(assetId, null);
        continue;
      }
      const inRange = sold.has(assetId) ? sold.get(assetId)! : 0n;
      out.set(assetId, plus(inRange, sub(atB.get(assetId)!.unrealized, atA.get(assetId)!.unrealized)));
    }
    return out;
  };
  const totalOf = (parts: Map<string, Amount | null>): Amount | null => [...parts.values()].reduce<Amount | null>(plus, 0n);

  // A book that is incomplete cannot say what was open when: every figure from it is unknown.
  const blank = book.residuals.includes('tax.lot_book_incomplete');
  const points = samplesOf(from, to, interval).map((time) => {
    const t = totals(coinsAt(time));
    return {
      at: time.toISOString(),
      totalUsd: blank || t.total === null ? null : formatAmount(t.total),
      realizedUsd: blank || t.realized === null ? null : formatAmount(t.realized),
      unrealizedUsd: blank || t.unrealized === null ? null : formatAmount(t.unrealized),
      missing: t.missing,
    };
  });

  const parts = changeBetween(from, to);
  const period = blank ? null : totalOf(parts);

  // By coin: each coin's own part.
  const byAsset = coins.map((assetId) => ({ key: assetId, usd: blank ? null : parts.get(assetId)! }));

  // By market: the sales made in the range, each under its market, and the price move on what is held.
  const startT = totals(coinsAt(from));
  const endT = totals(coinsAt(to));
  const markets = timeline.realizedByMarket(from, to);
  const byMarket = [...markets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, usd]) => ({ key, usd: blank ? null : usd }));
  byMarket.push({ key: HELD_KEY, usd: blank ? null : sub(endT.unrealized, startT.unrealized) });

  // By day: the change over each day between the customer's midnights. The days telescope to the period.
  let byDay: Array<{ key: string; usd: Amount | null }> | null = null;
  const edges = dayEdges(from, to, utcOffsetMinutes);
  if (edges.length + 1 <= MAX_BREAKDOWN_DAYS) {
    const marks = [from, ...edges, to];
    byDay = [];
    for (let i = 1; i < marks.length; i++) {
      byDay.push({
        key: dayKey(marks[i - 1]!, utcOffsetMinutes),
        usd: blank ? null : totalOf(changeBetween(marks[i - 1]!, marks[i]!)),
      });
    }
  }

  // Each way of splitting must add up to the period exactly; a split with a row not known cannot, and says so by the null.
  if (period !== null) {
    for (const [name, rows] of [
      ['coin', byAsset],
      ['market', byMarket],
      ['day', byDay ?? []],
    ] as const) {
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
