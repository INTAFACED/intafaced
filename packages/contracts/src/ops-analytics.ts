/**
 * OPS ANALYTICS — Slice A contract (TRK-ops.analytics).
 *
 * Replica + lag law only. No cube SQL, no warehouse process, no write path.
 * Money figures on any future metric MUST be decimal strings (never JS number).
 *
 * ── Source databases (read replicas; OLTP remains SoT) ─────────────────────
 *   · ledger  — money movements (svc-ledger)
 *   · trade   — orders/fills facts (svc-trade)
 *   · identity — non-money cohort dims only (no balances)
 *
 * Analytics MUST NOT post ledger. Fail-closed: if lag is unknown or over SLO,
 * surfaces must not label series as "live".
 */

import { z } from 'zod';

/** Databases that may feed a future read replica / warehouse. */
export const ANALYTICS_SOURCE_DBS = ['ledger', 'trade', 'identity'] as const;
export type AnalyticsSourceDb = (typeof ANALYTICS_SOURCE_DBS)[number];

/**
 * Lag SLO defaults (seconds). Product may tighten; never loosen fail-closed.
 * Over this lag → refuse "live" label.
 */
export const ANALYTICS_LAG_SLO_SECONDS = {
  /** Default max lag for any "live" operator label. */
  liveMaxLagSeconds: 60,
  /** Soft warn band (still not "live" if over liveMax). */
  warnLagSeconds: 30,
} as const;

export type LagFreshness = 'live' | 'delayed' | 'stale' | 'unknown';

/**
 * Fail-closed freshness from observed lag.
 * unknown lag → unknown (never "live").
 */
export function lagFreshness(lagSeconds: number | null | undefined): LagFreshness {
  if (lagSeconds === null || lagSeconds === undefined || !Number.isFinite(lagSeconds) || lagSeconds < 0) {
    return 'unknown';
  }
  if (lagSeconds <= ANALYTICS_LAG_SLO_SECONDS.warnLagSeconds) return 'live';
  if (lagSeconds <= ANALYTICS_LAG_SLO_SECONDS.liveMaxLagSeconds) return 'delayed';
  return 'stale';
}

/** True only when the surface may paint a "live" badge. */
export function mayLabelLive(lagSeconds: number | null | undefined): boolean {
  return lagFreshness(lagSeconds) === 'live';
}

/**
 * L3 — multi-source lag rollup. Live label only if EVERY known source is live.
 * Unknown or missing lag on any source → overall unknown (never invent live).
 */
export type SourceLag = {
  readonly source: AnalyticsSourceDb;
  readonly lagSeconds: number | null | undefined;
};

export type AggregateLag = {
  readonly overall: LagFreshness;
  readonly mayLabelLive: boolean;
  readonly bySource: Readonly<Record<AnalyticsSourceDb, LagFreshness>>;
  readonly worstLagSeconds: number | null;
};

export function aggregateSourceLags(lags: readonly SourceLag[]): AggregateLag {
  const bySource = {
    ledger: 'unknown' as LagFreshness,
    trade: 'unknown' as LagFreshness,
    identity: 'unknown' as LagFreshness,
  };
  let worst: number | null = null;
  for (const row of lags) {
    const f = lagFreshness(row.lagSeconds);
    bySource[row.source] = f;
    if (row.lagSeconds != null && Number.isFinite(row.lagSeconds) && row.lagSeconds >= 0) {
      worst = worst === null ? row.lagSeconds : Math.max(worst, row.lagSeconds);
    }
  }
  const values = Object.values(bySource);
  let overall: LagFreshness = 'live';
  if (values.some((v) => v === 'unknown')) overall = 'unknown';
  else if (values.some((v) => v === 'stale')) overall = 'stale';
  else if (values.some((v) => v === 'delayed')) overall = 'delayed';
  return {
    overall,
    mayLabelLive: overall === 'live',
    bySource,
    worstLagSeconds: worst,
  };
}

