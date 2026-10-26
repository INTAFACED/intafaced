import { compareDecimal, dec, type HomePortfolio } from './deps';

/** One part of the sphere: an asset (the three biggest) or the rest together, in whole percents. */
export type SpherePart = { asset: string | null; percent: bigint };

/**
 * The sphere's segments from Home's holdings: the three biggest and "other", in whole percents adding up to 100.
 * Honesty rule: the parts must add up to the total shown, so any holding without a known share (unpriced) means no
 * segments at all, never a partial split. Shares arrive as decimal strings and stay exact (bigint) here; the light
 * objects turn them into drawing fractions (`sharesFromPercents`).
 */
export function sphereShares(holdings: HomePortfolio['holdings']): SpherePart[] | null {
  if (holdings.length === 0) return null;
  const known = holdings.map((h) => ({ asset: h.asset, share: h.share === null ? null : dec(h.share) }));
  if (known.some((h) => h.share === null)) return null;
  const sorted = [...holdings]
    .sort((a, b) => compareDecimal(b.share!, a.share!) ?? 0)
    .map((h) => ({ asset: h.asset, share: dec(h.share!)! }));
  const one = dec('1')!;
  const top = sorted.slice(0, 3);
  const rest = sorted.slice(3).reduce((sum, h) => sum + h.share, 0n);
  const parts: Array<{ asset: string | null; share: bigint }> = rest > 0n ? [...top, { asset: null, share: rest }] : top;
  const total = parts.reduce((a, b) => a + b.share, 0n);
  // ratio() rounds each holding's share half-up, so the sum may miss 1 by up to one unit in the last place per
  // holding; more than that is a bug
  if (total <= 0n || (total > one ? total - one : one - total) > BigInt(holdings.length)) return null;
  // whole percents: the drawing can't show finer, and price ticks that move a share a little don't redraw the scene
  const percents = parts.map((p) => (p.share * 200n + total) / (2n * total));
  percents[0]! += 100n - percents.reduce((a, b) => a + b, 0n);
  return parts.map((p, i) => ({ asset: p.asset, percent: percents[i]! }));
}
