// hand-declared-ok: svc-pay's `requestViewSchema` lives in the service, not in a browser-safe @intafaced/contracts export yet; moving it there is a contracts follow-up.
import { z } from 'zod';
import { authoredRefusal, type ApiClient, type ApiResult } from '../../shared/api';
import { decimalSchema } from '../../shared/money';
import { approvalCopy } from './withdrawal-approval-copy';

// Published svc-pay `withdrawalApproval.*` requestView. A request is the ask and its tally, not a balance and not proof that
// money was sent: only the withdrawal record says what happened to the funds.
export const APPROVAL_STATUSES = ['pending', 'approved', 'executed', 'rejected', 'expired', 'canceled', 'failed'] as const;
export const approvalRequestSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  assetId: z.string().min(1).max(32),
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,18})?$/)
    .pipe(decimalSchema),
  rail: z.string(),
  destination: z.object({ kind: z.string(), ref: z.string() }),
  clientRef: z.string(),
  teamAccountId: z.string().uuid(),
  requiredApprovals: z.number().int().min(1),
  approvalCount: z.number().int().min(0),
  approvedByMe: z.boolean(),
  holdAtSubmit: z.boolean(),
  status: z.enum(APPROVAL_STATUSES),
  failureCode: z.string().nullable(),
  expiresAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  decidedAt: z.string().datetime({ offset: true }).nullable(),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

const requestIdSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const limitSchema = z.number().int().min(1).max(200);

/** `?requestId=` on the approvals room: none means the list, one valid id means the detail, anything else is invalid. */
export function requestedApproval(search: string): { ok: true; id: string | null } | { ok: false } {
  const values = new URLSearchParams(search).getAll('requestId');
  if (!values.length) return { ok: true, id: null };
  if (values.length !== 1) return { ok: false };
  const parsed = requestIdSchema.safeParse(values[0]);
  return parsed.success ? { ok: true, id: parsed.data } : { ok: false };
}

type FailureKey = 'invalidId' | 'invalidWindow' | 'signedOut';
function refuse(code: string, key: FailureKey) {
  return { ok: false as const, reason: 'invalid_response' as const, code, message: approvalCopy.t(key) };
}

export function createApprovalReads(api: ApiClient, userId: string | null, current: () => boolean) {
  function admission(signal?: AbortSignal) {
    if (!current() || signal?.aborted) return authoredRefusal('aborted', { key: 'accountChanged' });
    return !userId ? { ...refuse('withdrawal_approval.session_required', 'signedOut'), reason: 'unauthorized' as const } : null;
  }
  return {
    async mine(limit: number, signal?: AbortSignal): Promise<ApiResult<ApprovalRequest[]>> {
      const denied = admission(signal);
      if (denied) return denied;
      if (!limitSchema.safeParse(limit).success) return refuse('withdrawal_approval.window_invalid', 'invalidWindow');
      const result = await api.query('pay', 'withdrawalApproval.list', { limit }, z.array(approvalRequestSchema), { signal });
      const departed = admission(signal);
      if (departed) return departed;
      if (!result.ok) return result;
      // The list is the caller's own requests: one that names another initiator is not shown.
      if (result.data.some((request) => request.userId !== userId) || result.data.length > limit)
        return refuse('withdrawal_approval.window_invalid', 'invalidWindow');
      return result;
    },
    async get(requestId: string, signal?: AbortSignal): Promise<ApiResult<ApprovalRequest>> {
      const denied = admission(signal);
      if (denied) return denied;
      const parsed = requestIdSchema.safeParse(requestId);
      if (!parsed.success) return refuse('withdrawal_approval.input_invalid', 'invalidId');
      const result = await api.query('pay', 'withdrawalApproval.get', { requestId: parsed.data }, approvalRequestSchema, { signal });
      const departed = admission(signal);
      if (departed) return departed;
      if (!result.ok) return result;
      if (result.data.id.toLowerCase() !== parsed.data) return refuse('withdrawal_approval.input_invalid', 'invalidId');
      return result;
    },
    /** Cancel the caller's own pending request (`trade:write`, no step-up). Returns the request as the service now records it. */
    async cancel(requestId: string): Promise<ApiResult<ApprovalRequest>> {
      const denied = admission();
      if (denied) return denied;
      const parsed = requestIdSchema.safeParse(requestId);
      if (!parsed.success) return refuse('withdrawal_approval.input_invalid', 'invalidId');
      return api.mutate('pay', 'withdrawalApproval.cancel', { requestId: parsed.data }, approvalRequestSchema);
    },
  };
}