/** Decimal amount on the wire — JS numbers refused, not coerced. No owner min/max. */
export const analyticsAmountString = z
  .string({ error: (issue) => (issue.input === undefined ? undefined : 'JS number refused — amounts are decimal strings') })
  .regex(/^-?\d+(\.\d{1,18})?$/, 'analytics amounts are decimal strings (max 18dp)');

export const analyticsMetricKind = z.enum(['count', 'amount', 'ratio']);

/**
 * Metric definition — maps a product name to source facts.
 * `sqlHint` is documentation only in Slice A (no execution).
 */
export const analyticsMetricDefSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(160),
  kind: analyticsMetricKind,
  sources: z.array(z.enum(ANALYTICS_SOURCE_DBS)).min(1),
  /** Human-readable mapping to ledger/trade facts — not executable SQL yet. */
  factHint: z.string().min(8).max(2000),
  /** If kind=amount, values must use analyticsAmountString at the consumer. */
  money: z.boolean(),
});

export type AnalyticsMetricDef = z.infer<typeof analyticsMetricDefSchema>;

/** v0 metric catalogue — definitions only; no offline invented numbers. */
export const ANALYTICS_METRICS_V0: readonly AnalyticsMetricDef[] = [
  {
    id: 'ledger.postings.count',
    title: 'Ledger postings (count)',
    kind: 'count',
    sources: ['ledger'],
    factHint: 'Count of posted journal lines in ledger OLTP / replica — never invent.',
    money: false,
  },
  {
    id: 'ledger.volume.notional',
    title: 'Ledger notional volume',
    kind: 'amount',
    sources: ['ledger'],
    factHint: 'Sum of absolute posted amounts as decimal strings from ledger facts.',
    money: true,
  },
  {
    id: 'trade.fills.count',
    title: 'Trade fills (count)',
    kind: 'count',
    sources: ['trade'],
    factHint: 'Count of settled fills in trade service facts.',
    money: false,
  },
] as const;

export function metricById(id: string): AnalyticsMetricDef | undefined {
  return ANALYTICS_METRICS_V0.find((m) => m.id === id);
}

/**
 * L3 — non-money metric ids only (safe for integer cube helpers).
 * Money metrics stay out so operators cannot mis-sum notional as count.
 */
export function listNonMoneyMetricIds(): readonly string[] {
  return ANALYTICS_METRICS_V0.filter((m) => !m.money && m.kind !== 'amount').map((m) => m.id);
}

/**
 * L3 — money / amount metric ids only (must use decimal strings).
 */
export function listMoneyMetricIds(): readonly string[] {
  return ANALYTICS_METRICS_V0.filter((m) => m.money || m.kind === 'amount').map((m) => m.id);
}

/** L3 — total v0 metric definitions (catalog size, no invent series). */
export function analyticsMetricCatalogSize(): number {
  return ANALYTICS_METRICS_V0.length;
}

/** Validate a consumer point — amount metrics require decimal strings. */
export function assertMetricPoint(metricId: string, value: string | number): { ok: true } | { ok: false; reason: string } {
  const def = metricById(metricId);
  if (!def) return { ok: false, reason: `unknown metric ${metricId}` };
  if (def.money || def.kind === 'amount') {
    if (typeof value === 'number') {
      return { ok: false, reason: 'money metrics refuse JS number — use decimal string' };
    }
    const parsed = analyticsAmountString.safeParse(value);
    if (!parsed.success) return { ok: false, reason: parsed.error.issues[0]?.message ?? 'invalid amount' };
  } else if (def.kind === 'count') {
    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value < 0) return { ok: false, reason: 'count must be non-negative integer' };
    } else if (!/^\d+$/.test(value)) {
      return { ok: false, reason: 'count must be non-negative integer string' };
    }
  }
  return { ok: true };
}

/**
 * L3 — whether catalog defines metric id (unknown → false; never invent series).
 */
export function hasAnalyticsMetric(metricId: string): boolean {
  const id = metricId.trim();
  if (!id) return false;
  return metricById(id) != null;
}

