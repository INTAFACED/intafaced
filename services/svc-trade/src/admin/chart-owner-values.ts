/**
 * Charts module owner values (C-ops-04, LD-14). The five counts and the per-market data class that the charts
 * module enforces, set by the owner on the founder settings page.
 *
 *   admin.chartOwnerValues.get   the current scalars and every market's data class (admin:read)
 *   admin.chartOwnerValues.set   one key per write (admin:write): a count, or a market's data class
 *
 * Blank is NULL, "not set". Nothing here holds a default number: an unset count refuses in the customer app,
 * and a missing data class is `null`. Scalars are one append-only snapshot per version; a data class is one
 * append-only row per (market, version). Each write is idempotent on `clientRequestId`, carries a reason, and
 * writes its audit row in the same transaction: if the audit row cannot be written, nothing changes.
 * A data class write needs a second operator's approval (four-eyes); the scalars need none.
 * No ledger write recipe is imported here: these values are read by the customer app and never move money.
 */
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import {
  consumeApproval,
  loadRequest,
  OPERATOR_WRITE_PERMISSION,
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

export const CHART_SCALAR_KEYS = ['compareCap', 'chartCountLimit', 'drawingCap', 'brushPointCap', 'delayedBoundarySeconds'] as const;
export type ChartScalarKey = (typeof CHART_SCALAR_KEYS)[number];

/** Schema bounds for a set count. A count outside 1..bound refuses by schema; the bound is not a default. */
export const CHART_SCALAR_BOUNDS: Readonly<Record<ChartScalarKey, number>> = {
  compareCap: 50,
  chartCountLimit: 64,
  drawingCap: 10_000,
  brushPointCap: 100_000,
  delayedBoundarySeconds: 86_400,
};

export const CHART_DATA_CLASSES = ['real_time', 'delayed', 'end_of_day'] as const;
export type ChartDataClass = (typeof CHART_DATA_CLASSES)[number];

const COLUMN: Readonly<Record<ChartScalarKey, string>> = {
  compareCap: 'compare_cap',
  chartCountLimit: 'chart_count_limit',
  drawingCap: 'drawing_cap',
  brushPointCap: 'brush_point_cap',
  delayedBoundarySeconds: 'delayed_boundary_seconds',
};

/** A page of markets is never unbounded. The market list is small; this is a ceiling, not a default. */
const MAX_MARKETS_LISTED = 500;

export const CHART_OWNER_VALUE_STALE = 'chart_owner_values_stale' as const;
export const CHART_OWNER_VALUE_NOT_WRITTEN = 'chart_owner_values_not_written' as const;

export type ChartValues = Readonly<Record<ChartScalarKey, number | null>>;

export interface ChartScalarsView {
  /** Null until the first write. */
  readonly version: string | null;
  readonly values: ChartValues;
  readonly operatorId: string | null;
  readonly reason: string | null;
  readonly updatedAt: string | null;
}

export interface ChartDataClassView {
  readonly symbol: string;
  readonly version: string | null;
  readonly dataClass: ChartDataClass | null;
  readonly operatorId: string | null;
  readonly approverId: string | null;
  readonly updatedAt: string | null;
}

/** What the owner-values read returns: the stored state, without who is asking. */
export interface ChartOwnerValuesReadView {
  readonly scalars: ChartScalarsView;
  readonly dataClasses: readonly ChartDataClassView[];
}

/**
 * The page's view. `canWrite` is the caller's own `admin:write` scope as svc-trade verified it: a support reader sees the
 * page read-only. The service refuses a write from that caller regardless of what the page shows.
 */
export interface ChartOwnerValuesAdminView extends ChartOwnerValuesReadView {
  readonly canWrite: boolean;
}

export type ChartOwnerValueSetInput =
  | {
      readonly key: ChartScalarKey;
      readonly value: number | null;
      readonly expectedVersion: string;
      readonly reason: string;
      readonly clientRequestId: string;
    }
  | {
      readonly key: 'dataClass';
      readonly symbol: string;
      readonly value: ChartDataClass | null;
      readonly expectedVersion: string;
      readonly reason: string;
      readonly approvalId: string;
      readonly clientRequestId: string;
    };

export interface ChartOwnerValuesDeps {
  readonly sql: Sql;
  readonly approvals: ApprovalBook;
  readonly now: () => Date;
}

const EMPTY_VALUES: ChartValues = {
  compareCap: null,
  chartCountLimit: null,
  drawingCap: null,
  brushPointCap: null,
  delayedBoundarySeconds: null,
};

interface ScalarRow {
  version: string;
  compare_cap: number | null;
  chart_count_limit: number | null;
  drawing_cap: number | null;
  brush_point_cap: number | null;
  delayed_boundary_seconds: number | null;
  operator_id: string;
  reason: string;
  created_at: Date;
}

/** The current scalar snapshot: the highest version, or nothing set. */
export async function readChartScalars(sql: Sql): Promise<ChartScalarsView> {
  const [row] = await sql<ScalarRow[]>`
    SELECT version::text AS version, compare_cap, chart_count_limit, drawing_cap, brush_point_cap,
           delayed_boundary_seconds, operator_id, reason, created_at
      FROM trade.chart_owner_values ORDER BY chart_owner_values.version DESC LIMIT 1`;
  if (!row) return { version: null, values: EMPTY_VALUES, operatorId: null, reason: null, updatedAt: null };
  return {
    version: row.version,
    values: {
      compareCap: row.compare_cap,
      chartCountLimit: row.chart_count_limit,
      drawingCap: row.drawing_cap,
      brushPointCap: row.brush_point_cap,
      delayedBoundarySeconds: row.delayed_boundary_seconds,
    },
    operatorId: row.operator_id,
    reason: row.reason,
    updatedAt: row.created_at.toISOString(),
  };
}

/** The latest data class row for one market symbol, or null when none was ever written. */
export async function readChartDataClass(sql: Sql, symbol: string): Promise<{ version: string; dataClass: ChartDataClass | null } | null> {
  const [row] = await sql<Array<{ version: string; data_class: ChartDataClass | null }>>`
    SELECT version::text AS version, data_class FROM trade.chart_data_class
     WHERE symbol = ${symbol} ORDER BY chart_data_class.version DESC LIMIT 1`;
  return row ? { version: row.version, dataClass: row.data_class } : null;
}

async function readDataClasses(sql: Sql): Promise<ChartDataClassView[]> {
  const rows = await sql<
    Array<{
      symbol: string;
      version: string | null;
      data_class: ChartDataClass | null;
      operator_id: string | null;
      approver_id: string | null;
      created_at: Date | null;
    }>
  >`
    SELECT m.symbol, d.version, d.data_class, d.operator_id, d.approver_id, d.created_at
      FROM trade.markets m
      LEFT JOIN LATERAL (
        SELECT c.version::text AS version, c.data_class, c.operator_id, c.approver_id, c.created_at
          FROM trade.chart_data_class c
         WHERE c.symbol = m.symbol
         ORDER BY c.version DESC
         LIMIT 1
      ) d ON true
     ORDER BY m.symbol
     LIMIT ${MAX_MARKETS_LISTED}`;
  return rows.map((row) => ({
    symbol: row.symbol,
    version: row.version,
    dataClass: row.data_class,
    operatorId: row.operator_id,
    approverId: row.approver_id,
    updatedAt: row.created_at ? row.created_at.toISOString() : null,
  }));
}

export async function readChartOwnerValuesAdmin(sql: Sql): Promise<ChartOwnerValuesReadView> {
  return { scalars: await readChartScalars(sql), dataClasses: await readDataClasses(sql) };
}

/** The page view for a caller who may (or may not) write. A successful write is always from a writer. */
async function viewFor(sql: Sql, canWrite: boolean): Promise<ChartOwnerValuesAdminView> {
  return { ...(await readChartOwnerValuesAdmin(sql)), canWrite };
}

function requireSymbol(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 64) {
    throw new TradeOpsError('chart_owner_value_invalid', 'symbol is required (1-64 chars)');
  }
  return trimmed;
}

