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
  // ratio() rounds each holding's share half-up, so the sum may miss 1 by up to one unit in the last place per
  // holding; more than that is a bug
  if (total <= 0n || (total > one ? total - one : one - total) > BigInt(holdings.length)) return null;
  // whole percents: the drawing can't show finer, and price ticks that move a share a little don't redraw the scene
  const percents = parts.map((p) => Number((p * 200n + total) / (2n * total)));
  percents[0]! += 100 - percents.reduce((a, b) => a + b, 0);
  return percents.map((p) => p / 100);
}