/**
 * L3 — count of metrics by kind in v0 catalog (no invent).
 */
export function countMetricsByKind(kind: 'count' | 'amount' | 'ratio'): number {
  return ANALYTICS_METRICS_V0.filter((m) => m.kind === kind).length;
}

/**
 * L3 — metric ids of one kind (sorted). Empty kind → [].
 */
export function listMetricIdsByKind(kind: 'count' | 'amount' | 'ratio'): readonly string[] {
  return ANALYTICS_METRICS_V0.filter((m) => m.kind === kind)
    .map((m) => m.id)
    .sort();
}

/**
 * L3 — how many v0 metrics declare a given source DB (catalog only; no invent series).
 */
export function countMetricsUsingSource(source: AnalyticsSourceDb): number {
  return ANALYTICS_METRICS_V0.filter((m) => m.sources.includes(source)).length;
}

/**
 * L3 — money vs non-money catalog sizes (partition of v0; no invent).
 */
export function metricMoneyPartition(): { readonly money: number; readonly nonMoney: number; readonly total: number } {
  const money = listMoneyMetricIds().length;
  const nonMoney = listNonMoneyMetricIds().length;
  return { money, nonMoney, total: money + nonMoney };
}

/** L3 — true when v0 catalog has zero metrics (should not happen on tip). */
export function isMetricCatalogEmpty(): boolean {
  return analyticsMetricCatalogSize() === 0;
}

/**
 * L3 — sorted metric ids that touch a source. Unknown source key still returns [] via filter.
 */
export function listMetricIdsUsingSource(source: AnalyticsSourceDb): readonly string[] {
  return ANALYTICS_METRICS_V0.filter((m) => m.sources.includes(source))
    .map((m) => m.id)
    .sort();
}

/**
 * L3 — true when catalog has at least one money/amount metric (decimal-string law).
 */
export function hasMoneyMetrics(): boolean {
  return listMoneyMetricIds().length > 0;
}

/**
 * L3 — how many v0 metrics declare more than one source DB. Empty catalog → 0.
 */
export function multiSourceMetricCount(): number {
  return ANALYTICS_METRICS_V0.filter((m) => m.sources.length > 1).length;
}

/**
 * L3 — per-source metric counts (catalog only; no invent series).
 */
export function metricCountBySource(): Readonly<Record<AnalyticsSourceDb, number>> {
  return {
    ledger: countMetricsUsingSource('ledger'),
    trade: countMetricsUsingSource('trade'),
    identity: countMetricsUsingSource('identity'),
  };
}

/**
 * L3 — how many v0 metrics declare exactly one source. Empty → 0.
 */
export function singleSourceMetricCount(): number {
  return ANALYTICS_METRICS_V0.filter((m) => m.sources.length === 1).length;
}

/**
 * L3 — money/total as fixed 4dp string. Empty catalog → null (never invent 0).
 */
export function moneyMetricRatio(): string | null {
  const part = metricMoneyPartition();
  if (part.total === 0) return null;
  return (part.money / part.total).toFixed(4);
}

/**
 * L3 — non-money/total as fixed 4dp string. Empty catalog → null.
 */
export function nonMoneyMetricRatio(): string | null {
  const part = metricMoneyPartition();
  if (part.total === 0) return null;
  return (part.nonMoney / part.total).toFixed(4);
}

/**
 * L3 — count of money/amount metrics in catalog.
 */
export function countMoneyMetrics(): number {
  return listMoneyMetricIds().length;
}

/**
 * L3 — true when catalog has any non-money metric.
 */
export function hasNonMoneyMetrics(): boolean {
  return listNonMoneyMetricIds().length > 0;
}

/** L3 — count of money/amount metrics in v0 catalog. */
export function moneyMetricCount(): number {
  return listMoneyMetricIds().length;
}

/** L3 — count of non-money metrics in v0 catalog. */
export function nonMoneyMetricCount(): number {
  return listNonMoneyMetricIds().length;
}