function requireApprovalId(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  if (trimmed.length < 1 || trimmed.length > 128) {
    throw new TradeOpsError('approval_required', 'approvalId is required: a data class write needs a second operator (1-128 chars)');
  }
  return trimmed;
}

function validateScalar(key: ChartScalarKey, value: number | null): number | null {
  if (value === null) return null;
  const max = CHART_SCALAR_BOUNDS[key];
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TradeOpsError('chart_owner_value_invalid', `${key} must be a whole number from 1 to ${max}, or blank`);
  }
  return value;
}

function validateDataClass(value: ChartDataClass | null): ChartDataClass | null {
  if (value === null) return null;
  if (!(CHART_DATA_CLASSES as readonly string[]).includes(value)) {
    throw new TradeOpsError('chart_owner_value_invalid', 'dataClass must be real_time, delayed or end_of_day, or blank');
  }
  return value;
}

function nextVersion(current: string | null): string {
  return (BigInt(current ?? '0') + 1n).toString();
}

const APPROVAL_SPENT_NOTE = 'The approval was spent by this attempt: a new approval is needed before the change can be applied.';

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === '23505';
}

/**
 * Refuse a write that was not written: nothing changed, and the caller says so. After a data class approval is
 * consumed (`approvalSpent`), the refusal also says the approval is spent, because a retry needs a new one.
 */
