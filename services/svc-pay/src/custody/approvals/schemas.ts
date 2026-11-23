import { z } from 'zod';
import {
  id,
  pendingInputSchema,
  TASK_KINDS,
  CONFIG_SCOPES,
  payload,
  TASK_STATUSES,
  stamp,
  taskViewSchema,
  listInputSchema,
  APPROVER_ROLES,
  approverViewSchema,
  taskDetailSchema,
  decideInputSchema,
} from '@intafaced/contracts/pay-founder-admin-procedures';

const clientRef = z.string().min(1).max(64);
const title = z.string().min(1).max(200);

export type TaskKind = (typeof TASK_KINDS)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type ConfigScope = (typeof CONFIG_SCOPES)[number];
export type ApproverRole = (typeof APPROVER_ROLES)[number];

export const initiateInputSchema = z.object({ title, payload, clientRef }).strict();
export type InitiateInput = z.infer<typeof initiateInputSchema>;
export const configProposeInputSchema = z.object({ scope: z.enum(CONFIG_SCOPES), title, payload, clientRef }).strict();
export type ConfigProposeInput = z.infer<typeof configProposeInputSchema>;

export type ListInput = z.infer<typeof listInputSchema>;
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

export type ApproverView = z.infer<typeof approverViewSchema>;

export type TaskView = z.infer<typeof taskViewSchema>;
export type TaskDetail = z.infer<typeof taskDetailSchema>;

export const settleResultSchema = z.object({
  expired: z.number().int(),
  executed: z.number().int(),
  failures: z.array(z.object({ taskId: id, code: z.string() })),
});
export type SettleResult = z.infer<typeof settleResultSchema>;
export { taskViewSchema, approverViewSchema };
export { decideInputSchema };
