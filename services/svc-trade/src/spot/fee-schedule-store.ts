/**
 * Versioned owner fee schedule, read side.
 *
 * The schedule in force for an order is the latest approved version whose `effective_at` is at or before the moment
 * the order was placed; with no such version the boot-time `TRADE_FEE_SCHEDULE` value applies. Reading by the order's
 * own `created_at` is what keeps a new version from re-pricing an open order, and it needs no per-order column.
 */
import type { Sql } from 'postgres';
import { parseFeeScheduleJson, type OwnerFeeSchedule } from './fee-schedule.js';

export interface FeeScheduleVersionRow {
  readonly version: string;
  readonly schedule: Record<string, unknown>;
  readonly effectiveAt: string;
  readonly operatorId: string;
  readonly approverId: string;
  readonly reason: string;
  readonly approvalId: string;
  readonly createdAt: string;
}

interface VersionDbRow {
  version: string;
  schedule: Record<string, unknown> | string;
  effective_at: Date;
  operator_id: string;
  approver_id: string;
  reason: string;
  approval_id: string;
  created_at: Date;
}

/** The label a stored version carries on the wire and in `feeScheduleVersion`. */
export const feeVersionLabel = (version: string): string => `v${version}`;

function scheduleOf(row: Pick<VersionDbRow, 'version' | 'schedule'>): OwnerFeeSchedule {
  const body = typeof row.schedule === 'string' ? (JSON.parse(row.schedule) as Record<string, unknown>) : row.schedule;
  return parseFeeScheduleJson(JSON.stringify({ ...body, published: true, version: feeVersionLabel(row.version) }));
}

/** The schedule in force at `at`: the latest version effective by then, else `base`. */
export async function feeScheduleAt(sql: Sql, base: OwnerFeeSchedule, at: Date): Promise<OwnerFeeSchedule> {
  const [row] = await sql<VersionDbRow[]>`
    SELECT version::text, schedule
      FROM trade.fee_schedule_versions
     WHERE effective_at <= ${at.toISOString()}
     ORDER BY effective_at DESC, version DESC
     LIMIT 1`;
  return row ? scheduleOf(row) : base;
}

function present(row: VersionDbRow): FeeScheduleVersionRow {
  return {
    version: row.version,
    schedule: typeof row.schedule === 'string' ? (JSON.parse(row.schedule) as Record<string, unknown>) : row.schedule,
    effectiveAt: row.effective_at.toISOString(),
    operatorId: row.operator_id,
    approverId: row.approver_id,
    reason: row.reason,
    approvalId: row.approval_id,
    createdAt: row.created_at.toISOString(),
  };
}

export async function feeScheduleHistory(sql: Sql): Promise<FeeScheduleVersionRow[]> {
  const rows = await sql<VersionDbRow[]>`
    SELECT version::text, schedule, effective_at, operator_id, approver_id, reason, approval_id, created_at
      FROM trade.fee_schedule_versions
     ORDER BY version ASC`;
  return rows.map(present);
}

export async function latestFeeScheduleVersion(sql: Sql): Promise<string> {
  const [row] = await sql<Array<{ version: string | null }>>`SELECT max(version)::text AS version FROM trade.fee_schedule_versions`;
  return row?.version ?? '0';
}