function notWritten(error: unknown, approvalSpent = false): never {
  const suffix = approvalSpent ? ` ${APPROVAL_SPENT_NOTE}` : '';
  if (error instanceof TradeOpsError) {
    throw approvalSpent ? new TradeOpsError(error.code, `${error.message}${suffix}`) : error;
  }
  if (isUniqueViolation(error)) {
    throw new TradeOpsError(CHART_OWNER_VALUE_STALE, `another operator changed this value first; reload and try again${suffix}`);
  }
  throw new TradeOpsError(
    CHART_OWNER_VALUE_NOT_WRITTEN,
    `the value and its audit row could not both be written, so nothing changed${suffix}`,
  );
}

export class ChartOwnerValuesAdmin {
  constructor(private readonly deps: ChartOwnerValuesDeps) {}

  async get(principal: Principal): Promise<ChartOwnerValuesAdminView> {
    requireOperator(principal);
    return viewFor(this.deps.sql, principal.scopes.includes(OPERATOR_WRITE_PERMISSION));
  }

  async set(principal: Principal, input: ChartOwnerValueSetInput): Promise<ChartOwnerValuesAdminView> {
    requireOperatorWrite(principal);
    if (input.key === 'dataClass') return this.setDataClass(principal, input);
    return this.setScalar(principal, input);
  }

  private async setScalar(
    principal: Principal,
    input: Extract<ChartOwnerValueSetInput, { key: ChartScalarKey }>,
  ): Promise<ChartOwnerValuesAdminView> {
    const { sql } = this.deps;
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const reason = requireReason(input.reason);
    const value = validateScalar(input.key, input.value);
    const fingerprint = payloadHash({
      kind: 'chart_owner_value_set',
      key: input.key,
      value,
      expectedVersion: input.expectedVersion,
      reason,
    });
    const prior = await loadRequest(sql, clientRequestId, 'chart_owner_value_set', fingerprint);
    if (prior) return prior as ChartOwnerValuesAdminView;

    const current = await readChartScalars(sql);
    const version = current.version ?? '0';
    if (version !== input.expectedVersion) {
      // The first of two concurrent duplicates may have committed between the first lookup and this read: that is a
      // replay of this same write, not a stale value.
      const committed = await loadRequest(sql, clientRequestId, 'chart_owner_value_set', fingerprint);
      if (committed) return committed as ChartOwnerValuesAdminView;
      throw new TradeOpsError(CHART_OWNER_VALUE_STALE, `expectedVersion ${input.expectedVersion} is stale; current is ${version}`);
    }
    const oldValue = current.values[input.key];
    const values: ChartValues = { ...current.values, [input.key]: value };
    const next = nextVersion(current.version);
    const at = this.deps.now();
    try {
      await sql.begin(async (tx) => {
        await tx`INSERT INTO trade.chart_owner_values (
          version, compare_cap, chart_count_limit, drawing_cap, brush_point_cap, delayed_boundary_seconds,
          operator_id, reason, created_at
        ) VALUES (
          ${next}::bigint, ${values.compareCap}, ${values.chartCountLimit}, ${values.drawingCap}, ${values.brushPointCap},
          ${values.delayedBoundarySeconds}, ${principal.userId}, ${reason}, ${at.toISOString()}
        )`;
        await writeOperatorAudit(
          tx as unknown as Sql,
          {
            kind: 'chart_owner_values.set',
            operatorId: principal.userId,
            accountId: null,
            objectId: input.key,
            approverId: null,
            reason,
            detail: { key: input.key, oldValue, newValue: value, version: next },
          },
          at,
        );
        const written = await viewFor(tx as unknown as Sql, true);
        await storeRequest(tx as unknown as Sql, clientRequestId, 'chart_owner_value_set', fingerprint, written);
      });
    } catch (error) {
      // A concurrent duplicate of this same request lost the version race (or the client-request key) after the
      // first one committed: replay the stored result, and only a different request is stale.
      if (isUniqueViolation(error)) {
        const replay = await loadRequest(sql, clientRequestId, 'chart_owner_value_set', fingerprint);
        if (replay) return replay as ChartOwnerValuesAdminView;
      }
      notWritten(error);
    }
    return viewFor(sql, true);
  }

