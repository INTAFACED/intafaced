import { z } from 'zod';

/**
 * Wire shapes for the withdrawal allowlist (W-withdraw-10). Every input object is `.strict()`. Amounts are decimal strings,
 * never numbers. No field has a default: a blank one is a parse error. The upper bounds are input safety, not product values.
 */
const amount = z
  .string()
  .regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places')
  .refine((v) => /[1-9]/.test(v), 'an amount is positive');
const assetId = z.string().min(1).max(32);
const id = z.string().uuid();
const limit = z.number().int().min(1).max(200);
const clientRef = z.string().min(1).max(64);

export const ALLOWLIST_GROUPS = ['internal_wallet', 'external_wallet', 'contract'] as const;
export type AllowlistGroup = (typeof ALLOWLIST_GROUPS)[number];
export const ENTRY_STATES = ['active', 'suspended', 'removed'] as const;
export type EntryState = (typeof ENTRY_STATES)[number];
export const CHANGE_STATUSES = ['waiting', 'approved', 'cancelled', 'rejected', 'failed'] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];
export const CHANGE_OPS = ['add', 'delete', 'mode_off', 'onetime_policy'] as const;
export type ChangeOp = (typeof CHANGE_OPS)[number];

export const proposeAddInputSchema = z
  .object({
    group: z.enum(ALLOWLIST_GROUPS),
    assetId,
    address: z.string().min(1).max(128),
    label: z.string().min(1).max(64),
    clientRef,
  })
  .strict();
export type ProposeAddInput = z.infer<typeof proposeAddInputSchema>;

export const proposeDeleteInputSchema = z.object({ entryId: id, clientRef }).strict();
export type ProposeDeleteInput = z.infer<typeof proposeDeleteInputSchema>;

/** Turning the mode ON tightens and applies at once. Turning it OFF is a governed change and needs a `clientRef`. */
export const setModeInputSchema = z.object({ enabled: z.boolean(), clientRef }).strict();
export type SetModeInput = z.infer<typeof setModeInputSchema>;

export const proposePolicyInputSchema = z
  .object({
    enabled: z.boolean(),
    assetId,
    /** One one-time send of this asset may be up to this amount. */
    maxAmount: amount,
    clientRef,
  })
  .strict();
export type ProposePolicyInput = z.infer<typeof proposePolicyInputSchema>;

/** The approver names the hash of the change they looked at, so an approval can never ride a different change. */
export const decideInputSchema = z.object({ changeId: id, requestHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const cancelInputSchema = z.object({ changeId: id }).strict();
export const getInputSchema = z.object({ changeId: id }).strict();
export const listInputSchema = z.object({ limit: limit.optional(), after: id.optional() }).strict();
export type ListInput = z.infer<typeof listInputSchema>;
export const listForTeamInputSchema = z
  .object({ teamAccountId: id, status: z.enum(CHANGE_STATUSES).optional(), limit: limit.optional(), after: id.optional() })
  .strict();
export type ListForTeamInput = z.infer<typeof listForTeamInputSchema>;

export const setQuorumInputSchema = z
  .object({ userId: id, teamAccountId: id, requiredApprovals: z.number().int().min(1).max(100) })
  .strict();
export type SetQuorumInput = z.infer<typeof setQuorumInputSchema>;
export const userQueryInputSchema = z.object({ userId: id, limit: limit.optional(), after: id.optional() }).strict();
export const suspendInputSchema = z.object({ entryId: id, reason: z.string().min(1).max(200) }).strict();
export const resumeInputSchema = z.object({ entryId: id }).strict();

export const quorumViewSchema = z.object({
  userId: id,
  teamAccountId: id,
  requiredApprovals: z.number().int(),
  setBy: z.string(),
  setAt: z.string().datetime({ offset: true }),
});
export type QuorumView = z.infer<typeof quorumViewSchema>;

export const entryViewSchema = z.object({
  id,
  userId: id,
  group: z.enum(ALLOWLIST_GROUPS),
  assetId: z.string(),
  address: z.string(),
  label: z.string(),
  state: z.enum(ENTRY_STATES),
  createdBy: z.string(),
  suspendedReason: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  lastUsedAt: z.string().datetime({ offset: true }).nullable(),
});
export type EntryView = z.infer<typeof entryViewSchema>;

export const changeViewSchema = z.object({
  id,
  userId: id,
  op: z.enum(CHANGE_OPS),
  entryId: id.nullable(),
  /** What the change would do, in the wording of its op (address, label, group, asset; or the policy). */
  subject: z.record(z.string(), z.unknown()),
  requestHash: z.string(),
  teamAccountId: id,
  requiredApprovals: z.number().int(),
  approvalCount: z.number().int(),
  approvedByMe: z.boolean(),
  status: z.enum(CHANGE_STATUSES),
  failureCode: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  decidedAt: z.string().datetime({ offset: true }).nullable(),
});
export type ChangeView = z.infer<typeof changeViewSchema>;

export const modeViewSchema = z.object({
  userId: id,
  /** Allowlist-only mode: with it on, a crypto withdrawal to an unlisted address refuses. Off until the owner turns it on. */
  enabled: z.boolean(),
  setAt: z.string().datetime({ offset: true }).nullable(),
});
export type ModeView = z.infer<typeof modeViewSchema>;

export const policyViewSchema = z.object({
  userId: id,
  /** One-time sends to an unlisted address while the mode is on. Off until a governed change turns it on. */
  enabled: z.boolean(),
  assetId: z.string().nullable(),
  maxAmount: z.string().nullable(),
  setAt: z.string().datetime({ offset: true }).nullable(),
});
export type PolicyView = z.infer<typeof policyViewSchema>;

export const setModeResultSchema = z.object({ mode: modeViewSchema, change: changeViewSchema.nullable() });
export type SetModeResult = z.infer<typeof setModeResultSchema>;
