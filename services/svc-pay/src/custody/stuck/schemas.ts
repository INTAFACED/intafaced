import { z } from 'zod';

/**
 * Wire shapes for `founderAdmin.custody.queue.*` and `.stuck.*` (W-custody-ops-12). Every input object is `.strict()`.
 * A fee ceiling is a decimal string with its unit, never a number. A threshold is never defaulted: blank refuses.
 */
const id = z.string().guid();
const walletId = id;
const networkId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const reason = z.string().trim().min(1).max(500);
const txHash = z.string().trim().min(1).max(200);
const nonce = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const decimal = z
  .string()
  .regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places')
  .refine((v) => /[1-9]/.test(v), 'must be above zero');

export const STUCK_KINDS = ['boost', 'replace', 'drop'] as const;
export type StuckKind = (typeof STUCK_KINDS)[number];

export const linkInputSchema = z.object({ withdrawalId: id, walletId, nonce: nonce.optional() }).strict();
export const linkViewSchema = z.object({
  withdrawalId: id,
  walletId: id,
  nonce: z.number().int().nullable(),
  linkedBy: z.string(),
  at: z.string().datetime({ offset: true }),
});

export const thresholdSetInputSchema = z.object({ networkId, seconds: z.number().int().min(1).max(31_536_000), reason }).strict();
export const thresholdKeyInputSchema = z.object({ networkId }).strict();
export const thresholdViewSchema = z.object({
  networkId: z.string(),
  /** Null while the owner has set none: diagnosis then refuses and a transaction is never called stuck. */
  seconds: z.number().int().nullable(),
  setBy: z.string().nullable(),
  setAt: z.string().datetime({ offset: true }).nullable(),
});

export const queueInputSchema = z.object({ walletId }).strict();
export const queueItemSchema = z.object({
  withdrawalId: id,
  nonce: z.number().int().nullable(),
  ageSeconds: z.number().int(),
  /** Null while no threshold is set for the network. */
  stuck: z.boolean().nullable(),
  /** True for the lowest known nonce while others wait behind it. */
  headOfLine: z.boolean(),
});
export const queueViewSchema = z.object({
  walletId: id,
  networkId: z.string(),
  thresholdSeconds: z.number().int().nullable(),
  items: z.array(queueItemSchema),
});
export const diagnosisSchema = z.object({
  walletId: id,
  networkId: z.string(),
  thresholdSeconds: z.number().int(),
  inFlight: z.number().int(),
  stuckCount: z.number().int(),
  findings: z.array(
    z.object({
      code: z.enum(['head_of_line_stuck', 'stuck', 'nonce_unknown']),
      withdrawalId: id,
      detail: z.string(),
    }),
  ),
});

export const actionInputSchema = z
  .object({
    kind: z.enum(STUCK_KINDS),
    /** Your own business key for this action. The same key is the same action; it never reaches the chain twice. */
    actionKey: z.string().regex(/^[A-Za-z0-9:_.-]{1,128}$/, 'the action key is your own business key'),
    withdrawalId: id,
    originalTxHash: txHash,
    nonce,
    maxFee: decimal.optional(),
    maxFeeUnit: z.string().trim().min(1).max(32).optional(),
    reason,
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.maxFee === undefined) !== (v.maxFeeUnit === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['maxFeeUnit'], message: 'a fee ceiling and its unit go together' });
    }
  });
export type ActionInput = z.infer<typeof actionInputSchema>;

export const ACTION_STATUSES = ['intent', 'submitted', 'failed', 'replaced', 'dropped', 'original_mined'] as const;
export const actionViewSchema = z.object({
  id,
  actionKey: z.string(),
  kind: z.enum(STUCK_KINDS),
  withdrawalId: id,
  /** The withdrawal's attempt number when the action was taken. */
  attempt: z.number().int(),
  originalTxHash: z.string(),
  nonce: z.number().int(),
  maxFee: z.string().nullable(),
  maxFeeUnit: z.string().nullable(),
  reason: z.string(),
  requestedBy: z.string(),
  at: z.string().datetime({ offset: true }),
  /** `intent`: written, no answer yet; the same key resumes it. */
  status: z.enum(ACTION_STATUSES),
  submittedTxHash: z.string().nullable(),
  failureCode: z.string().nullable(),
});
export type ActionView = z.infer<typeof actionViewSchema>;

export const actionIdInputSchema = z.object({ actionId: id }).strict();
export const actionListInputSchema = z.object({ withdrawalId: id }).strict();
export const cancelInputSchema = z.object({ withdrawalId: id }).strict();

export const reverseRequestInputSchema = z
  .object({ withdrawalId: id, actionId: id, evidenceTxHash: txHash, evidenceNonce: nonce, reason })
  .strict();
export const reverseIdInputSchema = z.object({ requestId: id }).strict();
export const reverseViewSchema = z.object({
  id,
  withdrawalId: id,
  actionId: id,
  /** The withdrawal attempt the evidence is about; the ledger reverse refuses any other. */
  attempt: z.number().int(),
  evidenceTxHash: z.string(),
  evidenceNonce: z.number().int(),
  reason: z.string(),
  requestedBy: z.string(),
  at: z.string().datetime({ offset: true }),
  approvers: z.array(z.string()),
  /** Approved by someone other than the requester. */
  approved: z.boolean(),
  executed: z.boolean(),
});
export type ReverseView = z.infer<typeof reverseViewSchema>;
