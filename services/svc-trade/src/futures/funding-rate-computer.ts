/**
 * FUNDING RATE COMPUTER (D-instruments-01, derivatives-instruments-pricing-001; ENGINE FD-1, FD-2, FD-4).
 *
 * One period's rate is
 *
 *     clamp( trimmedMean(premium samples) + owner base component , -cap , +cap )
 *
 * where a premium sample is `(mark - index) / index`, taken at the owner cadence. Samples are sorted by premium,
 * the owner's trim ratio is cut from EACH tail, and the rest is averaged.
 *
 * ── What this file refuses to do ────────────────────────────────────────────
 *
 *  - A blank owner number is not zero. Base component, cap, cadence, trim ratio and minimum samples are read from
 *    `trade.funding_params`; any blank one refuses the period with `trade.funding_rate_unset`, the refusal is
 *    stored, and nothing is published.
 *  - A missing sample is a GAP. It is excluded from the average (never averaged in as zero) and it counts against
 *    the minimum. Fewer valid samples than the minimum refuses the period.
 *  - A stale index pauses the period (FD-4). Nothing is published; the next run looks again.
 *  - A closed (published) period is immutable. Computing it again returns the stored rate, whatever the samples or
 *    parameters have become since.
 *
 * ── How the rate reaches the funding tick ────────────────────────────────────
 *
 * A published rate is handed to `deps.publish`, the same `FundingRateEntry` seam the internal publish route uses
 * (`funding-rate-source.ts`). `runFundingTick` reads it through its `FundingRateSource` and keeps freezing the first
 * rate it sees per period. This file never posts a leg and never imports a ledger recipe.
 *
 * Money in memory is scaled bigint; rates and prices are decimal strings at rest and on the wire.
 */
import type { Sql } from 'postgres';
import { div, formatAmount, parseAmount, SCALE, type Amount } from '@intafaced/ledger-client';
import type { MarkSource } from './liquidation-tick.js';
import type { FundingRateEntry } from './funding-rate-source.js';
import { periodIdFor } from './funding-rate-source.js';
import { assertFundingRateWithinBound, FundingRateBoundError } from './funding-rate-bound.js';
import {
  FUNDING_RATE_UNSET,
  missingFundingParams,
  missingWindowParams,
  type FundingParams,
  type FundingParamsVersion,
  type IndexSourcesVersion,
} from './funding-params.js';
import { buildIndex, missingIndexParams, type IndexFeed, type IndexResult } from './index-construction.js';
import type { VenueLatencyHealth } from './venue-latency-health.js';

export const FUNDING_SAMPLES_INSUFFICIENT = 'trade.funding_samples_insufficient';
export const FUNDING_INDEX_STALE = 'trade.funding_index_stale';
export const FUNDING_PERIOD_OPEN = 'trade.funding_period_open';
/**
 * A window that overlaps a published period of the market without being that period. A period length or anchor
 * change would otherwise charge the overlap twice (a shorter or re-anchored window) or skip time (a longer window
 * reusing a settled period id).
 */
export const FUNDING_WINDOW_OVERLAPS = 'trade.funding_window_overlaps';

// ── Pure math ────────────────────────────────────────────────────────────────

export interface PremiumSample {
  readonly mark: Amount;
  readonly index: Amount;
}

/** `(mark - index) / index`, rounded half-up at 18 decimals. Index must be positive. */
export function premiumOf(sample: PremiumSample): Amount {
  return div(sample.mark - sample.index, sample.index, 'half-up');
}

export interface TrimmedPremium {
  readonly premium: Amount;
  readonly trimmedPerTail: number;
  readonly kept: number;
  readonly dropped: readonly Amount[];
}

/**
 * Sort by premium, drop `floor(n * trimRatioBps / 10000)` from each tail, average the rest (half-up).
 * Returns null when nothing would be left. `trimRatioBps` below 5000 always leaves at least one.
 */
export function trimmedMeanPremium(premiums: readonly Amount[], trimRatioBps: number): TrimmedPremium | null {
  const n = premiums.length;
  if (n === 0) return null;
  const sorted = [...premiums].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const k = Number((BigInt(n) * BigInt(trimRatioBps)) / 10_000n);
  const kept = sorted.slice(k, n - k);
  if (kept.length === 0) return null;
  let total = 0n;
  for (const p of kept) total += p;
  const premium = div(total, BigInt(kept.length) * SCALE, 'half-up');
  return { premium, trimmedPerTail: k, kept: kept.length, dropped: [...sorted.slice(0, k), ...sorted.slice(n - k)] };
}