/** L3 — alias of hasMoneyMetrics. */
export function catalogHasMoney(): boolean {
  return hasMoneyMetrics();
}

/** L3 — true when v0 catalog has at least one metric. */
export function catalogIsNonEmpty(): boolean {
  return !isMetricCatalogEmpty();
}

/** L3 — alias of analyticsMetricCatalogSize. */
export function catalogMetricCount(): number {
  return analyticsMetricCatalogSize();
}

/** L3 — count of ratio-kind metrics in v0 catalog. */
export function ratioMetricCount(): number {
  return countMetricsByKind('ratio');
}

/** L3 — count of amount-kind metrics in v0 catalog. */
export function amountMetricCount(): number {
  return countMetricsByKind('amount');
}

/** L3 — count of count-kind metrics in v0 catalog. */
export function countKindMetricCount(): number {
  return countMetricsByKind('count');
}

/** L3 — true when catalog has any ratio-kind metric. */
export function hasRatioMetrics(): boolean {
  return countMetricsByKind('ratio') > 0;
}

/** L3 — true when catalog has any amount-kind metric. */
export function hasAmountMetrics(): boolean {
  return countMetricsByKind('amount') > 0;
}

/** L3 — true when catalog has any count-kind metric. */
export function hasCountKindMetrics(): boolean {
  return countMetricsByKind('count') > 0;
}

/**
 * L3 — multi-source / total as fixed 4dp. Empty catalog → null.
 */
export function multiSourceMetricRatio(): string | null {
  const total = analyticsMetricCatalogSize();
  if (total === 0) return null;
  return (multiSourceMetricCount() / total).toFixed(4);
}

/** L3 — ledger-source metric count. */
export function ledgerSourceMetricCount(): number {
  return countMetricsUsingSource('ledger');
}

/** L3 — trade-source metric count. */
export function tradeSourceMetricCount(): number {
  return countMetricsUsingSource('trade');
}

/** L3 — identity-source metric count. */
export function identitySourceMetricCount(): number {
  return countMetricsUsingSource('identity');
}

/**
 * L3 — single-source / total as fixed 4dp. Empty → null.
 */
export function singleSourceMetricRatio(): string | null {
  const total = analyticsMetricCatalogSize();
  if (total === 0) return null;
  return (singleSourceMetricCount() / total).toFixed(4);
}

/** L3 — true when ledger is used by any metric. */
export function hasLedgerSourceMetrics(): boolean {
  return countMetricsUsingSource('ledger') > 0;
}

/** L3 — true when trade is used by any metric. */
export function hasTradeSourceMetrics(): boolean {
  return countMetricsUsingSource('trade') > 0;
}

/** L3 — true when identity is used by any metric. */
export function hasIdentitySourceMetrics(): boolean {
  return countMetricsUsingSource('identity') > 0;
}

/**
 * L3 — ledger/total share as fixed 4dp (by source membership, not exclusive). Empty → null.
 */
export function ledgerSourceShare(): string | null {
  const total = analyticsMetricCatalogSize();
  if (total === 0) return null;
  return (countMetricsUsingSource('ledger') / total).toFixed(4);
}

/**
 * L3 — trade/total share as fixed 4dp. Empty → null.
 */
export function tradeSourceShare(): string | null {
  const total = analyticsMetricCatalogSize();
  if (total === 0) return null;
  return (countMetricsUsingSource('trade') / total).toFixed(4);
}

/**
 * L3 — identity/total share as fixed 4dp. Empty → null.
 */
export function identitySourceShare(): string | null {
  const total = analyticsMetricCatalogSize();
  if (total === 0) return null;
  return (countMetricsUsingSource('identity') / total).toFixed(4);
}

/** L3 — true when every source DB has ≥1 metric. */
export function allSourcesRepresented(): boolean {
  return countMetricsUsingSource('ledger') > 0 && countMetricsUsingSource('trade') > 0 && countMetricsUsingSource('identity') > 0;
}

