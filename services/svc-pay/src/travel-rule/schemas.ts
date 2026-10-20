import { z } from 'zod';

/**
 * Wire shapes for the outbound travel rule (W-compliance-notices-04). Every input object is `.strict()`. Amounts are
 * decimal strings, never numbers. An unset rule or wait limit is the absence of a row, never a parse default.
 */
const amount = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');
const assetId = z.string().regex(/^[A-Za-z0-9._-]{1,32}$/);
const networkId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const region = z.string().regex(/^(\*|[A-Z]{2}(-[A-Z0-9]{1,3})?)$/, 'a region is an uppercase ISO code such as DE, or * for the fallback');
const reason = z.string().trim().min(1).max(500);
const text = z.string().trim().min(1).max(500);

export const ENTITIES = ['individual', 'business'] as const;
export type Entity = (typeof ENTITIES)[number];

/** The IVMS101-shaped fields an owner can require. */
export const TRAVEL_RULE_FIELDS = [
  'originator_name',
  'originator_address',
  'originator_date_of_birth',
  'originator_national_identifier',
  'beneficiary_name',
  'beneficiary_address',
  'beneficiary_account',
  'beneficiary_institution',
  'beneficiary_wallet_type',
  'transfer_purpose',
  'self_or_third_party',
] as const;
export type TravelRuleField = (typeof TRAVEL_RULE_FIELDS)[number];
const field = z.enum(TRAVEL_RULE_FIELDS);

export const TRANSFER_STATUSES = [
  'started',
  'pending',
  'review',
  'repair',
  'accepted',
  'completed',
  'rejected',
  'not_required',
  'provider_unavailable',
  'blocking_time_expired',
  'canceled',
  'failed',
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const DISPLAY_STATUSES = ['Completed', 'Pending', 'Rejected', 'Failed', 'Blocking time expired', 'Canceled', 'Bypassed'] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

// ── owner rules and wait limits ───────────────────────────────────────────────

export const setRuleInputSchema = z
  .object({
    region,
    entity: z.enum(ENTITIES),
    assetId,
    applies: z.boolean(),
    /** At or above this amount of the asset the rule applies. Required with `applies`, absent without it. */
    threshold: amount.optional(),
    fields: z.array(field).max(TRAVEL_RULE_FIELDS.length),
    reason,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.applies && v.threshold === undefined)
      ctx.addIssue({ code: 'custom', path: ['threshold'], message: 'a rule that applies needs a threshold' });
    if (!v.applies && v.threshold !== undefined)
      ctx.addIssue({ code: 'custom', path: ['threshold'], message: 'a rule that does not apply has no threshold' });
    if (v.applies && v.fields.length === 0)
      ctx.addIssue({ code: 'custom', path: ['fields'], message: 'a rule that applies needs at least one field' });
    if (new Set(v.fields).size !== v.fields.length) ctx.addIssue({ code: 'custom', path: ['fields'], message: 'fields are listed once' });
  });
export type SetRuleInput = z.infer<typeof setRuleInputSchema>;

export const ruleViewSchema = z.object({
  version: z.number().int(),
  region: z.string(),
  entity: z.enum(ENTITIES),
  assetId: z.string(),
  applies: z.boolean(),
  threshold: z.string().nullable(),
  fields: z.array(field),
  reason: z.string(),
  setBy: z.string(),
  setAt: z.string().datetime({ offset: true }),
});
export type RuleView = z.infer<typeof ruleViewSchema>;

export const setWaitLimitsInputSchema = z
  .object({ pendingSeconds: z.number().int().min(1).max(31_536_000), repairSeconds: z.number().int().min(1).max(31_536_000) })
  .strict();
export type SetWaitLimitsInput = z.infer<typeof setWaitLimitsInputSchema>;

export const waitLimitsViewSchema = z.object({
  /** Null while the owner has set none; a required transfer then cannot be opened. */
  pendingSeconds: z.number().int().nullable(),
  repairSeconds: z.number().int().nullable(),
  setBy: z.string().nullable(),
  setAt: z.string().datetime({ offset: true }).nullable(),
});
export type WaitLimitsView = z.infer<typeof waitLimitsViewSchema>;

// ── assessment ────────────────────────────────────────────────────────────────

export const assessInputSchema = z
  .object({ region, entity: z.enum(ENTITIES), assetId, amount, collected: z.array(field).optional() })
  .strict()
  .refine((v) => v.region !== '*', { path: ['region'], message: 'a transfer has a real region' });
export type AssessInput = z.infer<typeof assessInputSchema>;

