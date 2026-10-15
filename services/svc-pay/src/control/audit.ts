import type { Sql } from 'postgres';

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

/** Append one audit row. Always inside the same transaction as the change it records. */
export async function writeAudit(tx: Sql, row: AuditRow): Promise<void> {
  await tx`
    INSERT INTO pay.control_audit (scope, scope_id, merchant_id, kind, outcome, actor_id, second_actor_id, request_id, reason, before, after)
    VALUES (${row.scope}, ${row.scopeId}, ${row.merchantId ?? null}, ${row.kind}, ${row.outcome}, ${row.actorId}, ${row.secondActorId ?? null},
            ${row.requestId ?? null}, ${row.reason},
            ${row.before === undefined ? null : tx.json(row.before as never)}, ${row.after === undefined ? null : tx.json(row.after as never)})
  `;
}