/** L3 — how many of the three source DBs appear in the catalog. */
export function representedSourceCount(): number {
  let n = 0;
  if (countMetricsUsingSource('ledger') > 0) n += 1;
  if (countMetricsUsingSource('trade') > 0) n += 1;
  if (countMetricsUsingSource('identity') > 0) n += 1;
  return n;
}

/** L3 — true when catalog size is at least n. */
export function catalogHasAtLeast(n: number): boolean {
  if (!Number.isFinite(n) || n < 0) return false;
  return analyticsMetricCatalogSize() >= Math.floor(n);
}

/** L3 — first money metric id (sorted). None → null. */
export function firstMoneyMetricId(): string | null {
  const ids = listMoneyMetricIds();
  return ids[0] ?? null;
}

/** L3 — first non-money metric id (sorted). None → null. */
export function firstNonMoneyMetricId(): string | null {
  const ids = listNonMoneyMetricIds();
  return ids[0] ?? null;
}

/**
 * L3 — money + non-money counts as pair. Empty zeros.
 */
export function moneyNonMoneyPair(): { readonly money: number; readonly nonMoney: number } {
  return { money: moneyMetricCount(), nonMoney: nonMoneyMetricCount() };
}

/** L3 — catalog size label. */
export function catalogMetricCountLabel(): string {
  return String(catalogMetricCount());
}

/** L3 — money metric count label. */
export function moneyMetricCountLabel(): string {
  return String(moneyMetricCount());
}

/** L3 — non-money metric count label. */
export function nonMoneyMetricCountLabel(): string {
  return String(nonMoneyMetricCount());
}

/** L3 — comma-joined money metric ids. Empty → "". */
export function moneyMetricIdsJoined(): string {
  return listMoneyMetricIds().join(',');
}

/** L3 — non-money metric ids joined. Empty → "". */
export function nonMoneyMetricIdsJoined(): string {
  return listNonMoneyMetricIds().join(',');
}

/** L3 — ledger metric ids joined. Empty → "". */
export function ledgerMetricIdsJoined(): string {
  return listMetricIdsUsingSource('ledger').join(',');
}

/** L3 — trade metric ids joined. Empty → "". */
export function tradeMetricIdsJoined(): string {
  return listMetricIdsUsingSource('trade').join(',');
}

/** L3 — identity metric ids joined. Empty → "". */
export function identityMetricIdsJoined(): string {
  return listMetricIdsUsingSource('identity').join(',');
}

/** L3 — money metric ratio label or empty. */
export function moneyMetricRatioLabel(): string {
  return moneyMetricRatio() ?? '';
}

/** L3 — non-money metric ratio label or empty. */
export function nonMoneyMetricRatioLabel(): string {
  return nonMoneyMetricRatio() ?? '';
}

/** L3 — multi-source ratio label or empty. */
export function multiSourceMetricRatioLabel(): string {
  return multiSourceMetricRatio() ?? '';
}

/** L3 — single-source ratio label or empty. */
export function singleSourceMetricRatioLabel(): string {
  return singleSourceMetricRatio() ?? '';
}

/** L3 — money partition snapshot. */
export function catalogMoneySnapshot(): {
  readonly money: number;
  readonly nonMoney: number;
  readonly total: number;
} {
  return metricMoneyPartition();
}

/** L3 — true when money partition sums. */
export function catalogMoneyCountsConsistent(): boolean {
  const s = catalogMoneySnapshot();
  return s.total === s.money + s.nonMoney;
}

/** L3 — kind partition snapshot. */
export function catalogKindSnapshot(): {
  readonly count: number;
  readonly amount: number;
  readonly ratio: number;
  readonly total: number;
} {
  return {
    count: countKindMetricCount(),
    amount: amountMetricCount(),
    ratio: ratioMetricCount(),
    total: analyticsMetricCatalogSize(),
  };
}

