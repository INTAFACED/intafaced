import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';

/**
 * svc-bank's card programme desk (`ops.cardProgramme*`, J-bank-26): what the service answers, in one place, so the admin
 * console reads it from the same file the service's shape is named in.
 *
 * These are answer schemas: the fields a reader uses (unknown fields ignored, so a new field on the service does not break
 * a console deployed before it). Every amount is a decimal string as svc-bank sends it; a count is a safe, non-negative
 * integer. A figure the partner has not reported is null, never 0.
 */

const count = z.number().int().nonnegative().safe();
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, 'decimal string');
const when = z.string();

export const bankCardProgrammeSettingSchema = z.object({
  value: z.record(z.string(), z.unknown()),
  version: count,
  updatedBy: z.string(),
  updatedAt: when,
});
export type BankCardProgrammeSetting = z.infer<typeof bankCardProgrammeSettingSchema>;

export const bankCardProgrammeSettingKeys = ['programme', 'product', 'bin', 'fees', 'threeds'] as const;
export type BankCardProgrammeSettingKey = (typeof bankCardProgrammeSettingKeys)[number];
const setting = bankCardProgrammeSettingSchema.nullable();
export const bankCardProgrammeSettingsSchema = z.object({
  programme: setting,
  product: setting,
  bin: setting,
  fees: setting,
  threeds: setting,
});

export const bankCardProgrammeChecklistItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  done: z.boolean(),
  blocker: z.string().nullable(),
});

export const bankCardProgrammeRuleSchema = z.object({
  id: z.string(),
  ruleKey: z.string(),
  version: count,
  name: z.string(),
  words: z.string(),
  state: z.enum(['shadow', 'active', 'retired']),
  shadow: z.object({ evaluated: count, wouldDecline: count, at: when }),
  promotedAt: when.nullable(),
  retiredAt: when.nullable(),
});

export const bankCardProgrammeStaffSchema = z.object({
  userId: z.string(),
  email: z.string(),
  role: z.enum(['manager', 'viewer']),
  assignedAt: when,
});

export const bankCardProgrammeAuditEntrySchema = z.object({
  id: z.string(),
  actor: z.string(),
  action: z.string(),
  target: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  at: when,
});

export const bankCardProgrammeCardRefSchema = z.object({
  id: z.string(),
  panTail: z.string(),
  status: z.string(),
  assetId: assetIdSchema,
  test: z.boolean(),
});

export const bankCardholderSchema = z.object({
  id: z.string(),
  kind: z.enum(['individual', 'business']),
  name: z.string(),
  email: z.string().nullable(),
  country: z.string(),
  beneficialOwners: z.array(z.object({ name: z.string(), email: z.string() })),
  status: z.enum(['verified', 'review']),
  gap: z.string().nullable(),
  gapCode: z.string().nullable(),
  screening: z.enum(['clear', 'listed']),
  screenedAt: when,
  test: z.boolean(),
  createdAt: when,
  cards: z.array(bankCardProgrammeCardRefSchema).optional(),
});
export type BankCardholder = z.infer<typeof bankCardholderSchema>;
export const bankCardholdersSchema = z.array(bankCardholderSchema);

export const bankCardDecisionSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  panTail: z.string(),
  assetId: assetIdSchema,
  amount: decimal,
  channel: z.string(),
  merchantCategory: z.string().nullable(),
  decision: z.enum(['approved', 'declined']),
  declineCode: z.string().nullable(),
  status: z.string(),
  decidedAt: when,
  test: z.boolean(),
});

export const bankCardProgrammeReportSchema = z.object({
  day: z.string(),
  asOf: when,
  test: z.boolean(),
  assets: z.array(z.object({ assetId: assetIdSchema, approved: count, approvedVolume: decimal, declined: count })),
  totals: z.object({ approved: count, declined: count }),
});

export const bankCardProgrammeDeskSchema = z.object({
  test: z.boolean(),
  programme: z.object({ id: z.string(), displayName: z.string(), simulated: z.boolean() }),
  settings: bankCardProgrammeSettingsSchema,
  checklist: z.array(bankCardProgrammeChecklistItemSchema),
  rules: z.array(bankCardProgrammeRuleSchema),
  staff: z.array(bankCardProgrammeStaffSchema),
  audit: z.array(bankCardProgrammeAuditEntrySchema),
  reviewQueue: z.array(bankCardholderSchema),
  cardholders: z.array(bankCardholderSchema),
  decisionLog: z.array(bankCardDecisionSchema),
  report: bankCardProgrammeReportSchema,
  exemptions: count,
  simulator: z.boolean(),
  screeningListSet: z.boolean(),
});
export type BankCardProgrammeDesk = z.infer<typeof bankCardProgrammeDeskSchema>;

export const bankCardTraceStepSchema = z.object({ check: z.string(), result: z.enum(['pass', 'decline', 'skip']), detail: z.string() });
export type BankCardTraceStep = z.infer<typeof bankCardTraceStepSchema>;

export const bankCardAuthorizationDetailSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  authorizationRef: z.string(),
  panTail: z.string(),
  assetId: assetIdSchema,
  amount: decimal,
  channel: z.string(),
  merchantCategory: z.string().nullable(),
  decision: z.enum(['approved', 'declined']),
  declineCode: z.string().nullable(),
  heldBy: z.string(),
  partnerHoldRef: z.string().nullable(),
  test: z.boolean(),
  lifecycle: z.array(z.object({ event: z.string(), amount: decimal, at: when, detail: z.string().nullable() })),
  variance: z
    .object({ authorised: decimal, captured: decimal, returned: decimal, stillHeld: decimal, captureVariance: decimal })
    .nullable(),
  trace: z.array(bankCardTraceStepSchema).nullable(),
});
export type BankCardAuthorizationDetail = z.infer<typeof bankCardAuthorizationDetailSchema>;

/** One asset's card funds for a cardholder: held plus captured in the app beside the partner's own figure (null: not known). */
export const bankCardholderFundsSchema = z.object({
  assetId: assetIdSchema,
  appHeld: decimal,
  appCaptured: decimal,
  appFigure: decimal,
  partnerHeld: decimal.nullable(),
  partnerCaptured: decimal.nullable(),
  partnerFigure: decimal.nullable(),
  difference: decimal.nullable(),
  status: z.enum(['matches', 'break', 'not_known']),
  test: z.boolean(),
});
export type BankCardholderFunds = z.infer<typeof bankCardholderFundsSchema>;

export const bankCardholderDetailSchema = bankCardholderSchema.extend({
  cards: z.array(bankCardProgrammeCardRefSchema),
  funds: z.array(bankCardholderFundsSchema),
});
export type BankCardholderDetail = z.infer<typeof bankCardholderDetailSchema>;

/** The programme's own figures from the funding read (`ops.cardProgrammeFunding`), as the partner reports them. */
const knownOrNot = z.union([decimal, z.literal('not known')]);
export const bankCardProgrammeFiguresSchema = z.object({
  test: z.boolean(),
  rows: z.array(
    z.object({
      assetId: assetIdSchema,
      // svc-bank sends an unknown as the words "not known" (ops.cardProgrammeFunding), never 0 or a blank.
      partnerFigure: knownOrNot,
      partnerState: z.enum(['known', 'stale', 'unknown']),
      partnerAsOf: z.string(),
    }),
  ),
});
export type BankCardProgrammeFigures = z.infer<typeof bankCardProgrammeFiguresSchema>;
