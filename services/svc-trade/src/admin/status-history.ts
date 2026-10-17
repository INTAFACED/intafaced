/**
 * Append-only market status transitions. Rows before this migration do not
 * exist; the read says so with `history_starts_at`.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { decodeCursor, encodeCursor, writeOperatorAudit } from './common.js';

export interface StatusTransitionInput {
  readonly marketId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly operatorId?: string | null;
  readonly approverId?: string | null;
  readonly reason?: string | null;
}

export async function recordMarketStatusTransition(sql: Sql, input: StatusTransitionInput): Promise<void> {
  if (input.fromStatus === input.toStatus) return;
  const id = randomUUID();
  const at = new Date();
  const reason = input.reason?.trim() || 'setMarketStatus';
  await sql`INSERT INTO trade.market_status_transitions (
    id, market_id, from_status, to_status, operator_id, approver_id, reason, occurred_at
  ) VALUES (
    ${id}, ${input.marketId}, ${input.fromStatus}, ${input.toStatus},
    ${input.operatorId ?? null}, ${input.approverId ?? null}, ${reason}, ${at.toISOString()}
  )`;
  await writeOperatorAudit(
    sql,
    {
      kind: 'market_status',
      operatorId: input.operatorId ?? 'system',
      accountId: null,
      objectId: input.marketId,
      approverId: input.approverId ?? null,
      reason,
      detail: { from: input.fromStatus, to: input.toStatus, transitionId: id },
    },
    at,
  );
}

export interface StatusHistoryRow {
  readonly id: string;
  readonly marketId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly operatorId: string | null;
  readonly approverId: string | null;
  readonly reason: string;
  readonly occurredAt: string;
}

export async function readMarketStatusHistory(
  sql: Sql,
  marketId: string,
  cursor: string | null,
  limit: number,
): Promise<{
  historyStartsAt: string;
  unknownBefore: 'history_starts_at';
  rows: StatusHistoryRow[];
  nextCursor: string | null;
}> {
  const [origin] = await sql<Array<{ history_starts_at: Date }>>`
    SELECT history_starts_at FROM trade.market_status_history_origin WHERE id = 1`;
  const [earliest] = await sql<Array<{ occurred_at: Date }>>`
    SELECT occurred_at FROM trade.market_status_transitions
     WHERE market_id = ${marketId}
     ORDER BY occurred_at ASC, id ASC
     LIMIT 1`;
  const page = decodeCursor(cursor);
  const rows = await sql<
    Array<{
      id: string;
      market_id: string;
      from_status: string;
      to_status: string;
      operator_id: string | null;
      approver_id: string | null;
      reason: string;
      occurred_at: Date;
    }>
  >`
    SELECT id, market_id, from_status, to_status, operator_id, approver_id, reason, occurred_at
      FROM trade.market_status_transitions
     WHERE market_id = ${marketId}
       AND (${page?.at ?? null}::timestamptz IS NULL OR (occurred_at, id) > (${page?.at ?? null}::timestamptz, ${page?.id ?? null}::uuid))
     ORDER BY occurred_at ASC, id ASC
     LIMIT ${limit + 1}`;
  const more = rows.length > limit;
  const slice = more ? rows.slice(0, limit) : rows;
  const presented: StatusHistoryRow[] = slice.map((row) => ({
    id: row.id,
    marketId: row.market_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    operatorId: row.operator_id,
    approverId: row.approver_id,
    reason: row.reason,
    occurredAt: row.occurred_at.toISOString(),
  }));
  const last = presented[presented.length - 1];
  return {
    historyStartsAt: earliest?.occurred_at.toISOString() ?? origin?.history_starts_at.toISOString() ?? new Date(0).toISOString(),
    unknownBefore: 'history_starts_at',
    rows: presented,
    nextCursor: more && last ? encodeCursor(last.occurredAt, last.id) : null,
  };
}
