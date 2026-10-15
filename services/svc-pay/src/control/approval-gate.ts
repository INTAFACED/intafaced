import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { ControlRefusal } from './errors.js';

/**
 * The payload an approval is bound to. Amount, asset, rail and destination are
 * all in it: change any one and the hash differs, so the approval no longer
 * matches and is voided. Destination text is compared case-insensitively
 * (an EVM address's checksum casing is not a different destination).
 */
export interface PayoutPayload {
  readonly merchantId: string;
  readonly settlementId: string;
  readonly assetCode: string;
  readonly amount: Amount;
  readonly railId: string;
  readonly destination: { readonly kind: string; readonly ref: string };
}

export function payoutPayloadHash(p: PayoutPayload): string {
  const canonical = JSON.stringify([
    'payout.approval.v1',
    p.merchantId.toLowerCase(),
    p.settlementId.toLowerCase(),
    p.assetCode,
    formatAmount(p.amount),
    p.railId,
    p.destination.kind.trim().toLowerCase(),
    p.destination.ref.trim().toLowerCase(),
  ]);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * Called by `beforePayoutAdmit` for a payout at or above the tier's approval
 * threshold. Runs INSIDE the admission transaction.
 *
 * Passes (and consumes the approval for this attempt) only when an approval is
 * fully decided, unexpired and bound to exactly this payload. Otherwise it
 * refuses `pay.approval_required`. On the way out it VOIDS any live approval for
 * this settlement whose payload differs, through the pool rather than the
 * transaction, so the void survives the rollback that the refusal causes.
 */
export async function requirePayoutApproval(tx: Sql, pool: Sql, payload: PayoutPayload, attempt: number, now: Date): Promise<void> {
  const hash = payoutPayloadHash(payload);
  const rows = await tx<Array<{ id: string; status: string; consumed_attempt: number | null; expires_at: Date }>>`
    SELECT id, status, consumed_attempt, expires_at FROM pay.control_payout_approvals
     WHERE merchant_id = ${payload.merchantId} AND settlement_id = ${payload.settlementId} AND payload_hash = ${hash}
       AND status IN ('approved', 'consumed')
     ORDER BY seq DESC
       FOR UPDATE
  `;
  // The same attempt coming through again is a repeat, not a second use.
  if (rows.some((r) => r.status === 'consumed' && r.consumed_attempt === attempt)) return;
  const usable = rows.find((r) => r.status === 'approved' && r.expires_at.getTime() > now.getTime());
  if (usable) {
    await tx`
      UPDATE pay.control_payout_approvals SET status = 'consumed', consumed_attempt = ${attempt}
       WHERE id = ${usable.id} AND status = 'approved'
    `;
    await tx`
      INSERT INTO pay.control_audit (scope, scope_id, merchant_id, kind, outcome, actor_id, reason, after)
      VALUES ('approval', ${usable.id}, ${payload.merchantId}, 'payout.approval_consumed', 'consumed', 'system:payout_guard',
              ${`consumed by payout attempt ${attempt}`}, ${tx.json({ settlementId: payload.settlementId, attempt })})
    `;
    return;
  }
  // Best effort and bounded. This runs on a second connection while the caller's
  // transaction still holds the merchant and settlement locks; a concurrent
  // `request` holding a stale row and waiting on that settlement would otherwise
  // be a wait Postgres cannot see as a deadlock. A stale approval cannot match
  // this payload anyway, so a failed void never changes the refusal.
  try {
    await pool.begin(async (t) => {
      await t`SET LOCAL lock_timeout = '2s'`;
      await voidStaleApprovals(t as unknown as Sql, payload, hash);
    });
  } catch {
    // Refuse below regardless; the next decision or request voids it.
  }
  throw new ControlRefusal('pay.approval_required');
}

/** Void live approvals for the settlement that are bound to a different payload. Idempotent. */
export async function voidStaleApprovals(pool: Sql, payload: PayoutPayload, currentHash: string): Promise<string[]> {
  const voided = await pool<Array<{ id: string }>>`
    UPDATE pay.control_payout_approvals
       SET status = 'voided', void_reason = 'amount, rail or destination changed after the request', decided_at = now()
     WHERE merchant_id = ${payload.merchantId} AND settlement_id = ${payload.settlementId}
       AND payload_hash <> ${currentHash} AND status IN ('pending', 'approved')
    RETURNING id
  `;
  for (const row of voided) {
    await pool`
      INSERT INTO pay.control_audit (scope, scope_id, merchant_id, kind, outcome, actor_id, reason, after)
      VALUES ('approval', ${row.id}, ${payload.merchantId}, 'payout.approval_voided', 'voided', 'system:payout_guard',
              'amount, rail or destination changed after the request', ${pool.json({ settlementId: payload.settlementId, currentHash })})
    `;
  }
  return voided.map((r) => r.id);
}
