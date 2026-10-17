import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import {
  merchantLimitAskCapsSchema,
  payCapSchema,
  type FounderLimitRequestCloseResult,
  type MerchantLimitIncreaseResult,
  type MerchantLimitRequest,
  type MerchantLimitTerminal,
  type MerchantLimitWithdrawResult,
} from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import { writeAudit } from './audit.js';
import { ControlError } from './errors.js';

/**
 * LIMIT-INCREASE REQUESTS.
 *
 * A merchant records the caps they want and why. The row is the ask. It is not
 * applied to `control_merchant_profiles`, and the money path never reads this
 * table. One pending row per merchant: a repeat returns that row and does not
 * rewrite its caps. The merchant may withdraw it once. A founder may close it
 * once. Confirming a cap change or a tier change for that merchant closes the
 * pending ask in the same transaction. That close writes the row and an audit
 * of the caps as stored. It does not parse them again: an ask whose caps no
 * longer match the cap schema must not block the change. A read or a withdraw
 * of that row returns `{ raw, capsReadable: false }` and does not throw, so one
 * bad row cannot hide the others. Founders still change caps through the
 * dual-control flow.
 */

interface PendingRow {
  request_id: string;
  seq: string | number;
  merchant_id: string;
  caps: unknown;
  reason: string;
  status: string;
  requested_by: string;
  created_at: Date | string;
}

interface TerminalRow extends PendingRow {
  closed_at: Date | string | null;
  closed_by: string | null;
  close_reason: string | null;
}

const readableCaps = payCapSchema.array().min(1).max(32);

/**
 * One view of stored caps. A parse failure is the row, flagged, not an error:
 * list, open, already-open and withdraw all use this.
 */
function viewStoredCaps(raw: unknown): MerchantLimitRequest['caps'] {
  const caps = readableCaps.safeParse(raw);
  return caps.success ? caps.data : { raw, capsReadable: false };
}

