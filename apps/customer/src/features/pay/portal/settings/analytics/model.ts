import type { ApiResult } from '../../../../../shared/api';
import { formatAmount, parseAmount } from '../../../../../shared/money';
import type { FeePoint } from './schemas';

/** One bar's worth of captures. `count` is null where the figures come from the daily totals, which carry no count. */
export type Point = { period: string; assetCode: string; volume: string; count: number | null };

export type Preset = 'today' | '7d' | '30d' | 'custom';
export const DAY = 86_400_000;
const dayStart = (ms: number) => new Date(Math.floor(ms / DAY) * DAY).toISOString();

/** The window a choice means: whole UTC days, the end exclusive. */
export function windowFor(preset: Preset, now: number, custom: { from: string; to: string }): { from: string; to: string } | null {
  if (preset === 'today') return { from: dayStart(now), to: dayStart(now + DAY) };
  if (preset === '7d') return { from: dayStart(now - 6 * DAY), to: dayStart(now + DAY) };
  if (preset === '30d') return { from: dayStart(now - 29 * DAY), to: dayStart(now + DAY) };
  if (!custom.from || !custom.to || custom.from > custom.to) return null;
  return { from: `${custom.from}T00:00:00.000Z`, to: dayStart(Date.parse(`${custom.to}T00:00:00.000Z`) + DAY) };
}

export const MAX_PAGES = 6;
/** Follow the service's pages until there are none, up to a ceiling. Beyond it the result says it is cut short, so no total is shown. */
export async function readAll<T>(
  read: (cursor: string | undefined) => Promise<ApiResult<{ items: T[]; nextCursor: string | null; freshness: { asOf: string | null; lagSeconds: number | null } }>>,
): Promise<ApiResult<{ items: T[]; complete: boolean; freshness: { asOf: string | null; lagSeconds: number | null } }>> {
  const items: T[] = [];
  let cursor: string | undefined;
  let freshness: { asOf: string | null; lagSeconds: number | null } = { asOf: null, lagSeconds: null };
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await read(cursor);
    if (!result.ok) return result;
    items.push(...result.data.items);
    if (page === 0) freshness = result.data.freshness;
    if (!result.data.nextCursor) return { ok: true, data: { items, complete: true, freshness } };
    cursor = result.data.nextCursor;
  }
  return { ok: true, data: { items, complete: false, freshness } };
}

/** Exact sums per asset. Two assets are never added together. */
export function sumByAsset<T extends { assetCode: string }>(rows: readonly T[], pick: (row: T) => string): Array<{ assetCode: string; total: string }> {
  const totals = new Map<string, bigint>();
  for (const row of rows) totals.set(row.assetCode, (totals.get(row.assetCode) ?? 0n) + parseAmount(pick(row)));
  return [...totals].map(([assetCode, total]) => ({ assetCode, total: formatAmount(total) })).sort((a, b) => a.assetCode.localeCompare(b.assetCode));
}

export const assetsOf = (rows: ReadonlyArray<{ assetCode: string }>) => [...new Set(rows.map((r) => r.assetCode))].sort();

/** The period with the most captured payments (ties go to the later one). */
export function busiest(points: readonly Point[]): { period: string; count: number } | null {
  const byPeriod = new Map<string, number>();
  if (points.some((p) => p.count === null)) return null;
  for (const p of points) byPeriod.set(p.period, (byPeriod.get(p.period) ?? 0) + (p.count ?? 0));
  let best: { period: string; count: number } | null = null;
  for (const [period, count] of byPeriod) if (count > 0 && (!best || count > best.count || (count === best.count && period > best.period))) best = { period, count };
  return best;
}
export const totalCount = (points: readonly Point[]): number | null => (points.some((p) => p.count === null) ? null : points.reduce((n, p) => n + (p.count ?? 0), 0));
export const periodsWithSales = (points: readonly Point[]) => new Set(points.filter((p) => parseAmount(p.volume) > 0n).map((p) => p.period)).size;

/** Bars for one asset, oldest first. Heights are pixels (a drawing value, never money); the exact amount stays in the table. */
export function barsFor(points: readonly Point[], asset: string, height: number): Array<{ period: string; h: number; volume: string }> {
  const rows = points.filter((p) => p.assetCode === asset).sort((a, b) => a.period.localeCompare(b.period));
  const max = Math.max(0, ...rows.map((r) => Number(r.volume)));
  return rows.map((r) => ({ period: r.period, volume: r.volume, h: max > 0 ? Math.max(1, Math.round((Number(r.volume) / max) * height)) : 0 }));
}

export const feeTotals = (points: readonly FeePoint[]) => ({
  gross: sumByAsset(points, (p) => p.gross),
  fees: sumByAsset(points, (p) => p.fees),
  net: sumByAsset(points, (p) => p.net),
  refunded: sumByAsset(points, (p) => p.refunded),
});
