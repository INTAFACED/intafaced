import { z } from 'zod';

/**
 * Wire shapes for custody approval tasks (W-custody-ops-06). Every input object is `.strict()`. No field has a default: a
 * blank one is a parse error. The upper bounds are input safety, not product values.
 */
const id = z.string().guid();
const limit = z.number().int().min(1).max(200);
const clientRef = z.string().min(1).max(64);
const title = z.string().min(1).max(200);
const stamp = z.string().datetime({ offset: true });
const hash = z.string().regex(/^[0-9a-f]{64}$/);

export const TASK_KINDS = ['custody_transaction', 'config'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_STATUSES = ['pending', 'approved', 'rejected', 'canceled', 'expired', 'failed', 'executed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const CONFIG_SCOPES = ['address_whitelist', 'connections', 'users', 'policy', 'approval_groups'] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];
export const APPROVER_ROLES = ['founder', 'keyless'] as const;
export type ApproverRole = (typeof APPROVER_ROLES)[number];

const payload = z.record(z.string(), z.unknown());

export const initiateInputSchema = z.object({ title, payload, clientRef }).strict();
export type InitiateInput = z.infer<typeof initiateInputSchema>;
export const configProposeInputSchema = z.object({ scope: z.enum(CONFIG_SCOPES), title, payload, clientRef }).strict();
export type ConfigProposeInput = z.infer<typeof configProposeInputSchema>;

/** The approver names the hash they read, so an approval can never ride a different payload. */
export const decideInputSchema = z.object({ taskId: id, payloadHash: hash }).strict();
export const taskIdInputSchema = z.object({ taskId: id }).strict();
/** `limit` is optional here so an omitted bound reaches `custody_approval.list_limit_unset` and not a parse error. */
export const listInputSchema = z
  .object({ status: z.enum(TASK_STATUSES).optional(), kind: z.enum(TASK_KINDS).optional(), limit: limit.optional(), after: id.optional() })
  .strict();
export type ListInput = z.infer<typeof listInputSchema>;
export const pendingInputSchema = z.object({ limit: limit.optional(), after: id.optional() }).strict();
export type PendingInput = z.infer<typeof pendingInputSchema>;

export const setQuorumInputSchema = z
  .object({
    kind: z.enum(TASK_KINDS),
    /** N of M: how many distinct registered approvers must approve. */
    requiredApprovals: z.number().int().min(1).max(100),
    /** How long a task waits for its approvals before it expires. */
    expirySeconds: z.number().int().min(1).max(31_536_000),
  })
  .strict();
export type SetQuorumInput = z.infer<typeof setQuorumInputSchema>;
export const quorumQueryInputSchema = z.object({ kind: z.enum(TASK_KINDS) }).strict();
export const registerApproverInputSchema = z
  .object({ userId: z.string().min(1).max(128), label: z.string().min(1).max(64), role: z.enum(APPROVER_ROLES) })
  .strict();
export type RegisterApproverInput = z.infer<typeof registerApproverInputSchema>;
export const revokeApproverInputSchema = z.object({ userId: z.string().min(1).max(128) }).strict();

export const quorumViewSchema = z.object({
  kind: z.enum(TASK_KINDS),
  requiredApprovals: z.number().int(),
  expirySeconds: z.number().int(),
  setBy: z.string(),
  setAt: stamp,
});
export type QuorumView = z.infer<typeof quorumViewSchema>;

export const approverViewSchema = z.object({
  userId: z.string(),
  label: z.string(),
  /** `keyless` approvers decide tasks and hold no signing key: nothing here ever gives them one. */
  role: z.enum(APPROVER_ROLES),
  active: z.boolean(),
  setBy: z.string(),
  setAt: stamp,
});
export type ApproverView = z.infer<typeof approverViewSchema>;

export const timelineEntrySchema = z.object({ kind: z.string(), actor: z.string(), detail: z.record(z.string(), z.unknown()), at: stamp });
export const taskViewSchema = z.object({
  id,
  clientRef: z.string(),
  kind: z.enum(TASK_KINDS),
  scope: z.enum(CONFIG_SCOPES).nullable(),
  title: z.string(),
  payload,
  payloadHash: hash,
  initiator: z.string(),
  requiredApprovals: z.number().int(),
  approvalCount: z.number().int(),
  /** Whether the viewer already approved. */
  approvedByMe: z.boolean(),
  status: z.enum(TASK_STATUSES),
  failureCode: z.string().nullable(),
  expiresAt: stamp,
  createdAt: stamp,
  decidedAt: stamp.nullable(),
  executedAt: stamp.nullable(),
});
export type TaskView = z.infer<typeof taskViewSchema>;
export const taskDetailSchema = taskViewSchema.extend({ timeline: z.array(timelineEntrySchema) });
export type TaskDetail = z.infer<typeof taskDetailSchema>;

export const settleResultSchema = z.object({
  expired: z.number().int(),
  executed: z.number().int(),
  failures: z.array(z.object({ taskId: id, code: z.string() })),
});
export type SettleResult = z.infer<typeof settleResultSchema>;
