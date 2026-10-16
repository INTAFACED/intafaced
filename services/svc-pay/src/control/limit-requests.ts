import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { payCapSchema, type MerchantLimitIncreaseResult, type MerchantLimitRequest } from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import { writeAudit } from './audit.js';
import { ControlError } from './errors.js';

/**
 * LIMIT-INCREASE REQUESTS.
 *
 * A merchant records the caps they want and why. The row is the ask. It is not
 * applied to `control_merchant_profiles`, and the money path never reads this
 * table. One pending row per merchant: a repeat returns that row and does not
 * rewrite its caps. Founders still change caps through the dual-control flow.
 */

interface LimitRow {
  request_id: string;
  seq: string | number;
  merchant_id: string;
  caps: unknown;
  reason: string;
  status: 'pending';
  requested_by: string;
  created_at: Date | string;
}

function toView(row: LimitRow): MerchantLimitRequest {
  const caps = payCapSchema.array().min(1).max(32).safeParse(row.caps);
  if (!caps.success) throw new ControlError('pay.control_invalid', 'stored limit request is unreadable');
  return {
    requestId: row.request_id,
    merchantId: row.merchant_id,
    caps: caps.data,
    reason: row.reason,
    status: 'pending',
    requestedBy: row.requested_by,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const uniqueViolation = (error: unknown): boolean => (error as { code?: string } | null)?.code === '23505';

export async function readOpenLimitRequest(sql: Sql, merchantId: string): Promise<MerchantLimitRequest | null> {
  const rows = await sql<LimitRow[]>`
    SELECT request_id, seq, merchant_id, caps, reason, status, requested_by, created_at
      FROM pay.control_limit_requests
     WHERE merchant_id = ${merchantId} AND status = 'pending'
  `;
  return rows[0] ? toView(rows[0]) : null;
}

export async function listPendingLimitRequests(
  sql: Sql,
  input: { limit: number; cursor?: string },
): Promise<{ requests: MerchantLimitRequest[]; nextCursor: string | null }> {
  if (input.cursor !== undefined && !/^[1-9]\d*$/.test(input.cursor)) throw new ControlError('pay.control_invalid', 'cursor');
  const after = input.cursor ?? '0';
  const rows = await sql<LimitRow[]>`
    SELECT request_id, seq, merchant_id, caps, reason, status, requested_by, created_at
      FROM pay.control_limit_requests
     WHERE status = 'pending' AND seq > ${after}
     ORDER BY seq ASC
     LIMIT ${input.limit + 1}
  `;
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    requests: page.map(toView),
    nextCursor: rows.length > input.limit && last ? String(last.seq) : null,
  };
}

export async function requestLimitIncrease(
  sql: Sql,
  principal: Principal,
  input: { merchantId: string; requestId: string; caps: MerchantLimitRequest['caps']; reason: string },
): Promise<MerchantLimitIncreaseResult> {
  const requestedBy = principal.userId?.trim();
  if (!requestedBy) throw new ControlError('pay.merchant_not_found');
  const merchantId = input.merchantId.toLowerCase();
  const requestId = input.requestId.toLowerCase();
  const caps = payCapSchema.array().min(1).max(32).parse(input.caps);

  const finish = (outcome: MerchantLimitIncreaseResult['outcome'], row: LimitRow): MerchantLimitIncreaseResult => ({
    ...toView(row),
    outcome,
  });

  try {
    return await transaction(
      sql,
      async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`pay.limit-request:${merchantId}`}))`;
        const open = await tx<LimitRow[]>`
          SELECT request_id, seq, merchant_id, caps, reason, status, requested_by, created_at
            FROM pay.control_limit_requests
           WHERE merchant_id = ${merchantId} AND status = 'pending'
           FOR UPDATE
        `;
        if (open[0]) return finish('already_open', open[0]);
        const byId = await tx<Array<{ merchant_id: string }>>`
          SELECT merchant_id FROM pay.control_limit_requests WHERE request_id = ${requestId}
        `;
        if (byId[0]) throw new ControlError('pay.request_id_reused');
        const inserted = await tx<LimitRow[]>`
          INSERT INTO pay.control_limit_requests (request_id, merchant_id, caps, reason, status, requested_by)
          VALUES (${requestId}, ${merchantId}, ${tx.json(caps as never)}, ${input.reason}, 'pending', ${requestedBy})
          RETURNING request_id, seq, merchant_id, caps, reason, status, requested_by, created_at
        `;
        const row = inserted[0];
        if (!row) throw new ControlError('pay.control_invalid', 'limit request was not stored');
        await writeAudit(tx, {
          scope: 'merchant',
          scopeId: merchantId,
          merchantId,
          kind: 'limit.increase_requested',
          outcome: 'pending',
          actorId: requestedBy,
          requestId,
          reason: input.reason,
          after: { requestId, caps },
        });
        return finish('stored', row);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  } catch (error) {
    if (!uniqueViolation(error)) throw error;
    const open = await readOpenLimitRequest(sql, merchantId);
    if (open && open.merchantId === merchantId) return { ...open, outcome: 'already_open' };
    throw new ControlError('pay.request_id_reused');
  }
}