/** Clamp to `[-cap, +cap]`. */
export function clampToCap(raw: Amount, cap: Amount): { rate: Amount; clamped: boolean } {
  if (raw > cap) return { rate: cap, clamped: true };
  if (raw < -cap) return { rate: -cap, clamped: true };
  return { rate: raw, clamped: false };
}

// ── Stores ───────────────────────────────────────────────────────────────────

export interface FundingSampleRow {
  readonly sampledAt: Date;
  readonly mark: Amount | null;
  readonly index: Amount | null;
  readonly gapReason: string | null;
}

export interface FundingSampleStore {
  /** Idempotent on (marketId, slot). The first write of a slot wins. */
  record(marketId: string, row: FundingSampleRow): Promise<void>;
  /** Samples with `start <= sampledAt < end`, oldest first. */
  window(marketId: string, start: Date, end: Date): Promise<readonly FundingSampleRow[]>;
}

export function sqlFundingSampleStore(sql: Sql): FundingSampleStore {
  return {
    async record(marketId, row) {
      await sql`INSERT INTO trade.funding_rate_samples (market_id, sampled_at, mark, index_price, gap_reason)
        VALUES (${marketId}, ${row.sampledAt.toISOString()},
                ${row.mark == null ? null : formatAmount(row.mark)}, ${row.index == null ? null : formatAmount(row.index)},
                ${row.gapReason})
        ON CONFLICT (market_id, sampled_at) DO NOTHING`;
    },
    async window(marketId, start, end) {
      const rows = await sql<Array<{ sampled_at: Date; mark: string | null; index_price: string | null; gap_reason: string | null }>>`
        SELECT sampled_at, mark::text, index_price::text, gap_reason
          FROM trade.funding_rate_samples
         WHERE market_id = ${marketId} AND sampled_at >= ${start.toISOString()} AND sampled_at < ${end.toISOString()}
         ORDER BY sampled_at ASC`;
      return rows.map((r) => ({
        sampledAt: r.sampled_at,
        mark: r.mark == null ? null : parseAmount(r.mark),
        index: r.index_price == null ? null : parseAmount(r.index_price),
        gapReason: r.gap_reason,
      }));
    },
  };
}

export type FundingPeriodStatus = 'published' | 'refused' | 'paused';

export interface FundingRatePeriodRecord {
  readonly periodId: string;
  readonly marketId: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly status: FundingPeriodStatus;
  /** Refusal or pause code. Null exactly when published. */
  readonly code: string | null;
  readonly message: string | null;
  /** Decimal string. Null unless published. */
  readonly rate: string | null;
  readonly premium: string | null;
  readonly baseComponent: string | null;
  readonly cap: string | null;
  readonly clamped: boolean;
  readonly paramsVersion: string | null;
  readonly inputs: Record<string, unknown>;
  readonly attempts: number;
  readonly computedAt: string;
}

export type FundingRatePeriodWrite = Omit<FundingRatePeriodRecord, 'attempts' | 'computedAt'>;

export interface FundingRatePeriodStore {
  get(periodId: string): Promise<FundingRatePeriodRecord | null>;
  /**
   * Write a computed period. A published period is never overwritten: the stored one is returned. A refused or
   * paused period is replaced and its attempt count grows.
   */
  save(row: FundingRatePeriodWrite): Promise<FundingRatePeriodRecord>;
  /** Newest first. `limit` is required. */
  recent(input: { marketId: string | null; limit: number }): Promise<readonly FundingRatePeriodRecord[]>;
  /** The end of the market's latest published period, or null when none is published. */
  latestPublishedEnd(marketId: string): Promise<Date | null>;
  /** A published period of the market that overlaps `[start, end)` and is not exactly that window, or null. */
  overlappingPublished(marketId: string, start: Date, end: Date): Promise<FundingRatePeriodRecord | null>;
}

