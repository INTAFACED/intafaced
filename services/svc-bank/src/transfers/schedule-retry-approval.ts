import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { createIdentityApprovalClient } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import type { ScheduleRunRetry } from './schedule-edit.js';

/**
 * BK-xfer-10 review #7: the operator retry of a standing-order run is a four-eyes money action, following the #5827
 * founding-badge precedent. A second person approves the exact payload in identity; this service consumes the approval
 * (shared-secret mode), checks approver != proposer and != the acting operator, and writes an audit row in the same
 * transaction as the settle. Unwired (IDENTITY_URL or INTERNAL_SERVICE_SECRET blank) refuses; no approver is invented.
 */
export const SCHEDULE_RETRY_ACTION = 'bank.schedule.retry_run' as const;

export interface ScheduleRetryApprovalConsumer {
  consume(input: {
    approvalId: string;
    operationId: string;
    payloadHash: string;
    targetService: string;
    targetId: string;
    expectedVersion: string;
  }): Promise<{ status: string; requesterId: string; approverId: string | null }>;
}

/** sha256 over the canonical retry payload: schedule, occurrence, the run's STORED amount and the reason. */
export function scheduleRetryPayloadHash(scheduleId: string, occurrence: number, amount: string, reason: string): string {
  const canonical = JSON.stringify({ action: SCHEDULE_RETRY_ACTION, scheduleId, occurrence, amount, reason });
  return createHash('sha256').update(canonical).digest('hex');
}

export function scheduleRetryApprovalConsumer(
  identityUrl: string | undefined,
  internalSecret: string | undefined,
): ScheduleRetryApprovalConsumer | null {
  if (!identityUrl?.trim() || !internalSecret?.trim()) return null;
  return createIdentityApprovalClient({
    service: 'svc-bank',
    baseUrl: identityUrl,
    internalSecret,
    timeoutMs: 2_000,
    fail: (message) => new BankError(message, 'bank.schedule_retry_approval_refused'),
  });
}

export interface ApprovedRetryInput {
  scheduleId: string;
  occurrence: number;
  reason: string;
  actorId: string;
  approvalId: string;
  operationId: string;
  now?: Date;
}

export class ScheduleRetryDesk {
  constructor(
    private readonly retrier: ScheduleRunRetry,
    private readonly approvals: ScheduleRetryApprovalConsumer | null,
  ) {}

  async retry(input: ApprovedRetryInput) {
    const reason = input.reason?.trim() ?? '';
    const actorId = input.actorId?.trim() ?? '';
    if (reason.length < 3) throw new BankError('A reason is required for an operator retry', 'bank.schedule_retry_approval_refused');
    if (!actorId) throw new BankError('The acting operator is unknown', 'bank.schedule_retry_approval_refused');
    if (!this.approvals) {
      throw new BankError('Identity approval is not wired; a second person cannot be proven', 'bank.schedule_retry_approval_unwired');
    }
    const approvalId = input.approvalId?.trim() ?? '';
    const operationId = input.operationId?.trim() ?? '';
    if (!approvalId || !operationId) {
      throw new BankError('approvalId and operationId are required', 'bank.schedule_retry_approval_refused');
    }
    const run = await this.retrier.runFor(input.scheduleId, input.occurrence);
    if (!run) throw new BankError(`Run ${input.occurrence} of ${input.scheduleId} not found`, 'bank.schedule_not_found');
    // D89: the runner skips paused and cancelled schedules, so the retry refuses them too; checked BEFORE consuming
    // the approval so a refused retry does not burn it (the retry re-checks under the row lock).
    if (run.scheduleStatus !== 'active') {
      throw new BankError(`Schedule ${input.scheduleId} is ${run.scheduleStatus}; a rejected run is not retried`, 'bank.schedule_inactive');
    }
    const amount = formatAmount(parseAmount(run.amount)); // canonical, not Postgres numeric text
    const payloadHash = scheduleRetryPayloadHash(input.scheduleId, input.occurrence, amount, reason);
    let consumed: { status: string; requesterId: string; approverId: string | null };
    try {
      consumed = await this.approvals.consume({
        approvalId,
        operationId,
        payloadHash,
        targetService: 'svc-bank',
        targetId: `${input.scheduleId}:${input.occurrence}`,
        expectedVersion: `${run.status}:${amount}`,
      });
    } catch (err) {
      if (err instanceof BankError) throw err;
      throw new BankError(`identity refused the approval: ${(err as Error).message}`, 'bank.schedule_retry_approval_refused');
    }
    const approver = consumed.approverId?.trim() ?? '';
    const requester = consumed.requesterId?.trim() ?? '';
    if (consumed.status !== 'CONSUMED' || !approver || !requester) {
      throw new BankError('identity did not return a consumed approval with an approver', 'bank.schedule_retry_approval_refused');
    }
    if (approver.toLowerCase() === requester.toLowerCase() || approver.toLowerCase() === actorId.toLowerCase()) {
      throw new BankError('the approver must be a second person, not the proposer or the actor', 'bank.schedule_retry_approval_refused');
    }
    return this.retrier.retry({
      scheduleId: input.scheduleId,
      occurrence: input.occurrence,
      now: input.now,
      audit: async (tx: Sql, out) => {
        await tx`
          INSERT INTO bank.schedule_retry_audit
            (schedule_id, occurrence, actor_id, requester_id, approver_id, approval_id, reason, payload_hash, outcome, ledger_tx_id, rejection_code)
          VALUES (${input.scheduleId}, ${input.occurrence}, ${actorId}, ${requester}, ${approver}, ${approvalId}, ${reason},
                  ${payloadHash}, ${out.status}, ${out.ledgerTxId}, ${out.rejectionCode ?? null})
        `;
      },
    });
  }
}
