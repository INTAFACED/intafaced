/**
 * Turns one study instance and the chart's bars (plus any higher-timeframe bars or public trades it reads) into the series
 * to draw, the legend facts and the typed refusals. Pure: no React, no I/O.
 *
 * Rules every study follows:
 * - A blank input is a refusal (`enterPeriod`), never a default number.
 * - A value the bars cannot give is `null` and is drawn as a gap, never as zero.
 * - A study that needs more bars, volume, trades or a published series says which, in a typed reason. Nothing is invented.
 * - Each value is rounded to the market's tick (price studies) or the lot (volume), or to two decimals for an oscillator
 *   (a percentage point), before it is shown or drawn; the drawn value is the shown value.
 */
import { TIMEFRAME_MS } from '@intafaced/exchange-contract/schemas';
import { fractionDigits } from '../../../data/decimal';
import type { Candle, Loadable } from '../../../data/types';
import { toSeconds } from '../../trade/chart/chart-data';
import type { ChartInterval } from '../../trade/chart/candles';
import { RATING_SIGNALS, type PaletteToken } from './catalogue';
import {
  DAY_MS,
  bollinger,
  classicPivots,
  countSignals,
  cumulative,
  ema,
  formatAt,
  higherTimeframeSma,
  ichimoku,
  macd,
  priorDayFor,
  ratingScore,
  ratingSignals,
  roundToDecimals,
  rsi,
  sessionVwap,
  sma,
  sourceSeries,
  stochastic,
  volumeDelta,
  volumeOf,
  volumeProfile,
  SOURCES,
  type Maybe,
  type Print,
  type SourceName,
  type RatingSignal,
} from './math';
import type { StudyInstance } from './model';

/** Why a study shows no value, or what it could not read. The words are the copy's; the codes are the contract. */
export type Reason =
  | 'enterPeriod'
  | 'enterValue'
  | 'enterInterval'
  | 'badInput'
  | 'needsBars'
  | 'noBars'
  | 'noVolume'
  | 'noTape'
  | 'tapeWindow'
  | 'tapeDepth'
  | 'feedError'
  | 'feedRefused'
  | 'notServed'
  | 'weightsBlank'
  | 'needsDaily'
  | 'noPriorDay'
  | 'htfNotCoarser'
  | 'noHigherBars'
  | 'noTickSize';

export interface Refusal {
  reason: Reason;
  params: Record<string, string>;
}

export interface SeriesPoint {
  /** Epoch seconds, the library's unit. */
  time: number;
  /** The drawn value (the shown text read back as a number), or null for a gap. */
  value: number | null;
  /** The value as shown: rounded and fixed to the decimals of its tick or lot. Null for a gap. */
  text: string | null;
  tone: 'up' | 'down' | null;
}

export interface SeriesOut {
  key: string;
  /** The label in the legend and the data window. */
  name: string;
  pane: 'overlay' | 'sub';
  style: 'line' | 'histogram';
  color: PaletteToken;
  points: SeriesPoint[];
}

export interface Fact {
  name: string;
  text: string;
}

export interface TableRow {
  label: string;
  buy: string;
  sell: string;
  /** The row's total as a share of the busiest row, 0 to 100. */
  share: number;
  poc: boolean;
}

export type StudyResult =
  | { status: 'loading' }
  | ({ status: 'refused' } & Refusal)
  | {
      status: 'ready';
      series: SeriesOut[];
      facts: Fact[];
      /** Parts of a ready study that are absent, with the reason (a line that needs more bars, a series not read). */
      notes: Array<{ label: string } & Refusal>;
      table: TableRow[] | null;
    };

export interface StudyContext {
  symbol: string;
  interval: ChartInterval;
  bars: readonly Candle[];
  tickSize: string | null;
  lotSize: string | null;
  /** The higher-timeframe bars read for each higher-timeframe study, by study id. Undefined until requested. */
  higher: Record<string, Loadable<Candle[]> | undefined>;
  /** The public trades, when a study reads them. Undefined until requested. */
  tape: Loadable<Print[]> | undefined;
}

/** The oscillators (RSI, Stochastic, the rating's score) are percentage points: two decimals, whatever the tick. */
export const PERCENT_DIGITS = 2;
const MAX_PERIOD = 1000;
const PRICE_WORD = /^\d+(\.\d+)?$/;

