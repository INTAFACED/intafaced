/**
 * The replay of one journal trade (J-charts-desk-20), worked from the record `TRADE_JOURNAL_REPLAY`: the venue's bars
 * as the chart draws them, and the trade's marks, each on the bar its moment falls in. A mark is shown only once the
 * replay has reached its bar, so nothing from later than the replay's place is ever drawn.
 */
import type { TradeReplay } from '@intafaced/contracts/trade-journal-procedures';
import type { Candle } from '../../../data/types';

/** One bar's length in milliseconds, by the venue's interval names. */
const STEP_MS: Readonly<Record<string, number>> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
};

export type ReplayMarkKind = 'entry' | 'stop' | 'stop-moved' | 'exit';

export interface ReplayMark {
  readonly kind: ReplayMarkKind;
  readonly price: string;
  /** The open time (ms) of the bar the mark is drawn on. */
  readonly bar: number;
}

export interface ReplayPlan {
  readonly bars: readonly Candle[];
  /** Index into `bars` the replay starts at: 10 bars before the entry bar. */
  readonly start: number;
  readonly entryIndex: number;
  /** Every mark of the trade, in the order they happened. */
  readonly marks: readonly ReplayMark[];
  /** The open time of the bar the exit falls in: the stop line ends there. */
  readonly exitBar: number;
}

/** The bar's open time `at` (ms) falls in, on bars of `stepMs`. */
const barOf = (at: number, stepMs: number) => Math.floor(at / stepMs) * stepMs;

/** The plan of a replay with venue bars; `null` when the record has none (the venue no longer returns them). */
export function replayPlan(replay: TradeReplay): ReplayPlan | null {
  if (replay.bars.source === 'none') return null;
  const step = STEP_MS[replay.interval];
  if (step === undefined) return null;
  const bars: Candle[] = replay.bars.candles.map((c) => ({
    t: Date.parse(c.openAt),
    o: c.openPrice,
    h: c.highPrice,
    l: c.lowPrice,
    c: c.closePrice,
    v: c.baseVolume,
    filled: false,
  }));
  const { trade } = replay;
  const entryBar = barOf(Date.parse(trade.openedAt), step);
  const exitBar = barOf(Date.parse(trade.closedAt), step);
  const marks: ReplayMark[] = [{ kind: 'entry', price: trade.entryPrice, bar: entryBar }];
  replay.stops.forEach((s, i) => {
    // A stop placed with the entry order (before its fill) stands from the entry bar.
    const bar = Math.max(entryBar, barOf(Date.parse(s.placedAt), step));
    marks.push({ kind: i === 0 ? 'stop' : 'stop-moved', price: s.price, bar });
  });
  marks.push({ kind: 'exit', price: trade.exitPrice, bar: exitBar });
  return { bars, start: replay.bars.startIndex, entryIndex: replay.bars.entryIndex, marks, exitBar };
}

/** The marks shown once the replay has drawn up to the bar opening at `last` (ms): none from a later bar. */
export function marksShown(plan: ReplayPlan, last: number): readonly ReplayMark[] {
  return plan.marks.filter((m) => m.bar <= last);
}

/** Where the stop stands on the bar opening at `bar`: the latest stop placed by then; `null` before the first or after the exit. */
export function stopOn(plan: ReplayPlan, bar: number): string | null {
  if (bar > plan.exitBar) return null;
  let price: string | null = null;
  for (const m of plan.marks) if ((m.kind === 'stop' || m.kind === 'stop-moved') && m.bar <= bar) price = m.price;
  return price;
}

/** The stop line over the bars drawn: one point per bar from the first stop's bar to the exit bar, at its price then. */
export function stopLine(plan: ReplayPlan, drawn: readonly Candle[]): { time: number; value: string }[] {
  return drawn.flatMap((bar) => {
    const price = stopOn(plan, bar.t);
    return price === null ? [] : [{ time: bar.t, value: price }];
  });
}