  private async setDataClass(
    principal: Principal,
    input: Extract<ChartOwnerValueSetInput, { key: 'dataClass' }>,
  ): Promise<ChartOwnerValuesAdminView> {
    const { sql } = this.deps;
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const reason = requireReason(input.reason);
    const approvalId = requireApprovalId(input.approvalId);
    const symbol = requireSymbol(input.symbol);
    const dataClass = validateDataClass(input.value);
    const fingerprint = payloadHash({
      kind: 'chart_data_class_set',
      symbol,
      dataClass,
      expectedVersion: input.expectedVersion,
      reason,
    });
    const prior = await loadRequest(sql, clientRequestId, 'chart_data_class_set', fingerprint);
    if (prior) return prior as ChartOwnerValuesAdminView;

    const [market] = await sql<Array<{ symbol: string }>>`SELECT symbol FROM trade.markets WHERE symbol = ${symbol}`;
    if (!market) throw new TradeOpsError('market_not_found', `market ${symbol} not found`);

    const current = await readChartDataClass(sql, symbol);
    const version = current?.version ?? '0';
    if (version !== input.expectedVersion) {
      throw new TradeOpsError(CHART_OWNER_VALUE_STALE, `expectedVersion ${input.expectedVersion} is stale; current is ${version}`);
    }
    const consumed = await consumeApproval(this.deps.approvals, {
      approvalId,
      actionType: 'trade.chart_data_class_set',
      targetId: symbol,
      expectedVersion: version,
      payloadHash: payloadHash({
        actionType: 'trade.chart_data_class_set',
        symbol,
        dataClass,
        expectedVersion: version,
        reason,
      }),
      operationId: clientRequestId,
    });
    const next = nextVersion(current?.version ?? null);
    const at = this.deps.now();
    try {
      await sql.begin(async (tx) => {
        await tx`INSERT INTO trade.chart_data_class (
          symbol, version, data_class, operator_id, approver_id, approval_id, reason, created_at
        ) VALUES (
          ${symbol}, ${next}::bigint, ${dataClass}, ${principal.userId}, ${consumed.approverId}, ${approvalId}, ${reason}, ${at.toISOString()}
        )`;
        await writeOperatorAudit(
          tx as unknown as Sql,
          {
            kind: 'chart_data_class.set',
            operatorId: principal.userId,
            accountId: null,
            objectId: symbol,
            approverId: consumed.approverId,
            reason,
            detail: { symbol, oldValue: current?.dataClass ?? null, newValue: dataClass, version: next },
          },
          at,
        );
        const written = await viewFor(tx as unknown as Sql, true);
        await storeRequest(tx as unknown as Sql, clientRequestId, 'chart_data_class_set', fingerprint, written);
      });
    } catch (error) {
      notWritten(error, true);
    }
    return viewFor(sql, true);
  }
}

/** The customer read: every count, and the data class for one market when a symbol is asked for. */
export interface ChartOwnerValuesPublicReader {
  scalars(): Promise<ChartValues>;
  dataClassFor(symbol: string): Promise<ChartDataClass | null>;
}

export function chartOwnerValuesPublicReader(sql: Sql): ChartOwnerValuesPublicReader {
  return {
    async scalars() {
      return (await readChartScalars(sql)).values;
    },
    async dataClassFor(symbol: string) {
      return (await readChartDataClass(sql, symbol))?.dataClass ?? null;
    },
  };
}