export const readPeriod = (text: string | undefined): number | null => {
  const t = (text ?? '').trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= MAX_PERIOD ? n : null;
};

/** A multiplier such as 2 or 2.5: a positive decimal. */
export const readValue = (text: string | undefined): number | null => {
  const t = (text ?? '').trim();
  if (!PRICE_WORD.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
};

/** A rating weight: a decimal of zero or more. Blank or anything else is no weight. */
export const readWeight = (text: string | undefined): number | null => {
  const t = (text ?? '').trim();
  return PRICE_WORD.test(t) ? Number(t) : null;
};

const readSource = (text: string | undefined): SourceName | null =>
  (SOURCES as readonly string[]).includes(text ?? '') ? (text as SourceName) : null;
const readInterval = (text: string | undefined): ChartInterval | null =>
  text !== undefined && (Object.keys(TIMEFRAME_MS) as string[]).includes(text) ? (text as ChartInterval) : null;

const refuse = (reason: Reason, params: Record<string, string> = {}): StudyResult => ({ status: 'refused', reason, params });
const ready = (
  series: SeriesOut[],
  facts: Fact[] = [],
  notes: Array<{ label: string } & Refusal> = [],
  table: TableRow[] | null = null,
): StudyResult => ({
  status: 'ready',
  series,
  facts,
  notes,
  table,
});

type Feed<T> = { ok: true; data: T } | { ok: false; result: StudyResult };

/** A loaded feed read as data, or the result to show while it loads or after it failed. */
function feedOf<T>(loadable: Loadable<T> | undefined, emptyReason: Reason): Feed<T> {
  if (loadable === undefined || loadable.status === 'loading') return { ok: false, result: { status: 'loading' } };
  if (loadable.status === 'error') return { ok: false, result: refuse('feedError') };
  if (loadable.status === 'refused') return { ok: false, result: refuse('feedRefused', { code: loadable.code }) };
  if (loadable.status === 'empty') return { ok: false, result: refuse(emptyReason) };
  if (Array.isArray(loadable.data) && loadable.data.length === 0) return { ok: false, result: refuse(emptyReason) };
  return { ok: true, data: loadable.data };
}

interface TrackOptions {
  key: string;
  name: string;
  pane: 'overlay' | 'sub';
  style?: 'line' | 'histogram';
  color: PaletteToken;
  /** Decimals of the tick (price) or the lot (volume) or PERCENT_DIGITS. */
  digits: number;
  stepSec: number;
  /** Bars the values are drawn ahead (positive) or back (negative). The Ichimoku spans and lagging line use this. */
  shift?: number;
  /** Colour a histogram bar by its sign ('sign') or by its candle's direction ('candle'). */
  tone?: 'sign' | 'candle';
}

/** One series: `values[i]` is drawn at bar i's time plus `shift` bars. A gap (null) is drawn as a gap. */
function track(bars: readonly Candle[], values: readonly Maybe[], o: TrackOptions): SeriesOut {
  const shift = o.shift ?? 0;
  const points: SeriesPoint[] = [];
  bars.forEach((bar, i) => {
    if (i + shift < 0) return;
    const raw = values[i] ?? null;
    const text = raw === null ? null : formatAt(raw, o.digits);
    const value = text === null ? null : Number(text);
    let tone: SeriesPoint['tone'] = null;
    if (value !== null && o.tone === 'sign') tone = value >= 0 ? 'up' : 'down';
    if (value !== null && o.tone === 'candle') tone = Number(bar.c) >= Number(bar.o) ? 'up' : 'down';
    points.push({
      time: toSeconds(bar.t) + shift * o.stepSec,
      value: value === null ? null : roundToDecimals(value, o.digits),
      text,
      tone,
    });
  });
  return { key: o.key, name: o.name, pane: o.pane, style: o.style ?? 'line', color: o.color, points };
}

const signalWord = (value: RatingSignal['value']): string =>
  value === null ? 'No value' : value === 1 ? 'Buy' : value === -1 ? 'Sell' : 'Neutral';

/**
 * The result of one study on the loaded bars. Order of checks: no bars, then the study's own inputs, then the feeds it
 * reads, then the bars' sufficiency for each value.
 */
export function computeStudy(study: StudyInstance, ctx: StudyContext): StudyResult {
  const { bars, interval } = ctx;
  const i = study.inputs;
  if (study.kind === 'open-interest' || study.kind === 'funding' || study.kind === 'on-chain') {
    const series = study.kind === 'open-interest' ? 'Open interest' : study.kind === 'funding' ? 'Funding rate' : 'On-chain series';
    return refuse('notServed', { series, symbol: ctx.symbol });
  }
  if (bars.length === 0) return refuse('noBars');
  const stepMs = TIMEFRAME_MS[interval];
  const stepSec = stepMs / 1000;
  const digits = fractionDigits(ctx.tickSize);
  const lotDigits = fractionDigits(ctx.lotSize);
  if (digits === null || lotDigits === null) return refuse('noTickSize');
  const base = { color: study.color, stepSec };

  switch (study.kind) {
    case 'sma':
    case 'ema': {
      const p = readPeriod(i.period);
      if (p === null) return refuse('enterPeriod');
      const src = readSource(i.source);
      if (src === null) return refuse('badInput', { field: 'source' });
      if (bars.length < p) return refuse('needsBars', { count: String(p) });
      const short = study.kind === 'sma' ? 'SMA' : 'EMA';
      const values = (study.kind === 'sma' ? sma : ema)(sourceSeries(bars, src), p);
      const name = src === 'close' ? `${short} ${p}` : `${short} ${p} ${src}`;
      return ready([track(bars, values, { ...base, key: study.id, name, pane: 'overlay', digits })]);
    }

    case 'ichimoku': {
      const t = readPeriod(i.tenkan);
      const k = readPeriod(i.kijun);
      const s = readPeriod(i.senkou);
      if (t === null || k === null || s === null) return refuse('enterPeriod');
      if (bars.length < Math.max(t, k)) return refuse('needsBars', { count: String(Math.max(t, k)) });
      const lines = ichimoku(bars, t, k, s);
      const series = [
        track(bars, lines.tenkan, { ...base, key: `${study.id}:t`, name: 'Conversion', pane: 'overlay', digits, color: 'ma-1' }),
        track(bars, lines.kijun, { ...base, key: `${study.id}:k`, name: 'Base', pane: 'overlay', digits, color: 'ma-2' }),
        track(bars, lines.lagging, { ...base, key: `${study.id}:l`, name: 'Lagging', pane: 'overlay', digits, color: 'ma-3', shift: -k }),
        track(bars, lines.spanA, { ...base, key: `${study.id}:a`, name: 'Leading A', pane: 'overlay', digits, color: 'up', shift: k }),
      ];
      const notes: Array<{ label: string } & Refusal> = [];
      if (bars.length >= s)
        series.push(
          track(bars, lines.spanB, { ...base, key: `${study.id}:b`, name: 'Leading B', pane: 'overlay', digits, color: 'down', shift: k }),
        );
      else notes.push({ label: 'Leading B', reason: 'needsBars', params: { count: String(s) } });
      return ready(series, [], notes);
    }

    case 'vwap': {
      if (!bars.some((b) => volumeOf(b) !== null)) return refuse('noVolume');
      return ready(
        [track(bars, sessionVwap(bars), { ...base, key: study.id, name: 'VWAP', pane: 'overlay', digits })],
        [{ name: 'Session', text: 'UTC day' }],
      );
    }

    case 'volume': {
      const vols = bars.map(volumeOf);
      if (vols.every((v) => v === null)) return refuse('noVolume');
      const empty = vols.filter((v) => v === null).length;
      return ready(
        [
          track(bars, vols, {
            ...base,
            key: study.id,
            name: 'Volume',
            pane: 'sub',
            style: 'histogram',
            digits: lotDigits,
            tone: 'candle',
          }),
        ],
        [{ name: 'Bars with no volume', text: String(empty) }],
      );
    }

    case 'volume-delta': {
      const feed = feedOf(ctx.tape, 'noTape');
      if (!feed.ok) return feed.result;
      const prints = feed.data;
      const delta = volumeDelta(bars, prints, stepMs);
      const values = delta.map((d) => (d === null ? null : d.delta));
      if (values.every((v) => v === null)) return refuse('tapeWindow', { count: String(prints.length) });
      const covered = values.filter((v) => v !== null).length;
      return ready(
        [
          track(bars, values, {
            ...base,
            key: `${study.id}:d`,
            name: 'Delta',
            pane: 'sub',
            style: 'histogram',
            digits: lotDigits,
            tone: 'sign',
          }),
          track(bars, cumulative(values), {
            ...base,
            key: `${study.id}:c`,
            name: 'Cumulative delta',
            pane: 'sub',
            digits: lotDigits,
            color: 'ma-2',
          }),
        ],
        [
          { name: 'Public trades read', text: String(prints.length) },
          { name: 'Bars covered by the trades', text: String(covered) },
        ],
        [{ label: 'Trades', reason: 'tapeDepth', params: { count: String(prints.length) } }],
      );
    }

    case 'volume-profile': {
      const count = readPeriod(i.bins);
      if (count === null) return refuse('enterPeriod');
      const feed = feedOf(ctx.tape, 'noTape');
      if (!feed.ok) return feed.result;
      const profile = volumeProfile(feed.data, count);
      if (profile === null) return refuse('noTape');
      const top = Math.max(...profile.bins.map((b) => b.buy + b.sell));
      const table: TableRow[] = profile.bins.map((bin, n) => ({
        label: `${formatAt(bin.low, digits)} to ${formatAt(bin.high, digits)}`,
        buy: formatAt(bin.buy, lotDigits),
        sell: formatAt(bin.sell, lotDigits),
        share: top > 0 ? Math.round(((bin.buy + bin.sell) / top) * 100) : 0,
        poc: profile.poc === n,
      }));
      const poc = profile.poc === null ? null : table[profile.poc]!;
      return ready(
        [],
        [
          { name: 'Point of control', text: poc ? poc.label : '—' },
          { name: 'Public trades read', text: String(feed.data.length) },
        ],
        [{ label: 'Profile', reason: 'tapeDepth', params: { count: String(feed.data.length) } }],
        table,
      );
    }

    case 'rsi': {
      const p = readPeriod(i.period);
      if (p === null) return refuse('enterPeriod');
      if (bars.length <= p) return refuse('needsBars', { count: String(p + 1) });
      const closes = bars.map((b) => Number(b.c));
      return ready([track(bars, rsi(closes, p), { ...base, key: study.id, name: `RSI ${p}`, pane: 'sub', digits: PERCENT_DIGITS })]);
    }

    case 'macd': {
      const f = readPeriod(i.fast);
      const s = readPeriod(i.slow);
      const g = readPeriod(i.signal);
      if (f === null || s === null || g === null) return refuse('enterPeriod');
      if (bars.length < s) return refuse('needsBars', { count: String(s) });
      const closes = bars.map((b) => Number(b.c));
      const m = macd(closes, f, s, g);
      return ready([
        track(bars, m.line, { ...base, key: `${study.id}:m`, name: `MACD ${f} ${s} ${g}`, pane: 'sub', digits }),
        track(bars, m.signal, { ...base, key: `${study.id}:s`, name: 'Signal', pane: 'sub', digits, color: 'ma-2' }),
        track(bars, m.histogram, {
          ...base,
          key: `${study.id}:h`,
          name: 'Histogram',
          pane: 'sub',
          digits,
          style: 'histogram',
          tone: 'sign',
          color: 'ma-3',
        }),
      ]);
    }

    case 'stochastic': {
      const k = readPeriod(i.k);
      const d = readPeriod(i.d);
      if (k === null || d === null) return refuse('enterPeriod');
      if (bars.length < k) return refuse('needsBars', { count: String(k) });
      const s = stochastic(bars, k, d);
      return ready([
        track(bars, s.k, { ...base, key: `${study.id}:k`, name: `%K ${k}`, pane: 'sub', digits: PERCENT_DIGITS }),
        track(bars, s.d, { ...base, key: `${study.id}:d`, name: `%D ${d}`, pane: 'sub', digits: PERCENT_DIGITS, color: 'ma-2' }),
      ]);
    }

    case 'bollinger': {
      const p = readPeriod(i.period);
      if (p === null) return refuse('enterPeriod');
      const m = readValue(i.multiplier);
      if (m === null) return refuse('enterValue');
      if (bars.length < p) return refuse('needsBars', { count: String(p) });
      const b = bollinger(
        bars.map((x) => Number(x.c)),
        p,
        m,
      );
      return ready([
        track(bars, b.upper, { ...base, key: `${study.id}:u`, name: 'Upper', pane: 'overlay', digits }),
        track(bars, b.middle, { ...base, key: `${study.id}:m`, name: 'Middle', pane: 'overlay', digits, color: 'fg-2' }),
        track(bars, b.lower, { ...base, key: `${study.id}:l`, name: 'Lower', pane: 'overlay', digits }),
      ]);
    }

    case 'pivots':
    case 'auto-levels': {
      if (stepMs > DAY_MS) return refuse('needsDaily');
      const prior = priorDayFor(bars, stepMs);
      if (prior.every((p) => p === null)) return refuse('noPriorDay');
      const last = prior[bars.length - 1] ?? prior.find((p) => p !== null) ?? null;
      if (study.kind === 'auto-levels') {
        const pick = (f: (p: NonNullable<typeof last>) => number): Maybe[] => prior.map((p) => (p === null ? null : f(p)));
        return ready(
          [
            track(
              bars,
              pick((p) => p.high),
              { ...base, key: `${study.id}:h`, name: 'Prior high', pane: 'overlay', digits, color: 'up' },
            ),
            track(
              bars,
              pick((p) => p.low),
              { ...base, key: `${study.id}:l`, name: 'Prior low', pane: 'overlay', digits, color: 'down' },
            ),
            track(
              bars,
              pick((p) => p.close),
              { ...base, key: `${study.id}:c`, name: 'Prior close', pane: 'overlay', digits, color: 'fg-2' },
            ),
          ],
          last
            ? [
                {
                  name: 'Prior day high, low, close',
                  text: `${formatAt(last.high, digits)} / ${formatAt(last.low, digits)} / ${formatAt(last.close, digits)}`,
                },
              ]
            : [],
        );
      }
      const levels = prior.map((p) => (p === null ? null : classicPivots(p)));
      const names = ['P', 'R1', 'R2', 'R3', 'S1', 'S2', 'S3'] as const;
      const series = names.map((name) =>
        track(
          bars,
          levels.map((l) => (l === null ? null : l[name])),
          {
            ...base,
            key: `${study.id}:${name}`,
            name,
            pane: 'overlay',
            digits,
            color: name === 'P' ? 'fg-2' : name.startsWith('R') ? 'down' : 'up',
          },
        ),
      );
      return ready(
        series,
        last
          ? [
              {
                name: 'Prior day high, low, close',
                text: `${formatAt(last.high, digits)} / ${formatAt(last.low, digits)} / ${formatAt(last.close, digits)}`,
              },
            ]
          : [],
      );
    }

    case 'rating': {
      const signals = ratingSignals(bars);
      const counts = countSignals(signals);
      const weights: Record<string, number | null> = {};
      for (const s of RATING_SIGNALS) weights[s.id] = readWeight(i[`w.${s.id}`]);
      const score = ratingScore(signals, weights);
      const facts: Fact[] = signals.map((s) => ({ name: s.label, text: signalWord(s.value) }));
      facts.push(
        { name: 'Buy', text: String(counts.buy) },
        { name: 'Neutral', text: String(counts.neutral) },
        { name: 'Sell', text: String(counts.sell) },
        { name: 'No value', text: String(counts.missing) },
      );
      const notes: Array<{ label: string } & Refusal> = [];
      if (score === null) notes.push({ label: 'Rating', reason: 'weightsBlank', params: {} });
      else facts.push({ name: 'Score', text: formatAt(score, PERCENT_DIGITS) });
      return ready([], facts, notes);
    }

    case 'htf-sma': {
      const p = readPeriod(i.period);
      if (p === null) return refuse('enterPeriod');
      const src = readSource(i.source);
      if (src === null) return refuse('badInput', { field: 'source' });
      const htf = readInterval(i.interval);
      if (htf === null) return refuse('enterInterval');
      const htfStep = TIMEFRAME_MS[htf];
      if (htfStep <= stepMs) return refuse('htfNotCoarser', { interval: htf });
      const feed = feedOf(ctx.higher[study.id], 'noHigherBars');
      if (!feed.ok) return feed.result;
      if (feed.data.length < p) return refuse('needsBars', { count: String(p), interval: htf });
      const values = higherTimeframeSma(bars, feed.data, p, src, stepMs, htfStep);
      return ready(
        [track(bars, values, { ...base, key: study.id, name: `${htf} SMA ${p}`, pane: 'overlay', digits })],
        [{ name: 'Higher bars read', text: String(feed.data.length) }],
      );
    }
  }
  return refuse('badInput', { field: 'kind' });
}
