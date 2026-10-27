/**
 * AC-assignments-04 — the gradebook's arithmetic. Pure. Every figure is a fraction in scaled bigint (10^-18 units,
 * through the canonical decimal parser), divided with the remainder cut, never a JavaScript number.
 */
import { formatAmount, parseAmount, SCALE } from '@intafaced/ledger-client';

export type Fraction = bigint;

/** `score` over `points`, as a fraction; null when there are no points to divide by. */
export function fractionOf(score: string, points: string): Fraction | null {
  const top = parseAmount(score);
  const bottom = parseAmount(points);
  return bottom === 0n ? null : (top * SCALE) / bottom;
}

export const fractionText = (value: Fraction): string => formatAmount(value);

/** A type's average: the lowest `dropLowest` scores dropped first, but never the last one. Null with no score. */
export function typeAverage(
  scores: ReadonlyArray<{ itemId: string; score: Fraction }>,
  dropLowest: number,
): { average: Fraction | null; counted: string[]; dropped: string[] } {
  if (scores.length === 0) return { average: null, counted: [], dropped: [] };
  // Lowest first; equal scores in item order, so the same grades always drop the same item.
  const sorted = [...scores].sort((a, b) => (a.score < b.score ? -1 : a.score > b.score ? 1 : a.itemId < b.itemId ? -1 : 1));
  const drop = Math.min(dropLowest, sorted.length - 1);
  const kept = sorted.slice(drop);
  const sum = kept.reduce((total, s) => total + s.score, 0n);
  return {
    average: sum / BigInt(kept.length),
    counted: kept.map((s) => s.itemId).sort(),
    dropped: sorted
      .slice(0, drop)
      .map((s) => s.itemId)
      .sort(),
  };
}

/** The weighted mean of the types that have an average; null when none has. `weight` is a decimal string. */
export function weightedTotal(types: ReadonlyArray<{ weight: string; average: Fraction | null }>): Fraction | null {
  let weights = 0n;
  let sum = 0n;
  for (const t of types) {
    if (t.average === null) continue;
    const weight = parseAmount(t.weight);
    weights += weight;
    sum += weight * t.average;
  }
  return weights === 0n ? null : sum / weights;
}

/** Decimal weights added up, as a fraction. */
export const weightSum = (weights: readonly string[]): Fraction => weights.reduce((total, w) => total + parseAmount(w), 0n);

/** Whether decimal weights add up to exactly 1. */
export const weightsSumToOne = (weights: readonly string[]): boolean => weightSum(weights) === SCALE;
