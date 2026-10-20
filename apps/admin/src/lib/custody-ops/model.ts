import type {
  CustodyApproverView,
  CustodyTaskDetailView,
  CustodyTaskStatus,
  CustodyTaskView,
} from '@intafaced/contracts/custody-approval-tasks';
import type { Gate } from '@/lib/desk/desk-model';

/** The shapes svc-pay publishes under `founderAdmin.custody.*`, from contracts. Types only: client code never loads the schemas. */
export type TaskStatus = CustodyTaskStatus;
/** Every status, for reading a reply in the browser. `STATUS_LABEL` below is typed over the contract's list, so a new status fails the build here. */
export const TASK_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'canceled',
  'expired',
  'failed',
  'executed',
] as const satisfies readonly TaskStatus[];
export type CustodyTask = CustodyTaskView;
export type CustodyTaskDetail = CustodyTaskDetailView;
export type CustodyApprover = CustodyApproverView;

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'Waiting for approvals',
  approved: 'Approved, running',
  rejected: 'Rejected',
  canceled: 'Cancelled',
  expired: 'Expired, did not run',
  failed: 'Could not run',
  executed: 'Done',
};
export const KIND_LABEL = { custody_transaction: 'Custody transaction', config: 'Workspace setting change' } as const;
export const SCOPE_LABEL: Record<string, string> = {
  address_whitelist: 'Address whitelist',
  connections: 'Connections',
  users: 'Users',
  policy: 'Policy',
  approval_groups: 'Approval groups',
};

export const DECISIONS = ['approve', 'reject', 'cancel'] as const;
export type Decision = (typeof DECISIONS)[number];

const short = (hash: string) => hash.slice(0, 8);
/** The phrase the approver types back: it carries the first eight characters of the fingerprint they read. */
export function decisionPhrase(decision: Decision, task: Pick<CustodyTask, 'payloadHash'>): string {
  return decision === 'cancel' ? 'CANCEL' : `${decision === 'approve' ? 'APPROVE' : 'REJECT'} ${short(task.payloadHash)}`;
}

/** Whether this person may decide the task now, and if not, the plain reason. The service checks all of it again. */
export function decisionGate(decision: Decision, task: CustodyTask, userId: string, now: Date): Gate {
  if (task.status !== 'pending') return { ok: false, why: STATUS_LABEL[task.status] };
  if (new Date(task.expiresAt).getTime() <= now.getTime()) return { ok: false, why: 'This task passed its deadline.' };
  if (decision === 'cancel')
    return task.initiator === userId ? { ok: true } : { ok: false, why: 'Only the person who started it can cancel it.' };
  if (task.initiator === userId) return { ok: false, why: 'You started this task, so someone else has to decide it.' };
  if (decision === 'approve' && task.approvedByMe) return { ok: false, why: 'You already approved this task.' };
  return { ok: true };
}

/** One row per payload field. Nested values are shown as compact JSON; nothing is rounded or reformatted. */
export function payloadRows(payload: Record<string, unknown>): readonly (readonly [string, string])[] {
  return Object.entries(payload).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)] as const);
}

/** Time left until the deadline, in plain words, or null once it has passed. */
export function timeLeft(expiresAt: string, now: Date): string | null {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute left';
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h left` : `${Math.floor(hours / 24)} days left`;
}

export const EVENT_LABEL: Record<string, string> = {
  submitted: 'Started',
  approved: 'Approved',
  rejected: 'Rejected',
  canceled: 'Cancelled',
  expired: 'Expired',
  quorum: 'Enough approvals',
  executed: 'Ran',
  failed: 'Could not run',
};
