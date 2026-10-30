/** Browser hop for the custody approvals desk. Same-origin BFF only; no credential is held here. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { RefusalView } from '@/lib/desk/refusal-copy';
import { TASK_STATUSES, type CustodyTask, type CustodyTaskDetail, type Decision } from './model';
import type { CustodyOpsRead } from './server-types';

export type DecisionReply =
  { readonly ok: true; readonly action: Decision; readonly task: CustodyTask } | { readonly ok: false; readonly refusal: RefusalView };
export type TaskReply = { readonly ok: true; readonly task: CustodyTaskDetail } | { readonly ok: false; readonly refusal: RefusalView };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const UNKNOWN: RefusalView = {
  title: 'The console got an answer it could not read',
  body: 'It is not known whether the decision went through.',
  next: 'Read the task again before doing anything else.',
  code: null,
  changed: 'unknown',
};

function refusalOf(raw: unknown): RefusalView {
  if (!isRecord(raw) || !isRecord(raw.refusal)) return UNKNOWN;
  const r = raw.refusal;
  if (
    typeof r.title === 'string' &&
    typeof r.body === 'string' &&
    typeof r.next === 'string' &&
    (r.changed === 'no' || r.changed === 'unknown')
  )
    return { title: r.title, body: r.body, next: r.next, code: typeof r.code === 'string' ? r.code : null, changed: r.changed };
  return UNKNOWN;
}

/**
 * The BFF has already checked every task against the contract schema; this keeps the fields a decision depends on honest, and
 * anything else is "outcome unknown". The browser does not load the schemas (the contracts root is not browser code).
 */
function readTask(raw: unknown): CustodyTask | null {
  if (!isRecord(raw)) return null;
  const ok =
    typeof raw.id === 'string' &&
    typeof raw.title === 'string' &&
    typeof raw.initiator === 'string' &&
    typeof raw.payloadHash === 'string' &&
    /^[0-9a-f]{64}$/.test(raw.payloadHash) &&
    isRecord(raw.payload) &&
    typeof raw.status === 'string' &&
    (TASK_STATUSES as readonly string[]).includes(raw.status) &&
    Number.isInteger(raw.requiredApprovals) &&
    Number.isInteger(raw.approvalCount) &&
    typeof raw.approvedByMe === 'boolean' &&
    typeof raw.expiresAt === 'string' &&
    (raw.kind === 'custody_transaction' || raw.kind === 'config');
  return ok ? (raw as unknown as CustodyTask) : null;
}
function readDetail(raw: unknown): CustodyTaskDetail | null {
  const task = readTask(raw);
  if (!task || !isRecord(raw) || !Array.isArray(raw.timeline)) return null;
  const rows = raw.timeline.every(
    (e) => isRecord(e) && typeof e.kind === 'string' && typeof e.actor === 'string' && typeof e.at === 'string',
  );
  return rows ? (raw as unknown as CustodyTaskDetail) : null;
}

/** Strict: anything that is not exactly a known answer is "outcome unknown", never a success. */
export function readDecisionReply(raw: unknown): DecisionReply {
  if (isRecord(raw) && raw.ok === false) return { ok: false, refusal: refusalOf(raw) };
  if (isRecord(raw) && raw.ok === true && (raw.action === 'approve' || raw.action === 'reject' || raw.action === 'cancel')) {
    const task = readTask(raw.task);
    if (task) return { ok: true, action: raw.action, task };
  }
  return { ok: false, refusal: UNKNOWN };
}

export function readTaskReply(raw: unknown): TaskReply {
  if (isRecord(raw) && raw.ok === false) return { ok: false, refusal: refusalOf(raw) };
  if (isRecord(raw) && raw.ok === true) {
    const task = readDetail(raw.task);
    if (task) return { ok: true, task };
  }
  return { ok: false, refusal: { ...UNKNOWN, body: 'The task could not be read.', changed: 'no' } };
}

export async function fetchCustodyOps(signal?: AbortSignal): Promise<CustodyOpsRead | null> {
  try {
    const res = await fetch('/api/custody-ops', { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) &&
      typeof body.asOf === 'string' &&
      isRecord(body.pending) &&
      isRecord(body.recent) &&
      isRecord(body.approvers) &&
      isRecord(body.openItems)
      ? (body as unknown as CustodyOpsRead)
      : null;
  } catch {
    return null;
  }
}

export async function fetchTask(taskId: string, signal?: AbortSignal): Promise<TaskReply> {
  try {
    const res = await fetch(`/api/custody-ops?taskId=${encodeURIComponent(taskId)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    return readTaskReply(await res.json().catch(() => null));
  } catch {
    return { ok: false, refusal: { ...UNKNOWN, body: 'The task could not be read.', changed: 'no' } };
  }
}

export async function postDecision(request: {
  readonly action: Decision;
  readonly taskId: string;
  readonly payloadHash: string | null;
  readonly confirm: string;
}): Promise<DecisionReply> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return {
      ok: false,
      refusal: {
        title: 'Nothing was sent',
        body: error instanceof Error ? error.message : 'Your founder session could not be confirmed.',
        next: 'Sign in again, then repeat the step.',
        code: null,
        changed: 'no',
      },
    };
  }
  try {
    const res = await fetch('/api/custody-ops', {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return readDecisionReply(await res.json().catch(() => null));
  } catch {
    return {
      ok: false,
      refusal: {
        title: 'The outcome is not known',
        body: 'The connection ended before the console answered, so it is not known whether this was recorded.',
        next: 'Read the task again before doing anything else. Repeating the same decision is safe.',
        code: null,
        changed: 'unknown',
      },
    };
  }
}
