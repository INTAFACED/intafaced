/**
 * Pure helpers for the earn pool page and the side-by-side table (BK-earn-05). Nothing here makes a figure: the
 * rates and dates are the bank's records (`earn.rateHistory`), and these only place them on a chart, find which record
 * was in force at a moment, and say whether the pools in a row differ.
 */

export interface RecordedRate {
  rateBps: number;
  effectiveAt: string;
}

/** The record in force at `at`: the last one that took effect at or before it. Null before the first record. */
export function rateAt(changes: readonly RecordedRate[], at: string): RecordedRate | null {
  const when = Date.parse(at);
  if (!Number.isFinite(when)) return null;
  let found: RecordedRate | null = null;
  for (const change of changes) {
    const from = Date.parse(change.effectiveAt);
    if (Number.isFinite(from) && from <= when) found = change;
  }
  return found;
}

export interface StepChart {
  /** The SVG polyline: flat at each rate from the date it took effect to the next record, then up or down. */
  points: string;
  /** One mark per record, where its step starts. */
  marks: Array<{ x: number; y: number; rateBps: number; effectiveAt: string }>;
  /** The highest rate drawn, which the top of the chart stands for. */
  topBps: number;
}

/**
 * A step chart of the records over a `width` x `height` box, from the first record to `now`. Time runs left to right
 * and the rate bottom to top from zero, so a step's height is its rate. Nothing is drawn before the first record.
 */
export function stepChart(changes: readonly RecordedRate[], now: number, width: number, height: number): StepChart | null {
  const dated = changes
    .map((change) => ({ ...change, at: Date.parse(change.effectiveAt) }))
    .filter((change) => Number.isFinite(change.at))
    .sort((a, b) => a.at - b.at);
  if (dated.length === 0) return null;
  const start = dated[0]!.at;
  const end = Math.max(now, dated[dated.length - 1]!.at + 1);
  const topBps = Math.max(...dated.map((change) => change.rateBps), 1);
  const x = (at: number) => Math.round(((at - start) / (end - start)) * width * 100) / 100;
  const y = (bps: number) => Math.round((height - (bps / topBps) * height) * 100) / 100;
  const points: string[] = [];
  dated.forEach((change, index) => {
    if (index > 0) points.push(`${x(change.at)},${y(dated[index - 1]!.rateBps)}`);
    points.push(`${x(change.at)},${y(change.rateBps)}`);
  });
  points.push(`${width},${y(dated[dated.length - 1]!.rateBps)}`);
  return {
    points: points.join(' '),
    marks: dated.map((change) => ({ x: x(change.at), y: y(change.rateBps), rateBps: change.rateBps, effectiveAt: change.effectiveAt })),
    topBps,
  };
}

/** True when the cells of one row are not all the same: the side-by-side table marks them. */
export function rowDiffers(values: readonly string[]): boolean {
  return values.length > 1 && values.some((value) => value !== values[0]);
}

/** The most pools the side-by-side table holds (crypto-credit-earn-095: two to four). */
export const COMPARE_MAX = 4;

/** The picked pool ids after a toggle: one more, one fewer, or unchanged when the table is full. */
export function togglePick(picked: readonly string[], id: string): string[] {
  if (picked.includes(id)) return picked.filter((one) => one !== id);
  return picked.length >= COMPARE_MAX ? [...picked] : [...picked, id];
}
