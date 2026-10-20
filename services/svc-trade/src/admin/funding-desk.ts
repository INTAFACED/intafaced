/**
 * Operator funding desk (D-instruments-01): funding parameters, index sources and the computed/refused periods.
 *
 * Reads are `admin:read`. Writes are `admin:write` and carry a reason, a four-eyes `approvalId`, a `clientRequestId`
 * (a repeat returns the first answer) and an `expectedVersion` (a stale one is refused). Every version is an
 * append-only row; a blank field stays blank and the computer refuses on it. No money moves here.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { formatAmount } from '@intafaced/ledger-client';
import {
  consumeApproval,
  loadRequest,
  payloadHash,
  requireClientRequestId,
  requireOperator,
  requireOperatorWrite,
  requireReason,
  storeRequest,
  TradeOpsError,
  writeOperatorAudit,
  type ApprovalBook,
} from './common.js';
import {
  currentFundingParams,
  currentIndexSources,
  missingFundingParams,
  missingWindowParams,
  validateFundingParams,
  validateIndexSources,
  type FundingParams,
  type FundingParamsVersion,
  type IndexSourcesConfig,
  type IndexSourcesVersion,
} from '../futures/funding-params.js';
import { missingIndexParams } from '../futures/index-construction.js';
import {
  premiumOf,
  sqlFundingRatePeriodStore,
  sqlFundingSampleStore,
  type FundingRatePeriodRecord,
} from '../futures/funding-rate-computer.js';

export interface FundingDeskDeps {
  readonly sql: Sql;
  readonly approvals: ApprovalBook;
  readonly now?: () => Date;
}

const VERSION = /^(?:0|[1-9]\d*)$/;

function uniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

export type FundingParamsView = FundingParamsVersion & {
  /** Blank numbers the formula needs. The computer refuses the period while this is non-empty. */
  readonly missing: readonly string[];
  /** Blank numbers the scheduled job needs to place a period window. */
  readonly missingWindow: readonly string[];
};

export type IndexSourcesView = IndexSourcesVersion & {
  readonly missing: readonly string[];
};

function paramsView(v: FundingParamsVersion): FundingParamsView {
  return { ...v, missing: missingFundingParams(v.params), missingWindow: missingWindowParams(v.params) };
}

function sourcesView(v: IndexSourcesVersion): IndexSourcesView {
  return { ...v, missing: missingIndexParams(v.config.params) };
}

