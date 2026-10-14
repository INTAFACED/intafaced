import { dec } from '../../../data/decimal';

/** Width of a progress bar, 0 to 100, from two decimal strings. Drawing only: this number is never money. */
export function barPct(used: string, limit: string): number {
  const u = dec(used);
  const l = dec(limit);
  if (u === null || l === null || l <= 0n || u <= 0n) return 0;
  const pct = Number((u * 100n) / l);
  return Math.min(100, Math.max(u > 0n && pct === 0 ? 1 : pct, 0));
}
