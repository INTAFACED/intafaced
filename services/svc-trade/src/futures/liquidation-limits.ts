/**
 * The liquidation mark limits, as an owner publishes them (`TRADE_FUTURES_LIQUIDATION_LIMITS`, MKT-0057): how old a mark
 * may be, how old for a liquidation, and how far it may jump from the last accepted one. Until they are published the
 * liquidation tick refuses every position with `trade.mark_unusable` (mark-policy.ts `judgeLiquidationMark`), as it
 * always has: blank stays blank, and the compiled 300 / 60 / 2000 are never read as a publication.
 *
 * A value is JSON: { "maxAgeSeconds": 300, "liquidationMaxAgeSeconds": 60, "maxDeviationBps": 2000,
 * "liquidationQualities": ["index", "mid"] } (qualities optional, never "last": one print must not close a position).
 * A value that is not that stops boot, so a typo is never read as "unpublished" or as a guess.
 */
import type { MarkQuality, PublishedLiquidationLimits } from './mark-policy.js';

export const TRADE_FUTURES_LIQUIDATION_LIMITS_ENV = 'TRADE_FUTURES_LIQUIDATION_LIMITS';

const LIQUIDATION_QUALITIES: readonly MarkQuality[] = ['index', 'mid'];

function wholeAbove0(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${TRADE_FUTURES_LIQUIDATION_LIMITS_ENV}: ${name} must be a whole number above 0`);
  }
  return value;
}

/** Blank: unpublished (null). Anything else must be a whole, coherent publication, or this throws. */
export function publishedLiquidationLimitsFrom(raw: string | undefined): PublishedLiquidationLimits | null {
  const text = (raw ?? '').trim();
  if (text === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${TRADE_FUTURES_LIQUIDATION_LIMITS_ENV}: not JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${TRADE_FUTURES_LIQUIDATION_LIMITS_ENV}: must be an object`);
  }
  const v = value as Record<string, unknown>;
  const known = new Set(['maxAgeSeconds', 'liquidationMaxAgeSeconds', 'maxDeviationBps', 'liquidationQualities']);
  const unknown = Object.keys(v).filter((k) => !known.has(k));
  if (unknown.length > 0) throw new Error(`${TRADE_FUTURES_LIQUIDATION_LIMITS_ENV}: unknown field ${unknown.join(', ')}`);
  const maxAgeSeconds = wholeAbove0(v.maxAgeSeconds, 'maxAgeSeconds');
  const liquidationMaxAgeSeconds = wholeAbove0(v.liquidationMaxAgeSeconds, 'liquidationMaxAgeSeconds');
  const maxDeviationBps = wholeAbove0(v.maxDeviationBps, 'maxDeviationBps');
  if (liquidationMaxAgeSeconds > maxAgeSeconds) {
    throw new Error(`${TRADE_FUTURES_LIQUIDATION_LIMITS_ENV}: liquidationMaxAgeSeconds cannot be above maxAgeSeconds`);
  }
  if (maxDeviationBps > 10_000) throw new Error(`${TRADE_FUTURES_LIQUIDATION_LIMITS_ENV}: maxDeviationBps cannot be above 10000`);
  if (v.liquidationQualities === undefined) return { maxAgeSeconds, liquidationMaxAgeSeconds, maxDeviationBps };
  const qualities = v.liquidationQualities;
  if (
    !Array.isArray(qualities) ||
    qualities.length === 0 ||
    !qualities.every((q) => (LIQUIDATION_QUALITIES as readonly unknown[]).includes(q)) ||
    new Set(qualities).size !== qualities.length
  ) {
    throw new Error(
      `${TRADE_FUTURES_LIQUIDATION_LIMITS_ENV}: liquidationQualities must be distinct, from ${LIQUIDATION_QUALITIES.join(', ')}`,
    );
  }
  return { maxAgeSeconds, liquidationMaxAgeSeconds, maxDeviationBps, liquidationQualities: qualities as MarkQuality[] };
}