function toPending(row: PendingRow): MerchantLimitRequest {
  if (row.status !== 'pending') throw new ControlError('pay.control_invalid', 'stored limit request is unreadable');
  return {
    requestId: row.request_id,
    merchantId: row.merchant_id,
    caps: viewStoredCaps(row.caps),
    reason: row.reason,
    status: 'pending',
    requestedBy: row.requested_by,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function toTerminal(row: TerminalRow): MerchantLimitTerminal {
  if (row.status !== 'withdrawn' && row.status !== 'closed')
    throw new ControlError('pay.control_invalid', 'stored limit request is unreadable');
  if (!row.closed_at || !row.closed_by || !row.close_reason)
    throw new ControlError('pay.control_invalid', 'stored limit request is unreadable');
  return {
    requestId: row.request_id,
    merchantId: row.merchant_id,
    caps: viewStoredCaps(row.caps),
    reason: row.reason,
    requestedBy: row.requested_by,
    createdAt: new Date(row.created_at).toISOString(),
    status: row.status,
    closedAt: new Date(row.closed_at).toISOString(),
    closedBy: row.closed_by,
    closeReason: row.close_reason,
  };
}

const uniqueViolation = (error: unknown): boolean => (error as { code?: string } | null)?.code === '23505';

export async function readOpenLimitRequest(sql: Sql, merchantId: string): Promise<MerchantLimitRequest | null> {
  const rows = await sql<PendingRow[]>`
    SELECT request_id, seq, merchant_id, caps, reason, status, requested_by, created_at
      FROM pay.control_limit_requests
     WHERE merchant_id = ${merchantId} AND status = 'pending'
  `;
  return rows[0] ? toPending(rows[0]) : null;
}

export async function listPendingLimitRequests(
  sql: Sql,
  input: { limit: number; cursor?: string },
): Promise<{ requests: MerchantLimitRequest[]; nextCursor: string | null }> {
  if (input.cursor !== undefined && !/^[1-9]\d*$/.test(input.cursor)) throw new ControlError('pay.control_invalid', 'cursor');
  const after = input.cursor ?? '0';
  const rows = await sql<PendingRow[]>`
    SELECT request_id, seq, merchant_id, caps, reason, status, requested_by, created_at
      FROM pay.control_limit_requests
     WHERE status = 'pending' AND seq > ${after}
     ORDER BY seq ASC
     LIMIT ${input.limit + 1}
  `;
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    requests: page.map(toPending),
    nextCursor: rows.length > input.limit && last ? String(last.seq) : null,
  };
}

async function assertMerchantCanAsk(tx: Sql, merchantId: string): Promise<void> {
  const rows = await tx<Array<{ status: string }>>`
    SELECT status::text AS status FROM pay.merchants WHERE id = ${merchantId} FOR UPDATE
  `;
  const status = rows[0]?.status;
  if (!status) throw new ControlError('pay.merchant_not_found');
  if (status === 'suspended' || status === 'closed') throw new ControlError('pay.merchant_inactive');
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
  const caps = merchantLimitAskCapsSchema.parse(input.caps);

  const finish = (outcome: MerchantLimitIncreaseResult['outcome'], row: PendingRow): MerchantLimitIncreaseResult => ({
    ...toPending(row),
    outcome,
  });

  try {
    return await transaction(
      sql,
      async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`pay.limit-request:${merchantId}`}))`;
        await assertMerchantCanAsk(tx, merchantId);
        const open = await tx<PendingRow[]>`
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
        const inserted = await tx<PendingRow[]>`
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

async function lockRequest(tx: Sql, requestId: string): Promise<TerminalRow | null> {
  const rows = await tx<TerminalRow[]>`
    SELECT request_id, seq, merchant_id, caps, reason, status, requested_by, created_at, closed_at, closed_by, close_reason
      FROM pay.control_limit_requests
     WHERE request_id = ${requestId}
     FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function moveOnce(
  tx: Sql,
  row: TerminalRow,
  next: { status: 'withdrawn' | 'closed'; actorId: string; closeReason: string; auditKind: string; after?: unknown },
): Promise<TerminalRow> {
  if (row.status === next.status) return row;
  if (row.status !== 'pending') throw new ControlError('pay.limit_request_not_pending');
  const updated = await tx<TerminalRow[]>`
    UPDATE pay.control_limit_requests
       SET status = ${next.status},
           closed_at = now(),
           closed_by = ${next.actorId},
           close_reason = ${next.closeReason}
     WHERE request_id = ${row.request_id} AND status = 'pending'
     RETURNING request_id, seq, merchant_id, caps, reason, status, requested_by, created_at, closed_at, closed_by, close_reason
  `;
  const stored = updated[0];
  if (!stored) throw new ControlError('pay.limit_request_not_pending');
  await writeAudit(tx, {
    scope: 'merchant',
    scopeId: row.merchant_id,
    merchantId: row.merchant_id,
    kind: next.auditKind,
    outcome: next.status,
    actorId: next.actorId,
    requestId: row.request_id,
    reason: next.closeReason,
    after: next.after ?? { status: next.status, closeReason: next.closeReason },
  });
  return stored;
}

function asWithdrawn(row: MerchantLimitTerminal): MerchantLimitWithdrawResult {
  if (row.status !== 'withdrawn') throw new ControlError('pay.control_invalid', 'stored limit request is unreadable');
  return { ...row, status: 'withdrawn' };
}

/**
 * A close result. Caps are whatever was stored. A parse failure is not a
 * refusal: the row is already closed, and the caller still gets the JSON.
 */
function toClosed(row: TerminalRow): FounderLimitRequestCloseResult {
  if (row.status !== 'closed' || !row.closed_at || !row.closed_by || !row.close_reason) {
    throw new ControlError('pay.control_invalid', 'stored limit request is unreadable');
  }
  const parsed = readableCaps.safeParse(row.caps);
  return {
    requestId: row.request_id,
    merchantId: row.merchant_id,
    caps: parsed.success ? parsed.data : row.caps,
    reason: row.reason,
    requestedBy: row.requested_by,
    createdAt: new Date(row.created_at).toISOString(),
    status: 'closed',
    closedAt: new Date(row.closed_at).toISOString(),
    closedBy: row.closed_by,
    closeReason: row.close_reason,
  };
}

/** The merchant takes their own pending ask back. A repeat of the same withdrawn row returns it. */
export async function withdrawLimitRequest(
  sql: Sql,
  principal: Principal,
  input: { merchantId: string; requestId: string; reason: string },
): Promise<MerchantLimitWithdrawResult> {
  const actorId = principal.userId?.trim();
  if (!actorId) throw new ControlError('pay.merchant_not_found');
  const merchantId = input.merchantId.toLowerCase();
  const requestId = input.requestId.toLowerCase();
  return transaction(
    sql,
    async (tx) => {
      const row = await lockRequest(tx, requestId);
      if (!row || row.merchant_id !== merchantId) throw new ControlError('pay.limit_request_not_found');
      return asWithdrawn(
        toTerminal(
          await moveOnce(tx, row, {
            status: 'withdrawn',
            actorId,
            closeReason: input.reason,
            auditKind: 'limit.increase_withdrawn',
          }),
        ),
      );
    },
    { isolation: 'read committed', maxAttempts: 5 },
  );
}

/** A founder closes one ask without changing caps. A repeat of the same closed row returns it. */
export async function closeLimitRequest(
  sql: Sql,
  founderUserId: string,
  input: { requestId: string; reason: string },
): Promise<FounderLimitRequestCloseResult> {
  const requestId = input.requestId.toLowerCase();
  return transaction(
    sql,
    async (tx) => {
      const row = await lockRequest(tx, requestId);
      if (!row) throw new ControlError('pay.limit_request_not_found');
      return toClosed(
        await moveOnce(tx, row, {
          status: 'closed',
          actorId: founderUserId,
          closeReason: input.reason,
          auditKind: 'limit.increase_closed',
          after: { status: 'closed', closeReason: input.reason, caps: row.caps },
        }),
      );
    },
    { isolation: 'read committed', maxAttempts: 5 },
  );
}

/**
 * Called from a confirm transaction after the profile write. No pending ask is
 * a no-op. The reason is a fixed token, not a business magnitude. The stored
 * caps are copied into the audit as JSON and are not parsed: a failure to read
 * them must not roll back the change that closed the ask.
 */
async function closePending(
  tx: Sql,
  merchantId: string,
  founderUserId: string,
  closeReason: 'cap_change_confirmed' | 'tier_change_confirmed',
  link: { capChangeRequestId: string } | { tierChangeRequestId: string },
): Promise<void> {
  const open = await tx<TerminalRow[]>`
    SELECT request_id, seq, merchant_id, caps, reason, status, requested_by, created_at, closed_at, closed_by, close_reason
      FROM pay.control_limit_requests
     WHERE merchant_id = ${merchantId} AND status = 'pending'
     FOR UPDATE
  `;
  const row = open[0];
  if (!row) return;
  await moveOnce(tx, row, {
    status: 'closed',
    actorId: founderUserId,
    closeReason,
    auditKind: 'limit.increase_closed',
    after: { status: 'closed', closeReason, caps: row.caps, ...link },
  });
}

/** Auto-close inside a confirmed `set_caps`. */
export async function closePendingForCapChange(
  tx: Sql,
  merchantId: string,
  founderUserId: string,
  capChangeRequestId: string,
): Promise<void> {
  await closePending(tx, merchantId, founderUserId, 'cap_change_confirmed', { capChangeRequestId });
}

/** Auto-close inside a confirmed `set_tier`. */
export async function closePendingForTierChange(
  tx: Sql,
  merchantId: string,
  founderUserId: string,
  tierChangeRequestId: string,
): Promise<void> {
  await closePending(tx, merchantId, founderUserId, 'tier_change_confirmed', { tierChangeRequestId });
}