export const assessmentViewSchema = z.object({
  result: z.enum(['required', 'not_required', 'need_more_info']),
  ruleVersion: z.number().int(),
  fields: z.array(field),
  /** The required fields not in `collected`. Empty when the rule does not apply. */
  missing: z.array(field),
});
export type AssessmentView = z.infer<typeof assessmentViewSchema>;

// ── transfers ─────────────────────────────────────────────────────────────────

export const openInputSchema = z
  .object({
    withdrawalId: z.string().uuid(),
    userId: z.string().min(1).max(64),
    networkId,
    region: region.refine((r) => r !== '*', 'a transfer has a real region'),
    entity: z.enum(ENTITIES),
  })
  .strict();
export type OpenInput = z.infer<typeof openInputSchema>;

/** The IVMS101-shaped message body. The amount, asset and network are taken from the transfer, not from the client. */
const personText = text;
export const messageInputSchema = z
  .object({
    transferId: z.string().uuid(),
    originator: z
      .object({
        name: personText.optional(),
        address: personText.optional(),
        dateOfBirth: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        nationalIdentifier: personText.optional(),
      })
      .strict(),
    beneficiary: z
      .object({
        name: personText.optional(),
        address: personText.optional(),
        account: personText.optional(),
        institution: personText.optional(),
        walletType: z.enum(['custodial', 'self_hosted']).optional(),
      })
      .strict(),
    transfer: z.object({ purpose: personText.optional(), selfOrThirdParty: z.enum(['self', 'third_party']).optional() }).strict(),
  })
  .strict();
export type MessageInput = z.infer<typeof messageInputSchema>;

export const messageResultSchema = z.object({
  transferId: z.string().uuid(),
  messageVersion: z.number().int(),
  missing: z.array(field),
  status: z.enum(TRANSFER_STATUSES),
});
export type MessageResult = z.infer<typeof messageResultSchema>;

export const transitionViewSchema = z.object({
  fromStatus: z.enum(TRANSFER_STATUSES).nullable(),
  toStatus: z.enum(TRANSFER_STATUSES),
  source: z.enum(['system', 'counterparty', 'operator']),
  actor: z.string(),
  reason: z.string().nullable(),
  waitDeadline: z.string().datetime({ offset: true }).nullable(),
  at: z.string().datetime({ offset: true }),
});

export const transferViewSchema = z.object({
  id: z.string().uuid(),
  withdrawalId: z.string().uuid(),
  userId: z.string(),
  assetId: z.string(),
  networkId: z.string(),
  amount: z.string(),
  region: z.string(),
  entity: z.enum(ENTITIES),
  assessment: z.enum(['required', 'not_required']),
  ruleVersion: z.number().int(),
  requiredFields: z.array(field),
  status: z.enum(TRANSFER_STATUSES),
  displayStatus: z.enum(DISPLAY_STATUSES),
  waitDeadline: z.string().datetime({ offset: true }).nullable(),
  /** `vendor.travelrule` while the counterparty network is not connected, else null. */
  blocker: z.literal('vendor.travelrule').nullable(),
  openedAt: z.string().datetime({ offset: true }),
});
export type TransferView = z.infer<typeof transferViewSchema>;

export const transferDetailSchema = transferViewSchema.extend({
  transitions: z.array(transitionViewSchema),
  messageVersions: z.number().int(),
  missingFields: z.array(field),
});
export type TransferDetail = z.infer<typeof transferDetailSchema>;

export const markInputSchema = z.object({ transferId: z.string().uuid(), to: z.enum(TRANSFER_STATUSES), reason }).strict();
export type MarkInput = z.infer<typeof markInputSchema>;

export const listInputSchema = z
  .object({
    status: z.enum(TRANSFER_STATUSES).optional(),
    withdrawalId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(200),
  })
  .strict();
export type ListInput = z.infer<typeof listInputSchema>;

export const transferIdInputSchema = z.object({ transferId: z.string().uuid() }).strict();
export const expireResultSchema = z.object({ expired: z.array(z.string().uuid()) });

/** What the customer sees on their own withdrawal. No operator notes and no rule internals beyond what to supply. */
export const customerStatusSchema = z.object({
  withdrawalId: z.string().uuid(),
  status: z.enum(TRANSFER_STATUSES),
  displayStatus: z.enum(DISPLAY_STATUSES),
  /** The fields the customer still has to give, while the transfer waits for them. */
  fieldsToCollect: z.array(field),
  waitDeadline: z.string().datetime({ offset: true }).nullable(),
  blocker: z.literal('vendor.travelrule').nullable(),
});
export type CustomerStatus = z.infer<typeof customerStatusSchema>;
