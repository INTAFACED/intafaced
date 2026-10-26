import { compareDecimal, dec, type HomePortfolio } from './deps';

/**
 * The sphere's segments from Home's holdings: the three biggest and "other", as fractions of 1 for drawing only.
 * Honesty rule: the parts must add up to the total shown, so any holding without a known share (unpriced) means no
 * segments at all, never a partial split. Shares arrive as decimal strings; only the final fractions are numbers.
 */
export function sphereShares(holdings: HomePortfolio['holdings']): number[] | null {
  if (holdings.length === 0) return null;
  const shares = holdings.map((h) => h.share);
  if (shares.some((s) => s === null || dec(s) === null)) return null;
  const sorted = [...(shares as string[])].sort((a, b) => compareDecimal(b, a) ?? 0);
  const one = dec('1')!;
  const top = sorted.slice(0, 3).map((s) => dec(s)!);
  const rest = sorted.slice(3).reduce((sum, s) => sum + dec(s)!, 0n);
  const parts = rest > 0n ? [...top, rest] : top;
  const total = parts.reduce((a, b) => a + b, 0n);
  // ratio() rounds each share half-up, so the sum may miss 1 by a few units in the last place; more than that is a bug
  if (total <= 0n || (total > one ? total - one : one - total) > BigInt(parts.length)) return null;
  const fractions = parts.map((p) => Number((p * 1_000_000n) / total) / 1_000_000);
  const drift = 1 - fractions.reduce((a, b) => a + b, 0);
  fractions[0]! += drift;
  return fractions;
}
