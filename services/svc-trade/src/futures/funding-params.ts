/**
 * Owner funding parameters and index source lists, versioned per market (D-instruments-01).
 *
 * Every field is nullable and null means blank. Blank is never zero: the computer names the blank fields and
 * refuses the period with `trade.funding_rate_unset`. Nothing in this file has a default magnitude.
 *
 * Rows are append-only (0080). The current row is the highest version; no row at all is version "0" with every
 * field blank.
 */
import type { Sql } from 'postgres';
import { parseAmount } from '@intafaced/ledger-client';
import { TradeOpsError } from '../admin/common.js';
import type { IndexParams, IndexSourceConfig } from './index-construction.js';

export const FUNDING_RATE_UNSET = 'trade.funding_rate_unset';

export interface FundingParams {
  /** Interest component per period, signed decimal string. Added to the premium. */
  readonly baseComponent: string | null;
  /** Absolute cap on the period rate, positive decimal string. */
  readonly cap: string | null;
  /** Seconds between premium samples. */
  readonly cadenceSeconds: number | null;
  /** Share of samples dropped from EACH tail before averaging, in bps (0 to 4999). 0 is a stated choice, not blank. */
  readonly trimRatioBps: number | null;
  /** Fewest valid samples a period may close on. */
  readonly minSamples: number | null;
  /** Length of a funding period in seconds. Needed by the scheduled job to place the window; not by the formula. */
  readonly periodSeconds: number | null;
  /** An instant a period boundary falls on (ISO). Needed with periodSeconds. */
  readonly periodAnchor: string | null;
}

export const BLANK_FUNDING_PARAMS: FundingParams = {
  baseComponent: null,
  cap: null,
  cadenceSeconds: null,
  trimRatioBps: null,
  minSamples: null,
  periodSeconds: null,
  periodAnchor: null,
};

/** Fields the formula needs. The window fields are checked separately by the job that places the window. */
export function missingFundingParams(params: FundingParams): string[] {
  const out: string[] = [];
  if (params.baseComponent == null) out.push('baseComponent');
  if (params.cap == null) out.push('cap');
  if (params.cadenceSeconds == null) out.push('cadenceSeconds');
  if (params.trimRatioBps == null) out.push('trimRatioBps');
  if (params.minSamples == null) out.push('minSamples');
  return out;
}

export function missingWindowParams(params: FundingParams): string[] {
  const out: string[] = [];
  if (params.periodSeconds == null) out.push('periodSeconds');
  if (params.periodAnchor == null) out.push('periodAnchor');
  return out;
}

export interface FundingParamsVersion {
  readonly marketId: string;
  readonly version: string;
  readonly params: FundingParams;
  readonly operatorId: string | null;
  readonly approverId: string | null;
  readonly reason: string | null;
  readonly approvalId: string | null;
  readonly createdAt: string | null;
}

export interface IndexSourcesConfig {
  readonly sources: readonly IndexSourceConfig[];
  readonly params: IndexParams;
}

export interface IndexSourcesVersion {
  readonly marketId: string;
  readonly version: string;
  readonly config: IndexSourcesConfig;
  readonly operatorId: string | null;
  readonly approverId: string | null;
  readonly reason: string | null;
  readonly approvalId: string | null;
  readonly createdAt: string | null;
}

const SIGNED_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;
const POSITIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;

function badParam(message: string): never {
  throw new TradeOpsError('funding_param_invalid', message);
}

function intIn(value: number | null | undefined, label: string, min: number, max: number): number | null {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < min || value > max) badParam(`${label} must be an integer from ${min} to ${max}, or blank`);
  return value;
}

/** Validate and normalise an operator-supplied parameter set. Blank stays blank. */
export function validateFundingParams(input: FundingParams): FundingParams {
  let baseComponent: string | null = null;
  if (input.baseComponent != null) {
    const text = input.baseComponent.trim();
    if (!SIGNED_DECIMAL.test(text)) badParam('baseComponent must be a signed exact decimal string, or blank');
    baseComponent = text;
  }
  let cap: string | null = null;
  if (input.cap != null) {
    const text = input.cap.trim();
    if (!POSITIVE_DECIMAL.test(text) || parseAmount(text) <= 0n) badParam('cap must be a positive exact decimal string, or blank');
    cap = text;
  }
  let periodAnchor: string | null = null;
  if (input.periodAnchor != null) {
    const ms = Date.parse(input.periodAnchor);
    if (!Number.isFinite(ms)) badParam('periodAnchor must be an ISO-8601 instant, or blank');
    periodAnchor = new Date(ms).toISOString();
  }
  return {
    baseComponent,
    cap,
    cadenceSeconds: intIn(input.cadenceSeconds, 'cadenceSeconds', 1, 86_400),
    trimRatioBps: intIn(input.trimRatioBps, 'trimRatioBps', 0, 4_999),
    minSamples: intIn(input.minSamples, 'minSamples', 1, 1_000_000),
    periodSeconds: intIn(input.periodSeconds, 'periodSeconds', 1, 31_536_000),
    periodAnchor,
  };
}