interface PeriodRow {
  period_id: string;
  market_id: string;
  period_start: Date | null;
  period_end: Date | null;
  status: FundingPeriodStatus;
  code: string | null;
  message: string | null;
  rate: string | null;
  premium: string | null;
  base_component: string | null;
  cap: string | null;
  clamped: boolean;
  params_version: string | null;
  inputs: Record<string, unknown>;
  attempts: number;
  computed_at: Date;
}

function presentPeriod(r: PeriodRow): FundingRatePeriodRecord {
  return {
    periodId: r.period_id,
    marketId: r.market_id,
    periodStart: r.period_start ? r.period_start.toISOString() : null,
    periodEnd: r.period_end ? r.period_end.toISOString() : null,
    status: r.status,
    code: r.code,
    message: r.message,
    rate: r.rate,
    premium: r.premium,
    baseComponent: r.base_component,
    cap: r.cap,
    clamped: r.clamped,
    paramsVersion: r.params_version,
    inputs: r.inputs,
    attempts: r.attempts,
    computedAt: r.computed_at.toISOString(),
  };
}

export function sqlFundingRatePeriodStore(sql: Sql): FundingRatePeriodStore {
  async function get(periodId: string): Promise<FundingRatePeriodRecord | null> {
    const [row] = await sql<PeriodRow[]>`
      SELECT period_id, market_id, period_start, period_end, status, code, message, rate, premium, base_component, cap,
             clamped, params_version::text, inputs, attempts, computed_at
        FROM trade.funding_rate_periods WHERE period_id = ${periodId}`;
    return row ? presentPeriod(row) : null;
  }
  return {
    get,
    async save(w) {
      await sql`INSERT INTO trade.funding_rate_periods (
          period_id, market_id, period_start, period_end, status, code, message, rate, premium, base_component, cap,
          clamped, params_version, inputs
        ) VALUES (
          ${w.periodId}, ${w.marketId}, ${w.periodStart}, ${w.periodEnd}, ${w.status}, ${w.code}, ${w.message}, ${w.rate},
          ${w.premium}, ${w.baseComponent}, ${w.cap}, ${w.clamped}, ${w.paramsVersion}::bigint, ${sql.json(w.inputs as never)}
        )
        ON CONFLICT (period_id) DO UPDATE SET
          status = EXCLUDED.status, code = EXCLUDED.code, message = EXCLUDED.message, rate = EXCLUDED.rate,
          premium = EXCLUDED.premium, base_component = EXCLUDED.base_component, cap = EXCLUDED.cap,
          clamped = EXCLUDED.clamped, params_version = EXCLUDED.params_version, inputs = EXCLUDED.inputs,
          period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end,
          attempts = trade.funding_rate_periods.attempts + 1, computed_at = clock_timestamp()
        WHERE trade.funding_rate_periods.status <> 'published'`;
      const stored = await get(w.periodId);
      if (!stored) throw new Error(`funding period ${w.periodId} was not readable after save`);
      return stored;
    },
    async recent({ marketId, limit }) {
      const rows = await sql<PeriodRow[]>`
        SELECT period_id, market_id, period_start, period_end, status, code, message, rate, premium, base_component, cap,
               clamped, params_version::text, inputs, attempts, computed_at
          FROM trade.funding_rate_periods
         WHERE ${marketId === null ? sql`true` : sql`market_id = ${marketId}`}
         ORDER BY computed_at DESC, period_id DESC
         LIMIT ${limit}`;
      return rows.map(presentPeriod);
    },
    async latestPublishedEnd(marketId) {
      const [row] = await sql<{ end: Date | null }[]>`
        SELECT max(period_end) AS end FROM trade.funding_rate_periods WHERE market_id = ${marketId} AND status = 'published'`;
      return row?.end ?? null;
    },
    async overlappingPublished(marketId, start, end) {
      const [row] = await sql<PeriodRow[]>`
        SELECT period_id, market_id, period_start, period_end, status, code, message, rate, premium, base_component, cap,
               clamped, params_version::text, inputs, attempts, computed_at
          FROM trade.funding_rate_periods
         WHERE market_id = ${marketId} AND status = 'published'
           AND period_start < ${end} AND period_end > ${start}
           AND NOT (period_start = ${start} AND period_end = ${end})
         ORDER BY period_end DESC
         LIMIT 1`;
      return row ? presentPeriod(row) : null;
    },
  };
}

// ── Index health ─────────────────────────────────────────────────────────────

