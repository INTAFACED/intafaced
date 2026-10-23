import type { QuantCoverage, QUANT_BAR_SIZES } from '@intafaced/contracts';
import { DATAFEED_INTERVAL_MS } from '@intafaced/contracts/datafeed';
import { type Amount } from '@intafaced/ledger-client/money';

export type BarSize = (typeof QUANT_BAR_SIZES)[number];

/** One closed bar of the exchange's own taker tape. Prices are scaled decimals; the engine never sees an open bar. */
export interface Bar {
  readonly openTimeMs: number;
  readonly open: Amount;
  readonly high: Amount;
  readonly low: Amount;
  readonly close: Amount;
}

export function barSpanMs(barSize: BarSize): number {
  return DATAFEED_INTERVAL_MS[barSize];
}

/** The bar intervals a window holds: every bucket that starts at or after `fromMs` and has closed by `toMs`. */
export function windowBuckets(spanMs: number, fromMs: number, toMs: number): { readonly first: number; readonly count: number } {
  const first = Math.ceil(fromMs / spanMs) * spanMs;
  const count = toMs - first < spanMs ? 0 : Math.floor((toMs - first) / spanMs);
  return { first, count };
}

/** Four places, cut down: 7 bars of 9 is 0.7777, never rounded up to look fuller than it is. */
function fraction(part: number, whole: number): string {
  if (whole === 0) return '0';
  const scaled = Math.floor((part * 10_000) / whole);
  if (scaled >= 10_000) return '1';
  return `0.${String(scaled).padStart(4, '0')}`.replace(/0+$/, '').replace(/\.$/, '') || '0';
}

/**
 * Coverage of a window (ENGINE BT-3): how many of its bar intervals have a bar, the first and last bar, and each run
 * of empty intervals as a gap. A gap is recorded, never filled forward.
 */
export function coverageOf(bars: readonly Bar[], barSize: BarSize, fromMs: number, toMs: number): QuantCoverage {
  const span = barSpanMs(barSize);
  const { first, count } = windowBuckets(span, fromMs, toMs);
  const present = new Set(bars.map((bar) => bar.openTimeMs));
  const gaps: { from: string; to: string }[] = [];
  let gapStart: number | null = null;
  for (let i = 0; i < count; i += 1) {
    const at = first + i * span;
    if (present.has(at)) {
      if (gapStart !== null) gaps.push({ from: new Date(gapStart).toISOString(), to: new Date(at).toISOString() });
      gapStart = null;
    } else if (gapStart === null) {
      gapStart = at;
    }
  }
  if (gapStart !== null) gaps.push({ from: new Date(gapStart).toISOString(), to: new Date(first + count * span).toISOString() });
  return {
    barSize,
    bars: bars.length,
    expected: count,
    first: bars.length ? new Date(bars[0]!.openTimeMs).toISOString() : null,
    last: bars.length ? new Date(bars[bars.length - 1]!.openTimeMs).toISOString() : null,
    gaps,
    fraction: fraction(bars.length, count),
  };
}
