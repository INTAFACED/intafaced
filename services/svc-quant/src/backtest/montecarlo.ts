import { add, div, formatAmount, mul, parseAmount, sub, type Amount } from '@intafaced/ledger-client/money';
import type { QuantBacktestTrade } from '@intafaced/contracts';
import { QUANT_MONTECARLO_TRADES_INSUFFICIENT, QuantError } from '../errors.js';

/**
 * Monte Carlo resampling of one finished bar backtest (RC-algo-dev-04; J-algo-dev-16 #3). The run's closed round trips
 * are drawn with replacement, `runs` times, by a seeded generator, so the same run, count and seed always give the same
 * distribution and another seed gives another. Each path starts at the run's starting cash and walks its drawn trips in
 * order; its largest fall from a peak and its final equity are kept, and a path that reaches the ruin level (the
 * strategy's equity-stop floor, AL-risk-01) counts as ruined. Every figure is simulated. Pure: reads nothing, writes
 * nothing; money stays scaled bigint and leaves as decimal strings.
 */

export const MONTE_CARLO_PERCENTILES = [5, 25, 50, 75, 95] as const;

export interface MonteCarloInput {
  readonly trades: readonly QuantBacktestTrade[];
  readonly startCash: string;
  /** The equity at or below which a path is ruined; null when the risk screen leaves the floor blank. */
  readonly ruinLevel: string | null;
  readonly runs: number;
  readonly seed: number;
  /** The fewest closed round trips a run must hold to be resampled (owner value). */
  readonly minTrades: number;
}

export interface MonteCarloResult {
  readonly runs: number;
  readonly seed: number;
  readonly roundTrips: number;
  readonly maxDrawdownPercent: Record<`p${(typeof MONTE_CARLO_PERCENTILES)[number]}`, string>;
  readonly finalEquity: Record<`p${(typeof MONTE_CARLO_PERCENTILES)[number]}`, string>;
  /** Percent of paths that reached the ruin level; null when the ruin level is not set. */
  readonly ruinProbabilityPercent: string | null;
  readonly ruinLevel: string | null;
}

/** A small, fast, seeded generator (mulberry32): the same seed always draws the same numbers. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The run's closed round trips, each one's net result: realised against the average entry price, less every fee of the
 * trip. A trip ends when the position is back to zero; a position still open at the end is not a closed trip.
 */
export function roundTripsOf(trades: readonly QuantBacktestTrade[]): Amount[] {
  const trips: Amount[] = [];
  let position = 0n; // signed quantity, scaled
  let cost = 0n; // signed entry cost of the open position, scaled
  let net = 0n; // the open trip's result so far
  for (const trade of trades) {
    const qty = parseAmount(trade.qty);
    const price = parseAmount(trade.price);
    const signed = trade.side === 'buy' ? qty : -qty;
    net = sub(net, parseAmount(trade.fee));
    const reducing = position !== 0n && position > 0n !== signed > 0n;
    if (!reducing) {
      position += signed;
      cost = add(cost, mul(signed, price));
      continue;
    }
    const closing = (signed < 0n ? -signed : signed) <= (position < 0n ? -position : position) ? signed : -position;
    // The closed part's share of the entry cost, at the average entry price.
    const entry = div(mul(cost < 0n ? -cost : cost, closing < 0n ? -closing : closing), position < 0n ? -position : position);
    const exit = mul(closing < 0n ? -closing : closing, price);
    net = add(net, position > 0n ? sub(exit, entry) : sub(entry, exit));
    cost = sub(cost, position > 0n ? entry : -entry);
    position += closing;
    if (position === 0n) {
      trips.push(net);
      net = 0n;
      cost = 0n;
      const rest = signed - closing;
      if (rest !== 0n) {
        // A flip: what is left of the order opens the next trip.
        position = rest;
        cost = mul(rest, price);
      }
    }
  }
  return trips;
}

function percentile(sorted: readonly Amount[], p: number): Amount {
  // Nearest rank: the smallest value with at least p percent of the paths at or below it.
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

const HUNDRED = parseAmount('100');

export function monteCarlo(input: MonteCarloInput): MonteCarloResult {
  const trips = roundTripsOf(input.trades);
  if (trips.length < input.minTrades || trips.length === 0) {
    throw new QuantError(
      QUANT_MONTECARLO_TRADES_INSUFFICIENT,
      `this run closed ${trips.length} round trip${trips.length === 1 ? '' : 's'}; resampling needs at least ${Math.max(1, input.minTrades)}`,
    );
  }
  const start = parseAmount(input.startCash);
  const ruin = input.ruinLevel === null ? null : parseAmount(input.ruinLevel);
  const draw = seeded(input.seed);
  const drawdowns: Amount[] = [];
  const finals: Amount[] = [];
  let ruined = 0;
  for (let path = 0; path < input.runs; path += 1) {
    let equity = start;
    let peak = start;
    let worst = 0n;
    let hit = ruin !== null && equity <= ruin;
    for (let i = 0; i < trips.length; i += 1) {
      equity = add(equity, trips[Math.floor(draw() * trips.length)]!);
      if (equity > peak) peak = equity;
      if (peak > 0n) {
        const fall = div(mul(sub(peak, equity), HUNDRED), peak);
        if (fall > worst) worst = fall;
      }
      if (ruin !== null && equity <= ruin) hit = true;
    }
    drawdowns.push(worst);
    finals.push(equity);
    if (hit) ruined += 1;
  }
  const byValue = (a: Amount, b: Amount) => (a < b ? -1 : a > b ? 1 : 0);
  drawdowns.sort(byValue);
  finals.sort(byValue);
  const table = (sorted: Amount[]) =>
    Object.fromEntries(
      MONTE_CARLO_PERCENTILES.map((p) => [`p${p}`, formatAmount(percentile(sorted, p))]),
    ) as MonteCarloResult['finalEquity'];
  return {
    runs: input.runs,
    seed: input.seed,
    roundTrips: trips.length,
    maxDrawdownPercent: table(drawdowns),
    finalEquity: table(finals),
    ruinProbabilityPercent:
      ruin === null ? null : formatAmount(div(mul(parseAmount(String(ruined)), HUNDRED), parseAmount(String(input.runs)))),
    ruinLevel: ruin === null ? null : formatAmount(ruin),
  };
}
