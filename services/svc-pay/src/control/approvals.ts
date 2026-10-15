import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import type { PayoutApproval } from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { requireDualControl, DualControlError } from '../dual-control.js';
import { payoutPayloadHash, voidStaleApprovals, type PayoutPayload } from './approval-gate.js';
import { writeAudit } from './audit.js';
import type { ControlAccessPorts } from './access.js';
import { ControlError } from './errors.js';
import { loadMerchantControl } from './store.js';

/**
 * MAKER-CHECKER ON PAYOUTS.
 *
 *   maker    asks (`request`): needs to see the merchant; the request is bound to
 *            the settlement's exact amount, asset, rail and CURRENT destination.
 *   checker  decides (`decide`): must be a DIFFERENT person from the maker, must
 *            pass `canApprovePayout` for this merchant, and signs the exact hash
 *            they reviewed. A person of another merchant gets the same answer as
 *            for an id that does not exist.
 *   founders (`founderDecide`): only when the amount is at or above the tier's
 *            founder threshold. Two DISTINCT founders, each on their own live
 *            session, neither the maker nor the checker.
 *
 * Any decision re-reads the settlement and the destination: if the amount or the
 * destination moved since the request, the approval is VOIDED and returned as
 * `voided`, not approved. `beforePayoutAdmit` is the other half: it only lets a
 * payout through on a fully decided, unexpired approval for exactly its payload.
 */

interface ApprovalRow {
  id: string;
  seq: string;
  merchant_id: string;
  settlement_id: string;
  asset_code: string;
  amount: string;
  rail_id: string;
  destination_kind: string;
  destination_ref: string;
  payload_hash: string;
  status: PayoutApproval['status'];
  founder_required: boolean;
  maker_user_id: string;
  checker_user_id: string | null;
  checker_reason: string | null;
  checker_decided_at: Date | null;
  founder_first_user_id: string | null;
  founder_second_user_id: string | null;
  created_at: Date;
  decided_at: Date | null;
  expires_at: Date;
}

export interface ApprovalDetail extends PayoutApproval {
  readonly founderRequired: boolean;
  readonly checkerDecided: boolean;
  readonly founderApprovals: number;
}

export function toApprovalView(row: ApprovalRow, now: Date): ApprovalDetail {
  const live = row.status === 'pending' || row.status === 'approved';
  const status = live && row.expires_at.getTime() <= now.getTime() ? 'expired' : row.status;
  return {
    approvalId: row.id,
    merchantId: row.merchant_id,
    settlementId: row.settlement_id,
    amount: formatAmount(parseAmount(row.amount)),
    assetCode: row.asset_code,
    payloadHash: row.payload_hash as PayoutApproval['payloadHash'],
    status,
    makerUserId: row.maker_user_id,
    checkerUserId: row.checker_user_id,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    expiresAt: row.expires_at.toISOString(),
    founderRequired: row.founder_required,
    checkerDecided: row.checker_user_id !== null,
    founderApprovals: (row.founder_first_user_id ? 1 : 0) + (row.founder_second_user_id ? 1 : 0),
  };
}

/** The contract view, without the internal progress fields. */
export function toContractApproval(detail: ApprovalDetail): PayoutApproval {
  const { founderRequired: _a, checkerDecided: _b, founderApprovals: _c, ...contract } = detail;
  return contract;
}

export interface ApprovalServiceOptions {
  readonly access: ControlAccessPorts;
  readonly now?: () => Date;
}

const notFound = () => new ControlError('pay.approval_not_found', 'approval not found');

export class ApprovalService {
  private readonly now: () => Date;

