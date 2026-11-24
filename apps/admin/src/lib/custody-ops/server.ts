import 'server-only';
import { custodyApproverViewSchema, custodyTaskViewSchema } from '@intafaced/contracts/custody-approval-tasks';
import {
  founderCall,
  parseWith,
  type FounderCallContext,
  type FounderCallResult,
  partFrom,
  type Part,
  type PartLabels,
  founderRecordRead,
  founderRecordCall,
} from '@/lib/desk';
import { PENDING_WINDOW, RECENT_WINDOW, type CustodyOpsRead } from './server-types';
import type { CustodyTask, CustodyTaskDetail, Decision } from './model';
import { OPEN_ITEMS_WINDOW } from './open-items';
import {
  PAY_FOUNDER_ADMIN_CUSTODY_APPROVERS_PENDING,
  PAY_FOUNDER_ADMIN_CUSTODY_TASKS_LIST,
  PAY_FOUNDER_ADMIN_CUSTODY_APPROVERS_LIST,
  PAY_FOUNDER_ADMIN_DEPOSIT_OPEN_ITEMS_LIST,
  PAY_FOUNDER_ADMIN_CUSTODY_TASKS_GET,
  PAY_FOUNDER_ADMIN_CUSTODY_TASKS_CANCEL,
} from '@intafaced/contracts/pay-founder-admin-procedures';

/**
 * Custody approval tasks, read and decided as the signed-in founder. `founderAdmin.custody.*` is behind svc-pay's own founder
 * authority: the service checks the caller is a live founder, records which one, and decides whether they are a registered
 * approver. This console adds no authority and holds no quorum or approver list of its own.
 */
const LABELS: PartLabels = {
  service: 'svc-pay',
  forbiddenMessage: 'svc-pay did not accept your founder session for this read.',
  refusedMessage: (code) =>
    code === 'custody_approval.approver_not_registered'
      ? 'You are not a registered approver, so no task is waiting on you.'
      : code === 'custody_approval.list_limit_unset'
        ? 'The list size is not set.'
        : null,
};
const part = <T, U>(result: FounderCallResult<T>, pick: (data: T) => U): Part<U> => partFrom(result, pick, LABELS);
const list =
  <T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }) =>
  (raw: unknown): T[] | null => {
    if (!Array.isArray(raw)) return null;
    const out: T[] = [];
    for (const row of raw) {
      const parsed = schema.safeParse(row);
      if (!parsed.success) return null;
      out.push(parsed.data);
    }
    return out;
  };

export async function loadCustodyOps(ctx: FounderCallContext, now: Date = new Date()): Promise<CustodyOpsRead> {
  const [pending, recent, approvers, openItems] = await Promise.all([
    founderRecordRead(ctx, PAY_FOUNDER_ADMIN_CUSTODY_APPROVERS_PENDING, { limit: PENDING_WINDOW }, list(custodyTaskViewSchema)),
    founderRecordRead(ctx, PAY_FOUNDER_ADMIN_CUSTODY_TASKS_LIST, { limit: RECENT_WINDOW }, list(custodyTaskViewSchema)),
    founderRecordRead(ctx, PAY_FOUNDER_ADMIN_CUSTODY_APPROVERS_LIST, {}, list(custodyApproverViewSchema), {
      sendEmptyInput: true,
    }),
    founderRecordCall(ctx, PAY_FOUNDER_ADMIN_DEPOSIT_OPEN_ITEMS_LIST, { limit: OPEN_ITEMS_WINDOW }),
  ]);
  return {
    asOf: now.toISOString(),
    pending: part(pending, (d) => d),
    recent: part(recent, (d) => d),
    approvers: part(approvers, (d) => d),
    openItems: part(openItems, (d) => d),
  };
}

export async function loadTask(ctx: FounderCallContext, taskId: string): Promise<FounderCallResult<CustodyTaskDetail>> {
  return founderRecordCall(ctx, PAY_FOUNDER_ADMIN_CUSTODY_TASKS_GET, { taskId });
}

/** One decision. Approve and reject name the fingerprint the approver read; cancel is the initiator's own. */
export async function decideTask(
  ctx: FounderCallContext,
  decision: Decision,
  taskId: string,
  payloadHash: string | null,
): Promise<FounderCallResult<CustodyTask>> {
  const read = parseWith(custodyTaskViewSchema);
  if (decision === 'cancel') return founderRecordRead(ctx, PAY_FOUNDER_ADMIN_CUSTODY_TASKS_CANCEL, { taskId }, read);
  const choice: 'approve' | 'reject' = decision;
  return founderCall(ctx, 'pay', `founderAdmin.custody.tasks.${choice}`, 'POST', { taskId, payloadHash }, read);
}