/**
 * What the computer needs to know about the index at close:
 *  - green: usable.
 *  - red: stale or too thin. The period PAUSES (FD-4) and is looked at again next run.
 *  - refused: not buildable at all (NotConnected `feed.market`, or a blank index number). The period is refused.
 */
export type IndexHealth =
  | { readonly state: 'green' }
  | { readonly state: 'red'; readonly code: string; readonly message: string }
  | { readonly state: 'refused'; readonly code: string; readonly message: string };

export interface IndexHealthPort {
  check(marketId: string, at: Date): Promise<IndexHealth>;
}

/** The index as one result: a built index, or the reason there is none. */
export type CurrentIndex =
  | { readonly ok: true; readonly price: Amount }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly health: 'red' | 'refused' };

export interface IndexProvider {
  current(marketId: string, at: Date): Promise<CurrentIndex>;
}

/**
 * Build the index for a market from the feed and the operator's source list.
 *
 * `venueHealth`, when given, can turn a built index red: the one grade the venue fabric puts at the bottom of its
 * scale (F) is a red venue. Other grades, and an unmeasured venue, are not red (an ungraded venue is not a low score).
 */
export function indexProviderFromFeed(deps: {
  feed: IndexFeed;
  sources: (marketId: string) => Promise<IndexSourcesVersion>;
  venueHealth?: () => VenueLatencyHealth;
}): IndexProvider {
  return {
    async current(marketId, at) {
      const cfg = await deps.sources(marketId);
      const blank = missingIndexParams(cfg.config.params);
      if (blank.length > 0) {
        return {
          ok: false,
          health: 'refused',
          code: 'trade.index_params_unset',
          message: `trade.index_params_unset: ${blank.join(', ')} blank for index sources v${cfg.version}`,
        };
      }
      const enabled = cfg.config.sources.filter((s) => s.enabled);
      const read = await deps.feed.read({ marketId, sourceIds: enabled.map((s) => s.sourceId), at });
      if (!read.connected) return { ok: false, health: 'refused', code: read.notConnected, message: read.message };
      const built: IndexResult = buildIndex({ quotes: read.quotes, sources: cfg.config.sources, params: cfg.config.params, at });
      if (!built.ok) return { ok: false, health: 'red', code: built.code, message: built.message };
      const venue = deps.venueHealth?.();
      if (venue && venue.configured && venue.grade === 'F') {
        return { ok: false, health: 'red', code: FUNDING_INDEX_STALE, message: `${FUNDING_INDEX_STALE}: venue health is red (grade F)` };
      }
      return { ok: true, price: built.price };
    },
  };
}

export function indexHealthFromProvider(provider: IndexProvider): IndexHealthPort {
  return {
    async check(marketId, at) {
      const r = await provider.current(marketId, at);
      if (r.ok) return { state: 'green' };
      return { state: r.health, code: r.code, message: r.message };
    },
  };
}

// ── Sampler ──────────────────────────────────────────────────────────────────

export interface TakeSampleDeps {
  params: (marketId: string) => Promise<FundingParamsVersion>;
  marks: Pick<MarkSource, 'markPrice'>;
  index: IndexProvider;
  samples: FundingSampleStore;
}

export type TakeSampleResult =
  | { status: 'skipped'; code: typeof FUNDING_RATE_UNSET; message: string }
  | { status: 'recorded'; sampledAt: string; gap: boolean; gapReason: string | null };

/**
 * Record the sample for the cadence slot containing `at`. A missing mark or index is stored as a gap with its
 * reason. Calling twice in one slot keeps the first row.
 */
export async function takeFundingSample(deps: TakeSampleDeps, marketId: string, at: Date): Promise<TakeSampleResult> {
  const { params } = await deps.params(marketId);
  if (params.cadenceSeconds == null) {
    return {
      status: 'skipped',
      code: FUNDING_RATE_UNSET,
      message: `${FUNDING_RATE_UNSET}: cadenceSeconds is blank, so no sample slot exists`,
    };
  }
  const slotMs = params.cadenceSeconds * 1000;
  const sampledAt = new Date(Math.floor(at.getTime() / slotMs) * slotMs);

  let mark: Amount | null = null;
  const rawMark = await deps.marks.markPrice({ marketId, at });
  if (rawMark != null) {
    try {
      const parsed = parseAmount(rawMark);
      if (parsed > 0n) mark = parsed;
    } catch {
      mark = null;
    }
  }
  const idx = await deps.index.current(marketId, at);
  const index = idx.ok ? idx.price : null;

  const reasons: string[] = [];
  if (mark === null) reasons.push('mark_unavailable');
  if (!idx.ok) reasons.push(idx.code);
  const gapReason = reasons.length > 0 ? reasons.join('+') : null;
  await deps.samples.record(marketId, { sampledAt, mark, index, gapReason });
  return { status: 'recorded', sampledAt: sampledAt.toISOString(), gap: gapReason !== null, gapReason };
}