/** The shared write path: replay, version check, approval, insert, audit. */
async function versionedSet<R>(
  deps: FundingDeskDeps,
  principal: Principal,
  spec: {
    kind: 'funding_params' | 'index_sources';
    actionType: string;
    market: string;
    /** Canonical, validated change; it is what the approval is bound to. */
    change: unknown;
    expectedVersion: string;
    reason: string;
    approvalId: string;
    clientRequestId: string;
    currentVersion: () => Promise<string>;
    insert: (tx: Sql, next: string, ctx: { id: string; operatorId: string; approverId: string }) => Promise<void>;
    read: () => Promise<R>;
    staleCode: string;
  },
): Promise<R> {
  requireOperatorWrite(principal);
  const clientRequestId = requireClientRequestId(spec.clientRequestId);
  const reason = requireReason(spec.reason);
  if (!VERSION.test(spec.expectedVersion)) {
    throw new TradeOpsError('expected_version_invalid', 'expectedVersion must be the version number you read');
  }
  const fingerprint = payloadHash({
    kind: spec.kind,
    market: spec.market,
    change: spec.change,
    expectedVersion: spec.expectedVersion,
    reason,
  });
  const prior = await loadRequest(deps.sql, clientRequestId, spec.kind, fingerprint);
  if (prior) return prior as R;

  const approvalId = spec.approvalId.trim();
  if (approvalId === '') throw new TradeOpsError('approval_missing', 'approvalId is required: this write needs a second operator');
  const version = await spec.currentVersion();
  if (version !== spec.expectedVersion) {
    throw new TradeOpsError(spec.staleCode, `expectedVersion ${spec.expectedVersion} is stale; current is ${version}`);
  }
  const consumed = await consumeApproval(deps.approvals, {
    approvalId,
    actionType: spec.actionType,
    targetId: spec.market,
    expectedVersion: spec.expectedVersion,
    payloadHash: payloadHash({
      actionType: spec.actionType,
      market: spec.market,
      change: spec.change,
      expectedVersion: spec.expectedVersion,
      reason,
    }),
    operationId: clientRequestId,
  });
  const next = (BigInt(version) + 1n).toString();
  const at = deps.now?.() ?? new Date();
  try {
    await deps.sql.begin(async (tx) => {
      const txSql = tx as unknown as Sql;
      await spec.insert(txSql, next, { id: randomUUID(), operatorId: principal.userId, approverId: consumed.approverId });
      await writeOperatorAudit(
        txSql,
        {
          kind: `${spec.kind}.set`,
          operatorId: principal.userId,
          accountId: null,
          objectId: spec.market,
          approverId: consumed.approverId,
          reason,
          detail: { version: next },
        },
        at,
      );
    });
  } catch (error) {
    // Two writers read the same version: the unique (market, version) key let one in.
    if (uniqueViolation(error)) {
      throw new TradeOpsError(spec.staleCode, `expectedVersion ${spec.expectedVersion} is stale; another write landed first`);
    }
    throw error;
  }
  const result = await spec.read();
  await storeRequest(deps.sql, clientRequestId, spec.kind, fingerprint, result);
  return result;
}

export class FundingDesk {
  constructor(private readonly deps: FundingDeskDeps) {}

  async paramsGet(principal: Principal, market: string): Promise<FundingParamsView> {
    requireOperator(principal);
    const row = await currentFundingParams(this.deps.sql, market);
    await writeOperatorAudit(this.deps.sql, {
      kind: 'funding_params.get',
      operatorId: principal.userId,
      accountId: null,
      objectId: market,
      approverId: null,
      reason: null,
    });
    return paramsView(row);
  }

  async paramsSet(
    principal: Principal,
    input: {
      market: string;
      params: FundingParams;
      expectedVersion: string;
      reason: string;
      approvalId: string;
      clientRequestId: string;
    },
  ): Promise<FundingParamsView> {
    requireOperatorWrite(principal);
    const params = validateFundingParams(input.params);
    return versionedSet<FundingParamsView>(this.deps, principal, {
      kind: 'funding_params',
      actionType: 'trade.funding_params_set',
      market: input.market,
      change: params,
      expectedVersion: input.expectedVersion,
      reason: input.reason,
      approvalId: input.approvalId,
      clientRequestId: input.clientRequestId,
      staleCode: 'funding_params_stale',
      currentVersion: async () => (await currentFundingParams(this.deps.sql, input.market)).version,
      insert: async (tx, next, ctx) => {
        await tx`INSERT INTO trade.funding_params (
          id, market_id, version, base_component, cap, cadence_seconds, trim_ratio_bps, min_samples,
          period_seconds, period_anchor, operator_id, approver_id, reason, approval_id
        ) VALUES (
          ${ctx.id}, ${input.market}, ${next}::bigint, ${params.baseComponent}, ${params.cap}, ${params.cadenceSeconds},
          ${params.trimRatioBps}, ${params.minSamples}, ${params.periodSeconds}, ${params.periodAnchor},
          ${ctx.operatorId}, ${ctx.approverId}, ${requireReason(input.reason)}, ${input.approvalId.trim()}
        )`;
      },
      read: async () => paramsView(await currentFundingParams(this.deps.sql, input.market)),
    });
  }

  async sourcesGet(principal: Principal, market: string): Promise<IndexSourcesView> {
    requireOperator(principal);
    const row = await currentIndexSources(this.deps.sql, market);
    await writeOperatorAudit(this.deps.sql, {
      kind: 'index_sources.get',
      operatorId: principal.userId,
      accountId: null,
      objectId: market,
      approverId: null,
      reason: null,
    });
    return sourcesView(row);
  }