/** L3 — true when kind partition sums to catalog size. */
export function catalogKindCountsConsistent(): boolean {
  const s = catalogKindSnapshot();
  return s.total === s.count + s.amount + s.ratio;
}

/** L3 — analytics catalog board card. */
export function analyticsCatalogBoardCard(): {
  readonly total: number;
  readonly money: number;
  readonly nonMoney: number;
  readonly multiSource: number;
  readonly singleSource: number;
  readonly nonEmpty: boolean;
  readonly moneyRatio: string | null;
  readonly sourcesRepresented: number;
} {
  return {
    total: analyticsMetricCatalogSize(),
    money: moneyMetricCount(),
    nonMoney: nonMoneyMetricCount(),
    multiSource: multiSourceMetricCount(),
    singleSource: singleSourceMetricCount(),
    nonEmpty: catalogIsNonEmpty(),
    moneyRatio: moneyMetricRatio(),
    sourcesRepresented: representedSourceCount(),
  };
}

/** L3 — true when catalog board is non-empty. */
export function analyticsCatalogBoardNonEmpty(): boolean {
  return analyticsCatalogBoardCard().nonEmpty;
}

/** L3 — money partition for board. */
export function analyticsMoneyBoard(): { readonly money: number; readonly nonMoney: number; readonly total: number } {
  return catalogMoneySnapshot();
}

/** L3 — kind partition for board. */
export function analyticsKindBoard(): {
  readonly count: number;
  readonly amount: number;
  readonly ratio: number;
  readonly total: number;
} {
  return catalogKindSnapshot();
}

/** L3 — search metric ids by substring. Empty needle → []. */
export function searchMetricIds(needle: string): readonly string[] {
  const n = needle.trim();
  if (!n) return [];
  return ANALYTICS_METRICS_V0.map((m) => m.id)
    .filter((id) => id.includes(n))
    .sort();
}

/** L3 — filter metric ids by kind. Empty → []. */
export function filterMetricIdsByKind(kind: 'count' | 'amount' | 'ratio'): readonly string[] {
  return listMetricIdsByKind(kind);
}

/** L3 — true when search has hits. */
export function metricSearchHasHits(needle: string): boolean {
  return searchMetricIds(needle).length > 0;
}

/** L3 — count search hits. */
export function metricSearchHitCount(needle: string): number {
  return searchMetricIds(needle).length;
}

/** Product window — omit must not invent `all.length`. */
export function requireAnalyticsPageLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new Error('ops-analytics page limit is unset — pass limit (never invent all.length)');
  }
  return Math.max(0, Math.floor(limit));
}

/** L3 — page metric ids (sorted from catalog order filtered). Empty → []. */
export function pageMetricIds(options: { offset?: number; limit: number }): readonly string[] {
  const all = ANALYTICS_METRICS_V0.map((m) => m.id).sort();
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = requireAnalyticsPageLimit(options.limit);
  return all.slice(offset, offset + limit);
}

/** L3 — page money metric ids. Empty → []. */
export function pageMoneyMetricIds(options: { offset?: number; limit: number }): readonly string[] {
  const all = listMoneyMetricIds();
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = requireAnalyticsPageLimit(options.limit);
  return all.slice(offset, offset + limit);
}

/** L3 — catalog page count. */
export function metricCatalogPageCount(pageSize: number): number {
  if (!Number.isFinite(pageSize) || pageSize < 1) return 0;
  const n = analyticsMetricCatalogSize();
  if (n === 0) return 0;
  return Math.ceil(n / Math.floor(pageSize));
}

/** L3 — reverse sorted metric ids. Empty → []. */
export function reverseMetricIds(): readonly string[] {
  return [...ANALYTICS_METRICS_V0.map((m) => m.id).sort()].reverse();
}

/** L3 — money metric ids only (vs non-money set is automatic). Alias surface of list. */
export function moneyMetricIdsOnly(): readonly string[] {
  return listMoneyMetricIds();
}