// ── Period computer ──────────────────────────────────────────────────────────

export interface ComputePeriodDeps {
  params: (marketId: string) => Promise<FundingParamsVersion>;
  samples: FundingSampleStore;
  periods: FundingRatePeriodStore;
  indexHealth: IndexHealthPort;
  /** The existing rate source seam: `startFuturesJobs().publishFundingRate`, i.e. the rate book `runFundingTick` reads. */
  publish: (entry: FundingRateEntry) => void;
  /** `TRADE_FUTURES_FUNDING_MAX_ABS_RATE`. A rate over it, or no bound at all, is refused exactly as on the S2S publish route. */
  maxAbsRate: string | null;
  now?: () => Date;
}

export type ComputePeriodResult =
  | { status: 'published'; periodId: string; rate: string; clamped: boolean; replayed: boolean; record: FundingRatePeriodRecord }
  | { status: 'refused' | 'paused'; periodId: string; code: string; message: string; record: FundingRatePeriodRecord };

function canonicalInstant(d: Date): string {
  return d.toISOString();
}

function paramsSnapshot(p: FundingParams): Record<string, unknown> {
  return {
    baseComponent: p.baseComponent,
    cap: p.cap,
    cadenceSeconds: p.cadenceSeconds,
    trimRatioBps: p.trimRatioBps,
    minSamples: p.minSamples,
  };
}

/**
 * Compute, store and publish one CLOSED funding period `[periodStart, periodEnd)`.
 *
 * Idempotent on the period id. A published period returns its stored rate untouched; `opts.republish` hands that
 * stored entry to the rate source again (a restart empties the in-memory rate book, and the scheduled job uses this).
 */