  async sourcesSet(
    principal: Principal,
    input: {
      market: string;
      config: IndexSourcesConfig;
      expectedVersion: string;
      reason: string;
      approvalId: string;
      clientRequestId: string;
    },
  ): Promise<IndexSourcesView> {
    requireOperatorWrite(principal);
    const config = validateIndexSources(input.config);
    return versionedSet<IndexSourcesView>(this.deps, principal, {
      kind: 'index_sources',
      actionType: 'trade.index_sources_set',
      market: input.market,
      change: config,
      expectedVersion: input.expectedVersion,
      reason: input.reason,
      approvalId: input.approvalId,
      clientRequestId: input.clientRequestId,
      staleCode: 'index_sources_stale',
      currentVersion: async () => (await currentIndexSources(this.deps.sql, input.market)).version,
      insert: async (tx, next, ctx) => {
        await tx`INSERT INTO trade.funding_index_sources (
          id, market_id, version, sources, min_sources, outlier_band_bps, max_age_seconds,
          operator_id, approver_id, reason, approval_id
        ) VALUES (
          ${ctx.id}, ${input.market}, ${next}::bigint, ${tx.json(config.sources as never)}, ${config.params.minSources},
          ${config.params.outlierBandBps}, ${config.params.maxAgeSeconds},
          ${ctx.operatorId}, ${ctx.approverId}, ${requireReason(input.reason)}, ${input.approvalId.trim()}
        )`;
      },
      read: async () => sourcesView(await currentIndexSources(this.deps.sql, input.market)),
    });
  }

  /**
   * Recent computed, paused and refused periods, newest first, each with its stored inputs and the samples in its
   * window (oldest first, at most `sampleLimit`). Both limits are required: this read does not invent a page size.
   */
  async periods(
    principal: Principal,
    input: { market?: string | null; limit: number; sampleLimit: number },
  ): Promise<{
    periods: Array<
      FundingRatePeriodRecord & {
        samples: Array<{ sampledAt: string; mark: string | null; index: string | null; premium: string | null; gapReason: string | null }>;
        samplesTruncated: boolean;
      }
    >;
  }> {
    requireOperator(principal);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new TradeOpsError('funding_periods_limit_unset', 'limit is required (1–200); this list does not invent a page size');
    }
    if (!Number.isInteger(input.sampleLimit) || input.sampleLimit < 1 || input.sampleLimit > 1000) {
      throw new TradeOpsError('funding_periods_limit_unset', 'sampleLimit is required (1–1000); this list does not invent a page size');
    }
    const periods = await sqlFundingRatePeriodStore(this.deps.sql).recent({ marketId: input.market?.trim() || null, limit: input.limit });
    const sampleStore = sqlFundingSampleStore(this.deps.sql);
    const out = [];
    for (const period of periods) {
      let samples: Array<{
        sampledAt: string;
        mark: string | null;
        index: string | null;
        premium: string | null;
        gapReason: string | null;
      }> = [];
      let truncated = false;
      if (period.periodStart && period.periodEnd) {
        const rows = await sampleStore.window(period.marketId, new Date(period.periodStart), new Date(period.periodEnd));
        truncated = rows.length > input.sampleLimit;
        samples = rows.slice(0, input.sampleLimit).map((r) => ({
          sampledAt: r.sampledAt.toISOString(),
          mark: r.mark == null ? null : formatAmount(r.mark),
          index: r.index == null ? null : formatAmount(r.index),
          // A gap has no premium: null, never zero.
          premium: r.mark != null && r.index != null && r.index > 0n ? formatAmount(premiumOf({ mark: r.mark, index: r.index })) : null,
          gapReason: r.gapReason,
        }));
      }
      out.push({ ...period, samples, samplesTruncated: truncated });
    }
    return { periods: out };
  }
}