/** L3 — metric ids only in kind A not B. */
export function metricIdsOnlyInKind(kind: 'count' | 'amount' | 'ratio', excludeKind: 'count' | 'amount' | 'ratio'): readonly string[] {
  const exclude = new Set(listMetricIdsByKind(excludeKind));
  return listMetricIdsByKind(kind).filter((id) => !exclude.has(id));
}

/** L3 — money count delta vs non-money count (money - nonMoney). */
export function moneyMinusNonMoneyCount(): number {
  return moneyMetricCount() - nonMoneyMetricCount();
}

/** L3 — true when multi-source count equals single-source count. */
export function multiEqualsSingleSourceCount(): boolean {
  return multiSourceMetricCount() === singleSourceMetricCount();
}

/** L3 — safe page metric ids with clamped bounds. */
export function safePageMetricIds(offset: number, limit: number): readonly string[] {
  if (!Number.isFinite(offset) || !Number.isFinite(limit)) return [];
  const all = ANALYTICS_METRICS_V0.map((m) => m.id).sort();
  const o = Math.max(0, Math.min(all.length, Math.floor(offset)));
  const l = Math.max(0, Math.min(all.length - o, Math.floor(limit)));
  return all.slice(o, o + l);
}

/** L3 — clamp metric catalog page index. */
export function clampMetricPageIndex(pageIndex: number, pageSize: number): number {
  const pages = metricCatalogPageCount(pageSize);
  if (pages === 0) return 0;
  if (!Number.isFinite(pageIndex)) return 0;
  return Math.max(0, Math.min(pages - 1, Math.floor(pageIndex)));
}

/** L3 — metric ids at clamped page. */
export function metricIdsAtPage(pageIndex: number, pageSize: number): readonly string[] {
  if (!Number.isFinite(pageSize) || pageSize < 1) return [];
  const idx = clampMetricPageIndex(pageIndex, pageSize);
  const size = Math.floor(pageSize);
  return safePageMetricIds(idx * size, size);
}

/** L3 — true when metric catalog page is valid. */
export function isValidMetricPage(pageIndex: number, pageSize: number): boolean {
  const pages = metricCatalogPageCount(pageSize);
  if (pages === 0) return false;
  if (!Number.isFinite(pageIndex)) return false;
  const i = Math.floor(pageIndex);
  return i >= 0 && i < pages;
}

/** L3 — export lines: id,kind,moneyFlag. Empty → []. */
export function metricsExportLines(): readonly string[] {
  return ANALYTICS_METRICS_V0.map((m) => `${m.id},${m.kind},${m.money ? 'money' : 'non_money'}`).sort();
}

/** L3 — metrics export header. */
export function metricsExportHeader(): string {
  return 'id,kind,money';
}

/** L3 — full metrics export text. */
export function metricsExportText(): string {
  return [metricsExportHeader(), ...metricsExportLines()].join('\n');
}

/** L3 — export line count including header. */
export function metricsExportLineCount(): number {
  return 1 + analyticsMetricCatalogSize();
}

/**
 * L3 — parse "id,kind,money". Invalid → null.
 */
export function parseMetricsExportLine(line: string): { readonly id: string; readonly kind: string; readonly money: boolean } | null {
  const t = line.trim();
  if (!t || t === metricsExportHeader()) return null;
  const parts = t.split(',');
  if (parts.length !== 3) return null;
  const id = parts[0]!.trim();
  const kind = parts[1]!.trim();
  const moneyFlag = parts[2]!.trim();
  if (!id) return null;
  if (kind !== 'count' && kind !== 'amount' && kind !== 'ratio') return null;
  if (moneyFlag !== 'money' && moneyFlag !== 'non_money') return null;
  return { id, kind, money: moneyFlag === 'money' };
}

/** L3 — count valid metrics export data lines. */
export function countMetricsExportDataLines(text: string): number {
  return text
    .split('\n')
    .map((l) => parseMetricsExportLine(l))
    .filter((r) => r !== null).length;
}

