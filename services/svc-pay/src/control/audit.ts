import type { FounderControlAuditEntry, FounderControlAuditListInput } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { ControlError } from './errors.js';

export interface AuditRow {
  readonly scope: 'merchant' | 'tier' | 'pricing' | 'approval';
  readonly scopeId: string;
  readonly merchantId?: string | null;
  readonly kind: string;
  readonly outcome: string;
  readonly actorId: string;
  readonly secondActorId?: string | null;
  readonly requestId?: string | null;
  readonly reason: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

interface AuditReadRow {
  id: string;
  seq: string | number | bigint;
  scope: FounderControlAuditEntry['scope'];
  scope_id: string;
  merchant_id: string | null;
  kind: string;
  outcome: string;
  actor_id: string;
  second_actor_id: string | null;
  request_id: string | null;
  reason: string;
  before: unknown;
  after: unknown;
  created_at: Date | string;
}

/**
 * Founder read of `pay.control_audit`, newest first. Filters are exact: merchant, kind, and an
 * inclusive `from`/`to` on `created_at`. A reversed range is refused rather than answered as empty.
 */
export async function listControlAudit(
  sql: Sql,
  input: FounderControlAuditListInput,
): Promise<{ entries: FounderControlAuditEntry[]; nextCursor: string | null }> {
  const from = input.from ? new Date(input.from) : null;
  const to = input.to ? new Date(input.to) : null;
  if (from && to && from.getTime() > to.getTime()) throw new ControlError('pay.control_invalid');
  const cursor = input.cursor ?? null;
  const merchantId = input.merchantId ?? null;
  const kind = input.kind ?? null;
  const rows = await sql<AuditReadRow[]>`
    SELECT id, seq, scope, scope_id, merchant_id, kind, outcome, actor_id, second_actor_id, request_id, reason, before, after, created_at
      FROM pay.control_audit
     WHERE (${cursor}::bigint IS NULL OR seq < ${cursor}::bigint)
       AND (${merchantId}::uuid IS NULL OR merchant_id = ${merchantId}::uuid)
       AND (${kind}::text IS NULL OR kind = ${kind})
       AND (${from}::timestamptz IS NULL OR created_at >= ${from})
       AND (${to}::timestamptz IS NULL OR created_at <= ${to})
     ORDER BY seq DESC
     LIMIT ${input.limit + 1}
  `;
  const page = rows.slice(0, input.limit);
  return {
    entries: page.map((row) => ({
      id: row.id,
      seq: String(row.seq),
      scope: row.scope,
      scopeId: row.scope_id,
      merchantId: row.merchant_id,
      kind: row.kind,
      outcome: row.outcome,
      actorId: row.actor_id,
      secondActorId: row.second_actor_id,
      requestId: row.request_id,
      reason: row.reason,
      before: row.before ?? null,
      after: row.after ?? null,
      createdAt: iso(row.created_at),
    })),
    nextCursor: rows.length > input.limit ? String(page[page.length - 1]!.seq) : null,
  };
}

export interface MerchantAuditEvent {
  readonly id: string;
  readonly seq: string;
  readonly scope: 'merchant' | 'tier' | 'pricing' | 'approval';
  readonly scopeId: string;
  readonly kind: string;
  readonly outcome: string;
  readonly actorId: string;
  readonly secondActorId: string | null;
  readonly requestId: string | null;
  readonly reason: string;
  readonly createdAt: string;
}

/** Newest audit rows for one merchant. `limit` is a page cap the caller already bounded. */
export async function readMerchantAudit(
  sql: Sql,
  merchantId: string,
  limit: number,
): Promise<{ events: MerchantAuditEvent[]; truncated: boolean }> {
  const rows = await sql<
    Array<{
      id: string;
      seq: string | number;
      scope: MerchantAuditEvent['scope'];
      scope_id: string;
      kind: string;
      outcome: string;
      actor_id: string;
      second_actor_id: string | null;
      request_id: string | null;
      reason: string;
      created_at: Date | string;
    }>
  >`
    SELECT id, seq, scope, scope_id, kind, outcome, actor_id, second_actor_id, request_id, reason, created_at
      FROM pay.control_audit
     WHERE merchant_id = ${merchantId}
     ORDER BY seq DESC
     LIMIT ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  return {
    truncated: rows.length > limit,
    events: page.map((row) => ({
      id: row.id,
      seq: String(row.seq),
      scope: row.scope,
      scopeId: row.scope_id,
      kind: row.kind,
      outcome: row.outcome,
      actorId: row.actor_id,
      secondActorId: row.second_actor_id,
      requestId: row.request_id,
      reason: row.reason,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

/** Append one audit row. Always inside the same transaction as the change it records. */
export async function writeAudit(tx: Sql, row: AuditRow): Promise<void> {
  await tx`
    INSERT INTO pay.control_audit (scope, scope_id, merchant_id, kind, outcome, actor_id, second_actor_id, request_id, reason, before, after)
    VALUES (${row.scope}, ${row.scopeId}, ${row.merchantId ?? null}, ${row.kind}, ${row.outcome}, ${row.actorId}, ${row.secondActorId ?? null},
            ${row.requestId ?? null}, ${row.reason},
            ${row.before === undefined ? null : tx.json(row.before as never)}, ${row.after === undefined ? null : tx.json(row.after as never)})
  `;
}