export async function computeFundingPeriod(
  deps: ComputePeriodDeps,
  input: { marketId: string; periodStart: Date; periodEnd: Date },
  opts: { republish?: boolean } = {},
): Promise<ComputePeriodResult> {
  const now = (deps.now ?? (() => new Date()))();
  const { marketId, periodStart, periodEnd } = input;
  if (!(periodEnd.getTime() > periodStart.getTime())) {
    throw new Error('periodEnd must be after periodStart');
  }
  const startIso = canonicalInstant(periodStart);
  const endIso = canonicalInstant(periodEnd);
  const periodId = periodIdFor(marketId, startIso);

  const entryFor = (rate: string): FundingRateEntry => ({ marketId, periodId, rate, asOfMs: now.getTime(), periodEndIso: endIso });

  // Closed means closed: a published period returns what was stored. A published period under this id with another
  // end is a different window (the period length changed): it is refused below, never replayed as this one.
  const prior = await deps.periods.get(periodId);
  if (prior && prior.status === 'published' && prior.periodEnd === endIso) {
    if (opts.republish) deps.publish(entryFor(prior.rate!));
    return { status: 'published', periodId, rate: prior.rate!, clamped: prior.clamped, replayed: true, record: prior };
  }
  if (periodEnd.getTime() > now.getTime()) {
    throw Object.assign(new Error(`${FUNDING_PERIOD_OPEN}: period ${periodId} ends ${endIso}, which is after now`), {
      code: FUNDING_PERIOD_OPEN,
    });
  }

  const pv = await deps.params(marketId);

  // Funding time is charged once: a window that overlaps a settled period, without being it, is refused. The refusal
  // is stored under its own id, since a published period is never overwritten.
  const overlap = await deps.periods.overlappingPublished(marketId, periodStart, periodEnd);
  if (overlap) {
    const message = `${FUNDING_WINDOW_OVERLAPS}: window ${startIso} to ${endIso} overlaps published period ${overlap.periodStart} to ${overlap.periodEnd}; set the period anchor so a boundary falls on its end`;
    const record = await deps.periods.save({
      periodId: `${marketId}:window_overlap:${startIso}:${endIso}`,
      marketId,
      periodStart: startIso,
      periodEnd: endIso,
      status: 'refused',
      code: FUNDING_WINDOW_OVERLAPS,
      message,
      rate: null,
      premium: null,
      baseComponent: pv.params.baseComponent,
      cap: pv.params.cap,
      clamped: false,
      paramsVersion: pv.version,
      inputs: { paramsVersion: pv.version, overlaps: overlap.periodId },
    });
    return { status: 'refused', periodId: record.periodId, code: FUNDING_WINDOW_OVERLAPS, message, record };
  }

  const base = { periodId, marketId, periodStart: startIso, periodEnd: endIso, paramsVersion: pv.version };

  const refuse = async (
    status: 'refused' | 'paused',
    code: string,
    message: string,
    inputs: Record<string, unknown>,
    extra: Partial<Pick<FundingRatePeriodWrite, 'premium' | 'baseComponent' | 'cap'>> = {},
  ): Promise<ComputePeriodResult> => {
    const record = await deps.periods.save({
      ...base,
      status,
      code,
      message,
      rate: null,
      premium: extra.premium ?? null,
      baseComponent: extra.baseComponent ?? pv.params.baseComponent,
      cap: extra.cap ?? pv.params.cap,
      clamped: false,
      inputs: { paramsVersion: pv.version, params: paramsSnapshot(pv.params), ...inputs },
    });
    // A concurrent run closed this period first: the stored rate stands.
    if (record.status === 'published') {
      return { status: 'published', periodId, rate: record.rate!, clamped: record.clamped, replayed: true, record };
    }
    return { status, periodId, code, message, record };
  };

  // 1. Blank owner number: refuse, record, publish nothing.
  const blank = missingFundingParams(pv.params);
  if (blank.length > 0) {
    return refuse(
      'refused',
      FUNDING_RATE_UNSET,
      `${FUNDING_RATE_UNSET}: ${blank.join(', ')} ${blank.length === 1 ? 'is' : 'are'} blank (params v${pv.version})`,
      {
        missing: blank,
      },
    );
  }
  const p = pv.params;
  const baseAmt = parseAmount(p.baseComponent!);
  const capAmt = parseAmount(p.cap!);
  const cadenceMs = p.cadenceSeconds! * 1000;

  // 2. The index: not buildable refuses, stale pauses.
  const health = await deps.indexHealth.check(marketId, now);
  if (health.state === 'refused') return refuse('refused', health.code, health.message, { indexHealth: health.state });
  if (health.state === 'red')
    return refuse('paused', FUNDING_INDEX_STALE, health.message, { indexHealth: health.state, indexCode: health.code });

  // 3. Samples. A gap is excluded and counts against the minimum.
  const rows = await deps.samples.window(marketId, periodStart, periodEnd);
  const valid: Array<{ at: Date; premium: Amount }> = [];
  const gapReasons: Record<string, number> = {};
  for (const r of rows) {
    if (r.mark != null && r.index != null && r.mark > 0n && r.index > 0n) {
      valid.push({ at: r.sampledAt, premium: premiumOf({ mark: r.mark, index: r.index }) });
    } else {
      const reason = r.gapReason ?? 'missing_value';
      gapReasons[reason] = (gapReasons[reason] ?? 0) + 1;
    }
  }
  const expected = Math.floor((periodEnd.getTime() - periodStart.getTime()) / cadenceMs);
  const gaps = Math.max(expected - valid.length, 0);
  const counts = { expectedSamples: expected, validSamples: valid.length, gapSamples: gaps, gapReasons };

  if (valid.length < p.minSamples!) {
    return refuse(
      'refused',
      FUNDING_SAMPLES_INSUFFICIENT,
      `${FUNDING_SAMPLES_INSUFFICIENT}: ${valid.length} valid sample(s), ${gaps} gap(s), minimum ${p.minSamples}`,
      counts,
    );
  }

  // 4. Formula.
  const trimmed = trimmedMeanPremium(
    valid.map((v) => v.premium),
    p.trimRatioBps!,
  );
  if (!trimmed) {
    return refuse('refused', FUNDING_SAMPLES_INSUFFICIENT, `${FUNDING_SAMPLES_INSUFFICIENT}: trimming left no sample`, counts);
  }
  const raw = trimmed.premium + baseAmt;
  const { rate, clamped } = clampToCap(raw, capAmt);
  const rateText = formatAmount(rate);
  const inputs = {
    ...counts,
    trimmedPerTail: trimmed.trimmedPerTail,
    keptSamples: trimmed.kept,
    droppedPremiums: trimmed.dropped.map(formatAmount),
    rawRate: formatAmount(raw),
    indexHealth: health.state,
  };

  // 5. Same magnitude bound the S2S publish route applies, before anything is published.
  try {
    assertFundingRateWithinBound(rateText, deps.maxAbsRate);
  } catch (err) {
    if (err instanceof FundingRateBoundError) {
      return refuse('refused', err.code, err.message, inputs, { premium: formatAmount(trimmed.premium) });
    }
    throw err;
  }

  // 6. Durable first, then the seam.
  const record = await deps.periods.save({
    ...base,
    status: 'published',
    code: null,
    message: null,
    rate: rateText,
    premium: formatAmount(trimmed.premium),
    baseComponent: p.baseComponent,
    cap: p.cap,
    clamped,
    inputs: { paramsVersion: pv.version, params: paramsSnapshot(p), ...inputs },
  });
  // A concurrent run may have closed the period first: that stored rate is the rate.
  const finalRate = record.rate ?? rateText;
  deps.publish(entryFor(finalRate));
  return { status: 'published', periodId, rate: finalRate, clamped: record.clamped, replayed: false, record };
}