  constructor(
    private readonly sql: Sql,
    private readonly options: ApprovalServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private actorId(principal: Principal | null | undefined): string {
    if (!principal?.userId) throw new ControlError('pay.approval_forbidden');
    return principal.userId;
  }

  /** Decisions are made by a person on an interactive session with a second factor, never by an API key. */
  private assertHumanChecker(principal: Principal): void {
    if (principal.kid || !principal.mfa) throw new ControlError('pay.approval_mfa_required');
  }

  private async currentPayload(tx: Sql, row: ApprovalRow): Promise<PayoutPayload | null> {
    const settlement = await tx<Array<{ net: string; asset_id: string }>>`
      SELECT net, asset_id FROM pay.settlements WHERE id = ${row.settlement_id} AND merchant_id = ${row.merchant_id}
    `;
    const destination = await tx<Array<{ kind: string; ref: string }>>`
      SELECT kind, ref FROM pay.merchant_payout_destinations WHERE merchant_id = ${row.merchant_id} AND rail_id = ${row.rail_id}
    `;
    if (!settlement[0] || !destination[0]) return null;
    return {
      merchantId: row.merchant_id,
      settlementId: row.settlement_id,
      assetCode: settlement[0].asset_id,
      amount: parseAmount(settlement[0].net),
      railId: row.rail_id,
      destination: destination[0],
    };
  }

  /** Void and persist when the payload moved or the request expired. Returns the settled row, or null if still live and current. */
  private async settleIfStale(tx: Sql, row: ApprovalRow): Promise<ApprovalRow | null> {
    if (row.status !== 'pending' && row.status !== 'approved') return row;
    const at = this.now();
    if (row.expires_at.getTime() <= at.getTime()) {
      const updated = await tx<ApprovalRow[]>`
        UPDATE pay.control_payout_approvals SET status = 'expired', decided_at = now() WHERE id = ${row.id} RETURNING *
      `;
      await writeAudit(tx, {
        scope: 'approval',
        scopeId: row.id,
        merchantId: row.merchant_id,
        kind: 'payout.approval_expired',
        outcome: 'expired',
        actorId: 'system:approvals',
        reason: 'the request expired before it was fully approved',
      });
      return updated[0]!;
    }
    const current = await this.currentPayload(tx, row);
    if (!current || payoutPayloadHash(current) !== row.payload_hash) {
      const updated = await tx<ApprovalRow[]>`
        UPDATE pay.control_payout_approvals
           SET status = 'voided', void_reason = 'amount, rail or destination changed after the request', decided_at = now()
         WHERE id = ${row.id} RETURNING *
      `;
      await writeAudit(tx, {
        scope: 'approval',
        scopeId: row.id,
        merchantId: row.merchant_id,
        kind: 'payout.approval_voided',
        outcome: 'voided',
        actorId: 'system:approvals',
        reason: 'amount, rail or destination changed after the request',
      });
      return updated[0]!;
    }
    return null;
  }

  /** The maker asks for approval of one payout. Idempotent per exact payload. */
  async request(principal: Principal, input: { merchantId: string; settlementId: string; railId: string }): Promise<ApprovalDetail> {
    const maker = this.actorId(principal);
    if (!(await this.options.access.canViewMerchant(principal, input.merchantId))) throw new ControlError('pay.merchant_not_found');
    const at = this.now();
    return transaction(
      this.sql,
      async (tx) => {
        const settlement = await tx<Array<{ net: string; asset_id: string; status: string }>>`
          SELECT net, asset_id, status FROM pay.settlements WHERE id = ${input.settlementId} AND merchant_id = ${input.merchantId}
        `;
        const s = settlement[0];
        if (!s || (s.status !== 'posted' && s.status !== 'failed')) throw new ControlError('pay.settlement_not_payable');
        const control = await loadMerchantControl(tx, input.merchantId);
        if (!control.tier) throw new ControlError('pay.tier_unassigned');
        const approvalThreshold = control.tier.approvalThresholds.get(s.asset_id);
        const founderThreshold = control.tier.founderThresholds.get(s.asset_id);
        if (approvalThreshold === undefined || founderThreshold === undefined)
          throw new ControlError('pay.approval_threshold_unconfigured');
        const amount = parseAmount(s.net);
        if (amount < approvalThreshold) throw new ControlError('pay.approval_not_required');
        const destinationRows = await tx<Array<{ kind: string; ref: string }>>`
          SELECT kind, ref FROM pay.merchant_payout_destinations WHERE merchant_id = ${input.merchantId} AND rail_id = ${input.railId}
        `;
        if (!destinationRows[0]) throw new ControlError('pay.payout_destination_missing');
        const payload: PayoutPayload = {
          merchantId: input.merchantId,
          settlementId: input.settlementId,
          assetCode: s.asset_id,
          amount,
          railId: input.railId,
          destination: destinationRows[0],
        };
        const hash = payoutPayloadHash(payload);
        // A request for a changed payload voids the earlier ones for this settlement.
        await voidStaleApprovals(tx, payload, hash);
        const existing = await tx<ApprovalRow[]>`
          SELECT * FROM pay.control_payout_approvals
           WHERE settlement_id = ${input.settlementId} AND payload_hash = ${hash} AND status IN ('pending', 'approved')
        `;
        if (existing[0]) return toApprovalView(existing[0], at);
        const inserted = await tx<ApprovalRow[]>`
          INSERT INTO pay.control_payout_approvals (
            merchant_id, settlement_id, asset_code, amount, rail_id, destination_kind, destination_ref,
            payload_hash, founder_required, maker_user_id, expires_at
          ) VALUES (
            ${input.merchantId}, ${input.settlementId}, ${s.asset_id}, ${formatAmount(amount)}::numeric, ${input.railId},
            ${destinationRows[0].kind}, ${destinationRows[0].ref}, ${hash}, ${amount >= founderThreshold}, ${maker},
            ${new Date(at.getTime() + control.tier.approvalTtlSeconds * 1000)}
          ) RETURNING *
        `;
        const row = inserted[0]!;
        await writeAudit(tx, {
          scope: 'approval',
          scopeId: row.id,
          merchantId: input.merchantId,
          kind: 'payout.approval_requested',
          outcome: 'pending',
          actorId: maker,
          reason: 'payout approval requested',
          after: { settlementId: input.settlementId, payloadHash: hash, founderRequired: row.founder_required },
        });
        return toApprovalView(row, at);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  async list(
    principal: Principal,
    input: { merchantId: string; status?: PayoutApproval['status']; limit: number },
  ): Promise<ApprovalDetail[]> {
    this.actorId(principal);
    if (!(await this.options.access.canViewMerchant(principal, input.merchantId))) throw new ControlError('pay.merchant_not_found');
    const at = this.now();
    const rows = await this.sql<ApprovalRow[]>`
      SELECT * FROM pay.control_payout_approvals WHERE merchant_id = ${input.merchantId} ORDER BY seq DESC LIMIT ${input.limit * 4}
    `;
    return rows
      .map((r) => toApprovalView(r, at))
      .filter((a) => input.status === undefined || a.status === input.status)
      .slice(0, input.limit);
  }

  /** Merchant-side checker decision. */
  async decide(
    principal: Principal,
    input: { approvalId: string; decision: 'approve' | 'reject'; expectedPayloadHash: string; reason: string },
  ): Promise<ApprovalDetail> {
    const checker = this.actorId(principal);
    this.assertHumanChecker(principal);
    const at = this.now();
    return transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<ApprovalRow[]>`SELECT * FROM pay.control_payout_approvals WHERE id = ${input.approvalId} FOR UPDATE`;
        const row = rows[0];
        // Another merchant's person, and an id that does not exist, get one answer.
        if (!row || !(await this.options.access.canViewMerchant(principal, row.merchant_id))) throw notFound();
        if (!(await this.options.access.canApprovePayout(principal, row.merchant_id))) throw new ControlError('pay.approval_forbidden');
        if (row.maker_user_id === checker) throw new ControlError('pay.approval_self_approval');
        if (row.payload_hash !== input.expectedPayloadHash) throw new ControlError('pay.approval_payload_mismatch');
        const settled = await this.settleIfStale(tx, row);
        if (settled) return toApprovalView(settled, at);
        if (row.status !== 'pending' || row.checker_user_id !== null) throw new ControlError('pay.approval_not_pending');

        if (input.decision === 'reject') {
          const updated = await tx<ApprovalRow[]>`
            UPDATE pay.control_payout_approvals
               SET status = 'rejected', checker_user_id = ${checker}, checker_reason = ${input.reason}, checker_decided_at = now(), decided_at = now()
             WHERE id = ${row.id} RETURNING *
          `;
          await writeAudit(tx, {
            scope: 'approval',
            scopeId: row.id,
            merchantId: row.merchant_id,
            kind: 'payout.approval_decided',
            outcome: 'rejected',
            actorId: checker,
            reason: input.reason,
          });
          return toApprovalView(updated[0]!, at);
        }
        // Approved by the merchant side. Stays `pending` until both founders sign when the amount needs them.
        const updated = await tx<ApprovalRow[]>`
          UPDATE pay.control_payout_approvals
             SET checker_user_id = ${checker}, checker_reason = ${input.reason}, checker_decided_at = now(),
                 status = ${row.founder_required ? 'pending' : 'approved'},
                 decided_at = ${row.founder_required ? null : at}
           WHERE id = ${row.id} RETURNING *
        `;
        await writeAudit(tx, {
          scope: 'approval',
          scopeId: row.id,
          merchantId: row.merchant_id,
          kind: 'payout.approval_decided',
          outcome: row.founder_required ? 'checker_approved_awaiting_founders' : 'approved',
          actorId: checker,
          reason: input.reason,
        });
        return toApprovalView(updated[0]!, at);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /** The maker withdraws a request that is not yet fully approved. */
  async cancel(principal: Principal, input: { approvalId: string; reason: string }): Promise<ApprovalDetail> {
    const actor = this.actorId(principal);
    const at = this.now();
    return transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<ApprovalRow[]>`SELECT * FROM pay.control_payout_approvals WHERE id = ${input.approvalId} FOR UPDATE`;
        const row = rows[0];
        if (!row || !(await this.options.access.canViewMerchant(principal, row.merchant_id))) throw notFound();
        if (row.maker_user_id !== actor) throw new ControlError('pay.approval_forbidden');
        if (row.status !== 'pending') throw new ControlError('pay.approval_not_pending');
        const updated = await tx<ApprovalRow[]>`
          UPDATE pay.control_payout_approvals SET status = 'voided', void_reason = 'cancelled by the maker', decided_at = now()
           WHERE id = ${row.id} RETURNING *
        `;
        await writeAudit(tx, {
          scope: 'approval',
          scopeId: row.id,
          merchantId: row.merchant_id,
          kind: 'payout.approval_cancelled',
          outcome: 'voided',
          actorId: actor,
          reason: input.reason,
        });
        return toApprovalView(updated[0]!, at);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /** Founders waiting to sign: merchant-side approved, founder step still open. */
  async founderQueue(input: { limit: number; cursor?: string }): Promise<{ approvals: ApprovalDetail[]; nextCursor: string | null }> {
    const at = this.now();
    const after = input.cursor && /^\d+$/.test(input.cursor) ? input.cursor : '0';
    const rows = await this.sql<ApprovalRow[]>`
      SELECT * FROM pay.control_payout_approvals
       WHERE founder_required AND status = 'pending' AND checker_user_id IS NOT NULL AND seq > ${after}
       ORDER BY seq ASC LIMIT ${input.limit + 1}
    `;
    const page = rows.slice(0, input.limit);
    return {
      approvals: page.map((r) => toApprovalView(r, at)),
      nextCursor: rows.length > input.limit ? page[page.length - 1]!.seq : null,
    };
  }

  /** A founder signs (first call) or countersigns (second call, a different founder). */
  async founderDecide(
    founderUserId: string,
    input: { approvalId: string; decision: 'approve' | 'reject'; expectedPayloadHash: string; reason: string },
  ): Promise<ApprovalDetail> {
    const at = this.now();
    return transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<ApprovalRow[]>`SELECT * FROM pay.control_payout_approvals WHERE id = ${input.approvalId} FOR UPDATE`;
        const row = rows[0];
        if (!row) throw notFound();
        if (row.payload_hash !== input.expectedPayloadHash) throw new ControlError('pay.approval_payload_mismatch');
        const settled = await this.settleIfStale(tx, row);
        if (settled) return toApprovalView(settled, at);
        if (!row.founder_required || row.status !== 'pending' || row.checker_user_id === null)
          throw new ControlError('pay.approval_not_pending');
        if (founderUserId === row.maker_user_id || founderUserId === row.checker_user_id)
          throw new ControlError('pay.approval_self_approval');

        if (input.decision === 'reject') {
          const updated = await tx<ApprovalRow[]>`
            UPDATE pay.control_payout_approvals SET status = 'rejected', decided_at = now() WHERE id = ${row.id} RETURNING *
          `;
          await writeAudit(tx, {
            scope: 'approval',
            scopeId: row.id,
            merchantId: row.merchant_id,
            kind: 'payout.founder_decided',
            outcome: 'rejected',
            actorId: founderUserId,
            secondActorId: row.founder_first_user_id,
            reason: input.reason,
          });
          return toApprovalView(updated[0]!, at);
        }
        if (row.founder_first_user_id === null) {
          const updated = await tx<ApprovalRow[]>`
            UPDATE pay.control_payout_approvals SET founder_first_user_id = ${founderUserId} WHERE id = ${row.id} RETURNING *
          `;
          await writeAudit(tx, {
            scope: 'approval',
            scopeId: row.id,
            merchantId: row.merchant_id,
            kind: 'payout.founder_decided',
            outcome: 'first_founder_approved',
            actorId: founderUserId,
            reason: input.reason,
          });
          return toApprovalView(updated[0]!, at);
        }
        try {
          requireDualControl(row.founder_first_user_id, founderUserId);
        } catch (error) {
          if (error instanceof DualControlError) throw new ControlError('pay.dual_control_required', error.message);
          throw error;
        }
        const updated = await tx<ApprovalRow[]>`
          UPDATE pay.control_payout_approvals
             SET founder_second_user_id = ${founderUserId}, status = 'approved', decided_at = ${at}
           WHERE id = ${row.id} RETURNING *
        `;
        await writeAudit(tx, {
          scope: 'approval',
          scopeId: row.id,
          merchantId: row.merchant_id,
          kind: 'payout.founder_decided',
          outcome: 'approved',
          actorId: founderUserId,
          secondActorId: row.founder_first_user_id,
          reason: input.reason,
        });
        return toApprovalView(updated[0]!, at);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }
}