/** L3 — true when metrics export has header. */
export function metricsExportHasHeader(text: string): boolean {
  const first = text.split('\n')[0]?.trim() ?? '';
  return first === metricsExportHeader();
}

/** L3 — round-trip metrics export line count. */
export function metricsExportRoundTripOk(): boolean {
  return metricsExportLineCount() === 1 + countMetricsExportDataLines(metricsExportText());
}

/** L3 — one-line analytics catalog status. */
export function analyticsStatusLine(): string {
  const c = analyticsCatalogBoardCard();
  return `total=${c.total} money=${c.money} nonMoney=${c.nonMoney}`;
}

/** L3 — true when analytics status is empty. */
export function analyticsStatusLineIsEmpty(): boolean {
  return analyticsStatusLine().startsWith('total=0');
}

/** L3 — detailed analytics status. */
export function analyticsStatusLineDetailed(): string {
  const c = analyticsCatalogBoardCard();
  return `total=${c.total} money=${c.money} nonMoney=${c.nonMoney} multi=${c.multiSource} single=${c.singleSource} sources=${c.sourcesRepresented}`;
}

/** L3 — token count on detailed analytics status. */
export function analyticsStatusLineTokenCount(): number {
  return analyticsStatusLineDetailed().split(/\s+/).filter(Boolean).length;
}

/** L3 — parse analytics status line. Invalid → null. */
export function parseAnalyticsStatusLine(
  line: string,
): { readonly total: number; readonly money: number; readonly nonMoney: number } | null {
  const m = line.trim().match(/^total=(\d+) money=(\d+) nonMoney=(\d+)$/);
  if (!m) return null;
  return { total: Number(m[1]), money: Number(m[2]), nonMoney: Number(m[3]) };
}

/** L3 — true when status line matches catalog. */
export function analyticsStatusLineMatches(): boolean {
  const p = parseAnalyticsStatusLine(analyticsStatusLine());
  if (!p) return false;
  const c = analyticsCatalogBoardCard();
  return p.total === c.total && p.money === c.money && p.nonMoney === c.nonMoney;
}

/** L3 — parse detailed analytics status. Invalid → null. */
export function parseAnalyticsStatusLineDetailed(line: string): {
  readonly total: number;
  readonly money: number;
  readonly nonMoney: number;
  readonly multi: number;
  readonly single: number;
  readonly sources: number;
} | null {
  const m = line.trim().match(/^total=(\d+) money=(\d+) nonMoney=(\d+) multi=(\d+) single=(\d+) sources=(\d+)$/);
  if (!m) return null;
  return {
    total: Number(m[1]),
    money: Number(m[2]),
    nonMoney: Number(m[3]),
    multi: Number(m[4]),
    single: Number(m[5]),
    sources: Number(m[6]),
  };
}

/** L3 — true when money+nonMoney equals total. */
export function analyticsStatusLineConsistent(line: string): boolean {
  const p = parseAnalyticsStatusLine(line);
  if (!p) return false;
  return p.total === p.money + p.nonMoney;
}

/** L3 — true when catalog size is within [min,max]. Invalid → false. */
export function catalogSizeInRange(min: number, max: number): boolean {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return false;
  const n = analyticsMetricCatalogSize();
  return n >= min && n <= max;
}

/** L3 — true when money metric count is at least n. */
export function moneyMetricCountAtLeast(n: number): boolean {
  if (!Number.isFinite(n)) return false;
  return moneyMetricCount() >= n;
}

/** L3 — clamp metric page size into [1, catalog] (empty → 1). */
export function clampMetricPageSize(pageSize: number): number {
  if (!Number.isFinite(pageSize)) return 1;
  const total = Math.max(1, analyticsMetricCatalogSize());
  return Math.max(1, Math.min(total, Math.floor(pageSize)));
}

/** L3 — true when multi-source count is at most n. */
export function multiSourceCountAtMost(n: number): boolean {
  if (!Number.isFinite(n)) return false;
  return multiSourceMetricCount() <= n;
}
