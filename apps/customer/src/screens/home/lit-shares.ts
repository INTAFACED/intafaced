import { dec, str, type Decimal, type HomePortfolio } from './deps';

/**
 * One part of the sphere, named as Home's rows name it: `cash` is every stablecoin and fiat holding together (the
 * "Cash" row), `asset` one crypto asset, `other` the rest together. Whole percents, and the exact USD value.
 */
export type SpherePart = { kind: 'cash' | 'asset' | 'other'; asset: string | null; percent: bigint; usd: Decimal };

type Part = { kind: SpherePart['kind']; asset: string | null; share: bigint; usd: bigint };

const together = (kind: Part['kind'], parts: Part[]): Part => ({
  kind,
  asset: null,
  share: parts.reduce((sum, p) => sum + p.share, 0n),
  usd: parts.reduce((sum, p) => sum + p.usd, 0n),
});

/**
 * The sphere's segments from Home's holdings: Cash and the crypto assets, the three biggest and "other", in whole
 * percents adding up to 100, biggest first. Honesty rule: the parts must add up to the total shown, so any holding
 * without a known share or value (unpriced) means no segments at all, never a partial split. Shares arrive as decimal
 * strings and stay exact (bigint) here; the light objects turn them into drawing fractions (`sharesFromPercents`).
 */
export function sphereShares(holdings: HomePortfolio['holdings']): SpherePart[] | null {
  if (holdings.length === 0) return null;
  const known: Array<Part & { cash: boolean }> = [];
  for (const h of holdings) {
    const share = dec(h.share);
    const usd = dec(h.usdValue);
    if (share === null || usd === null) return null;
    known.push({ kind: 'asset', asset: h.asset, share, usd, cash: h.class === 'cash' });
  }
  const cash = known.filter((p) => p.cash);
  const grouped: Part[] = [...known.filter((p) => !p.cash), ...(cash.length > 0 ? [together('cash', cash)] : [])];
  grouped.sort((a, b) => (a.share === b.share ? 0 : a.share > b.share ? -1 : 1));
  const parts = grouped.length > 4 ? [...grouped.slice(0, 3), together('other', grouped.slice(3))] : grouped;
  const one = dec('1')!;
  const total = parts.reduce((a, b) => a + b.share, 0n);
  // ratio() rounds each holding's share half-up, so the sum may miss 1 by up to one unit in the last place per
  // holding; more than that is a bug
  if (total <= 0n || (total > one ? total - one : one - total) > BigInt(holdings.length)) return null;
  // whole percents: the drawing can't show finer, and price ticks that move a share a little don't redraw the scene
  const percents = parts.map((p) => (p.share * 200n + total) / (2n * total));
  percents[0]! += 100n - percents.reduce((a, b) => a + b, 0n);
  return parts.map((p, i) => ({ kind: p.kind, asset: p.asset, percent: percents[i]!, usd: str(p.usd) }));
}