// ── Window placement (scheduled job) ─────────────────────────────────────────

/**
 * The latest period that has closed by `at`, from the owner's period length and anchor.
 * Null when either is blank.
 */
export function latestClosedWindow(params: FundingParams, at: Date): { periodStart: Date; periodEnd: Date } | null {
  if (missingWindowParams(params).length > 0) return null;
  const lenMs = params.periodSeconds! * 1000;
  const anchorMs = Date.parse(params.periodAnchor!);
  const elapsed = at.getTime() - anchorMs;
  if (elapsed < lenMs) return null;
  const closedCount = Math.floor(elapsed / lenMs);
  const endMs = anchorMs + closedCount * lenMs;
  return { periodStart: new Date(endMs - lenMs), periodEnd: new Date(endMs) };
}

/**
 * One scheduled run for one market: take a sample for the current slot, then compute the latest closed period.
 * Blank window numbers record ONE refusal per parameter version (`trade.funding_rate_unset`) and publish nothing.
 */
export async function runFundingComputerJob(
  deps: ComputePeriodDeps & Pick<TakeSampleDeps, 'marks' | 'index'>,
  marketId: string,
): Promise<{ sample: TakeSampleResult; period: ComputePeriodResult | null }> {
  const at = (deps.now ?? (() => new Date()))();
  const sample = await takeFundingSample(deps, marketId, at);
  const pv = await deps.params(marketId);
  const window = latestClosedWindow(pv.params, at);
  if (!window) {
    const blank = missingWindowParams(pv.params);
    if (blank.length === 0) return { sample, period: null }; // the first period has not closed yet
    const periodId = `${marketId}:window_unset:v${pv.version}`;
    const existing = await deps.periods.get(periodId);
    const message = `${FUNDING_RATE_UNSET}: ${blank.join(', ')} ${blank.length === 1 ? 'is' : 'are'} blank (params v${pv.version}), so no period window exists`;
    const record =
      existing ??
      (await deps.periods.save({
        periodId,
        marketId,
        periodStart: null,
        periodEnd: null,
        status: 'refused',
        code: FUNDING_RATE_UNSET,
        message,
        rate: null,
        premium: null,
        baseComponent: pv.params.baseComponent,
        cap: pv.params.cap,
        clamped: false,
        paramsVersion: pv.version,
        inputs: { paramsVersion: pv.version, missing: blank },
      }));
    return { sample, period: { status: 'refused', periodId, code: FUNDING_RATE_UNSET, message, record } };
  }
  const period = await computeFundingPeriod(deps, { marketId, ...window }, { republish: true });
  return { sample, period };
}