const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_SOURCES = 16;

export function validateIndexSources(input: IndexSourcesConfig): IndexSourcesConfig {
  if (input.sources.length > MAX_SOURCES) badParam(`at most ${MAX_SOURCES} index sources`);
  const seen = new Set<string>();
  const sources = input.sources.map((s) => {
    const sourceId = s.sourceId.trim();
    if (!SOURCE_ID.test(sourceId)) badParam('sourceId must be 1-64 characters of letters, digits, . _ : -');
    if (seen.has(sourceId)) badParam(`sourceId ${sourceId} is listed twice`);
    seen.add(sourceId);
    if (!Number.isSafeInteger(s.weight) || s.weight < 1 || s.weight > 1_000_000) badParam('weight must be an integer from 1 to 1000000');
    return { sourceId, weight: s.weight, enabled: s.enabled === true };
  });
  return {
    sources,
    params: {
      minSources: intIn(input.params.minSources, 'minSources', 1, MAX_SOURCES),
      outlierBandBps: intIn(input.params.outlierBandBps, 'outlierBandBps', 1, 10_000),
      maxAgeSeconds: intIn(input.params.maxAgeSeconds, 'maxAgeSeconds', 1, 86_400),
    },
  };
}

interface ParamsRow {
  market_id: string;
  version: string;
  base_component: string | null;
  cap: string | null;
  cadence_seconds: number | null;
  trim_ratio_bps: number | null;
  min_samples: number | null;
  period_seconds: number | null;
  period_anchor: Date | null;
  operator_id: string;
  approver_id: string;
  reason: string;
  approval_id: string;
  created_at: Date;
}

function presentParams(row: ParamsRow): FundingParamsVersion {
  return {
    marketId: row.market_id,
    version: row.version,
    params: {
      baseComponent: row.base_component,
      cap: row.cap,
      cadenceSeconds: row.cadence_seconds,
      trimRatioBps: row.trim_ratio_bps,
      minSamples: row.min_samples,
      periodSeconds: row.period_seconds,
      periodAnchor: row.period_anchor ? row.period_anchor.toISOString() : null,
    },
    operatorId: row.operator_id,
    approverId: row.approver_id,
    reason: row.reason,
    approvalId: row.approval_id,
    createdAt: row.created_at.toISOString(),
  };
}

export function emptyParamsVersion(marketId: string): FundingParamsVersion {
  return {
    marketId,
    version: '0',
    params: BLANK_FUNDING_PARAMS,
    operatorId: null,
    approverId: null,
    reason: null,
    approvalId: null,
    createdAt: null,
  };
}

export async function currentFundingParams(sql: Sql, marketId: string): Promise<FundingParamsVersion> {
  const [row] = await sql<ParamsRow[]>`
    SELECT market_id, version::text, base_component, cap, cadence_seconds, trim_ratio_bps, min_samples,
           period_seconds, period_anchor, operator_id, approver_id, reason, approval_id, created_at
      FROM trade.funding_params
     WHERE market_id = ${marketId}
     ORDER BY funding_params.version DESC
     LIMIT 1`;
  return row ? presentParams(row) : emptyParamsVersion(marketId);
}

interface SourcesRow {
  market_id: string;
  version: string;
  sources: IndexSourceConfig[];
  min_sources: number | null;
  outlier_band_bps: number | null;
  max_age_seconds: number | null;
  operator_id: string;
  approver_id: string;
  reason: string;
  approval_id: string;
  created_at: Date;
}

export function emptySourcesVersion(marketId: string): IndexSourcesVersion {
  return {
    marketId,
    version: '0',
    config: { sources: [], params: { minSources: null, outlierBandBps: null, maxAgeSeconds: null } },
    operatorId: null,
    approverId: null,
    reason: null,
    approvalId: null,
    createdAt: null,
  };
}

export async function currentIndexSources(sql: Sql, marketId: string): Promise<IndexSourcesVersion> {
  const [row] = await sql<SourcesRow[]>`
    SELECT market_id, version::text, sources, min_sources, outlier_band_bps, max_age_seconds,
           operator_id, approver_id, reason, approval_id, created_at
      FROM trade.funding_index_sources
     WHERE market_id = ${marketId}
     ORDER BY funding_index_sources.version DESC
     LIMIT 1`;
  if (!row) return emptySourcesVersion(marketId);
  return {
    marketId: row.market_id,
    version: row.version,
    config: {
      sources: row.sources,
      params: { minSources: row.min_sources, outlierBandBps: row.outlier_band_bps, maxAgeSeconds: row.max_age_seconds },
    },
    operatorId: row.operator_id,
    approverId: row.approver_id,
    reason: row.reason,
    approvalId: row.approval_id,
    createdAt: row.created_at.toISOString(),
  };
}
