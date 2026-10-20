import { compare, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';

/** A set limit. "Not set" is the absence of one (`null`), never zero. */
export interface LimitFigures {
  readonly perTx: Amount;
  readonly rolling24h: Amount;
}

/** Canonical decimal text, so `10`, `10.0` and `010` bind to the same approval. */
export function canonicalFigures(f: { perTx: string; rolling24h: string }): { perTx: string; rolling24h: string } | null {
  const perTx = parseAmount(f.perTx);
  const rolling24h = parseAmount(f.rolling24h);
  if (perTx <= 0n || rolling24h <= 0n) return null;
  return { perTx: formatAmount(perTx), rolling24h: formatAmount(rolling24h) };
}

export const sameFigures = (a: LimitFigures | null, b: LimitFigures | null): boolean =>
  a === null || b === null ? a === b : a.perTx === b.perTx && a.rolling24h === b.rolling24h;

/**
 * Why a change needs a second founder. Anything that makes it easier to withdraw
 * does: a new figure, or a higher per-transaction or rolling figure. Lowering a
 * figure or clearing it back to unset only tightens, so one founder may do it.
 */
export function limitDualReasons(before: LimitFigures | null, after: LimitFigures | null): string[] {
  if (after === null) return [];
  if (before === null) return ['limit_set'];
  const reasons: string[] = [];
  if (compare(after.perTx, before.perTx) > 0) reasons.push('per_tx_raised');
  if (compare(after.rolling24h, before.rolling24h) > 0) reasons.push('rolling_24h_raised');
  return reasons;
}
