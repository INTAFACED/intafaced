import { z } from 'zod';

/**
 * Custody approval tasks as svc-pay publishes them under `founderAdmin.custody.*` (W-custody-ops-06): the shapes a console or
 * an approver client reads. Browser-safe: zod only. svc-pay owns the rules (quorum, deadline, who may decide); this file only
 * says what a reader gets back, so a screen never keeps its own copy of the shape.
 */
const stamp = z.string().datetime({ offset: true });

export const CUSTODY_TASK_KINDS = ['custody_transaction', 'config'] as const;
export type CustodyTaskKind = (typeof CUSTODY_TASK_KINDS)[number];

export const CUSTODY_TASK_STATUSES = ['pending', 'approved', 'rejected', 'canceled', 'expired', 'failed', 'executed'] as const;
export type CustodyTaskStatus = (typeof CUSTODY_TASK_STATUSES)[number];

export const CUSTODY_CONFIG_SCOPES = ['address_whitelist', 'connections', 'users', 'policy', 'approval_groups'] as const;
export type CustodyConfigScope = (typeof CUSTODY_CONFIG_SCOPES)[number];

export const CUSTODY_APPROVER_ROLES = ['founder', 'keyless'] as const;
export type CustodyApproverRole = (typeof CUSTODY_APPROVER_ROLES)[number];

/** Approvers name this fingerprint when they approve or reject, so a decision can never ride a different payload. */
export const custodyPayloadHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const custodyTaskViewSchema = z.object({
  id: z.string().guid(),
  clientRef: z.string(),
  kind: z.enum(CUSTODY_TASK_KINDS),
  scope: z.enum(CUSTODY_CONFIG_SCOPES).nullable(),
  title: z.string(),
  payload: z.record(z.string(), z.unknown()),
  payloadHash: custodyPayloadHashSchema,
  initiator: z.string(),
  requiredApprovals: z.number().int(),
  approvalCount: z.number().int(),
  /** Whether the viewer already approved. */
  approvedByMe: z.boolean(),
  status: z.enum(CUSTODY_TASK_STATUSES),
  failureCode: z.string().nullable(),
  expiresAt: stamp,
  createdAt: stamp,
  decidedAt: stamp.nullable(),
  executedAt: stamp.nullable(),
});
export type CustodyTaskView = z.infer<typeof custodyTaskViewSchema>;

export const custodyTimelineEntrySchema = z.object({
  kind: z.string(),
  actor: z.string(),
  detail: z.record(z.string(), z.unknown()),
  at: stamp,
});

export const custodyTaskDetailSchema = custodyTaskViewSchema.extend({ timeline: z.array(custodyTimelineEntrySchema) });
export type CustodyTaskDetailView = z.infer<typeof custodyTaskDetailSchema>;

export const custodyApproverViewSchema = z.object({
  userId: z.string(),
  label: z.string(),
  /** `keyless` approvers decide tasks and hold no signing key. */
  role: z.enum(CUSTODY_APPROVER_ROLES),
  active: z.boolean(),
  setBy: z.string(),
  setAt: stamp,
});
export type CustodyApproverView = z.infer<typeof custodyApproverViewSchema>;
