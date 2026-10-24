import { z } from 'zod';

/**
 * Wire shapes for withdrawal multi-approval (W-withdraw-11). Every input object is `.strict()`. Amounts are decimal strings,
 * never numbers. The policy has no defaulted field: a blank one is a parse error. The upper bounds are input safety, not
 * product values.
 */
const amount = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');
const assetId = z.string().min(1).max(32);
const id = z.string().guid();
const limit = z.number().int().min(1).max(200);

export const APPROVAL_STATUSES = ['pending', 'approved', 'executed', 'rejected', 'expired', 'canceled', 'failed'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const proposeInputSchema = z
  .object({
    assetId,
    amount,
    railId: z.string().min(1),
    destination: z.object({ kind: z.string().min(1), ref: z.string().min(1) }).strict(),
    clientRef: z.string().min(1).max(64),
  })
  .strict();
export type ProposeInput = z.infer<typeof proposeInputSchema>;

export const decideInputSchema = z.object({ requestId: id }).strict();
export const getInputSchema = z.object({ requestId: id }).strict();
/** `limit` is optional here so an omitted bound reaches `withdrawal_approval.list_limit_unset` and not a parse error. */
export const listInputSchema = z.object({ limit: limit.optional(), after: id.optional() }).strict();
export type ListInput = z.infer<typeof listInputSchema>;
export const listForTeamInputSchema = z
  .object({
    teamAccountId: id,
    status: z.enum(APPROVAL_STATUSES).optional(),
    limit: limit.optional(),
    after: id.optional(),
  })
  .strict();
export type ListForTeamInput = z.infer<typeof listForTeamInputSchema>;

export const setPolicyInputSchema = z
  .object({
    userId: id,
    assetId,
    /** False clears the policy for this user and asset: withdrawals are direct again. */
    active: z.boolean(),
    /** The business team account whose approvers may decide. */
    teamAccountId: id,
    /** N of M: how many distinct approvers must approve. */
    requiredApprovals: z.number().int().min(1).max(100),
    /** Approval is needed when this withdrawal plus the same user's withdrawals in the window reach this amount. */
    threshold: amount.refine((v) => /[1-9]/.test(v), 'a threshold is positive'),
    windowSeconds: z.number().int().min(1).max(31_536_000),
    /** How long a request waits for its approvals before it expires. */
    expirySeconds: z.number().int().min(1).max(31_536_000),
    /** True holds the amount when the request is submitted; false holds nothing until the last approval. */
    holdAtSubmit: z.boolean(),
  })
  .strict();
export type SetPolicyInput = z.infer<typeof setPolicyInputSchema>;
export const policyQueryInputSchema = z.object({ userId: id, assetId }).strict();

export const policyViewSchema = z.object({
  userId: id,
  assetId: z.string(),
  active: z.boolean(),
  teamAccountId: id,
  requiredApprovals: z.number().int(),
  threshold: z.string(),
  windowSeconds: z.number().int(),
  expirySeconds: z.number().int(),
  holdAtSubmit: z.boolean(),
  setBy: z.string(),
  setAt: z.string().datetime({ offset: true }),
});
export type PolicyView = z.infer<typeof policyViewSchema>;

export const requestViewSchema = z.object({
  id,
  userId: id,
  assetId: z.string(),
  amount: z.string(),
  rail: z.string(),
  destination: z.object({ kind: z.string(), ref: z.string() }),
  clientRef: z.string(),
  teamAccountId: id,
  requiredApprovals: z.number().int(),
  approvalCount: z.number().int(),
  /** Whether the viewer already approved. A viewer who is not the initiator never sees who else did. */
  approvedByMe: z.boolean(),
  holdAtSubmit: z.boolean(),
  status: z.enum(APPROVAL_STATUSES),
  failureCode: z.string().nullable(),
  expiresAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  decidedAt: z.string().datetime({ offset: true }).nullable(),
});
export type RequestView = z.infer<typeof requestViewSchema>;

export const settleResultSchema = z.object({
  expired: z.number().int(),
  released: z.number().int(),
  resumed: z.number().int(),
  failures: z.array(z.object({ requestId: id, code: z.string() })),
});
export type SettleResult = z.infer<typeof settleResultSchema>;
