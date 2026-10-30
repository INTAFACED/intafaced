import { z } from 'zod';
import { kycReasonCodeSchema } from './identity-kyc-cases.js';

/**
 * svc-identity `accountAppeal` (I-account-lifecycle-12, J-identity-14 #3 and #4): the person appeals a restriction
 * staff set, and compliance decides it.
 *
 * - One open appeal (`submitted` or `in_review`) per restriction at a time; a second refuses `identity.appeal_open`.
 * - An appeal is allowed only inside the owner's window after the restriction started (`IDENTITY_APPEAL_WINDOW_DAYS`).
 *   Unset, appeals are closed (`identity.appeal_window_unset`) and the page says so; past it, `identity.appeal_window_closed`.
 * - The decision is made by someone other than the person who set the restriction (`identity.appeal_decider_restricted`),
 *   with a code from the owner's decision reason list (`IDENTITY_APPEAL_DECISION_REASONS`; unset refuses
 *   `identity.appeal_reasons_unset`). Lifting releases the restriction through the existing founder control, with the
 *   appeal as its business key and its four-eyes approval; upholding changes nothing but the appeal.
 * - The customer reads the status and the decision's words; the free text they wrote is theirs and is never shown to
 *   anyone but staff. Staff free text never reaches the customer.
 *
 * Appeals cover the restrictions a signed-in person can reach today: the trading restriction. A staff freeze and a
 * closure refuse signing in, so their appeal path is a later slice; a closure flagged final accepts none
 * (`identity.appeal_not_allowed`).
 */
export const APPEAL_STATUSES = ['submitted', 'in_review', 'upheld', 'lifted', 'withdrawn'] as const;
export const appealStatusSchema = z.enum(APPEAL_STATUSES);
export type AppealStatus = z.infer<typeof appealStatusSchema>;

/** The restrictions an appeal can name. */
export const APPEALABLE_RESTRICTIONS = ['trading_restricted'] as const;
export const appealRestrictionSchema = z.enum(APPEALABLE_RESTRICTIONS);
export type AppealRestriction = z.infer<typeof appealRestrictionSchema>;

/** The longest appeal text identity keeps. */
export const APPEAL_TEXT_MAX = 2000;

export const appealSubmitInputSchema = z
  .object({
    restriction: appealRestrictionSchema,
    text: z.string().trim().min(1).max(APPEAL_TEXT_MAX),
    /** The client's key for this one submission, so a retry is the same appeal. */
    clientRequestId: z.string().min(1).max(128),
  })
  .strict();
export type AppealSubmitInput = z.infer<typeof appealSubmitInputSchema>;

/** The owner's words for a decision code; null when the code is no longer on the list. */
export const appealDecisionReasonSchema = z
  .object({ code: kycReasonCodeSchema, text: z.string().min(1).nullable(), guidance: z.string().min(1).nullable() })
  .strict();

export const appealSchema = z
  .object({
    id: z.string().uuid(),
    restriction: appealRestrictionSchema,
    status: appealStatusSchema,
    text: z.string(),
    submittedAt: z.string().datetime({ offset: true }),
    decidedAt: z.string().datetime({ offset: true }).nullable(),
    /** Set once decided: `lifted` or `upheld`, with the owner's words for the code. */
    decision: z
      .object({ outcome: z.enum(['lifted', 'upheld']), reason: appealDecisionReasonSchema })
      .strict()
      .nullable(),
    version: z.string().regex(/^\d+$/),
  })
  .strict();
export type Appeal = z.infer<typeof appealSchema>;

export const appealsMineSchema = z
  .object({
    /** The owner's appeal window in days; null when unset, and then no appeal can be filed. */
    windowDays: z.number().int().positive().nullable(),
    appeals: z.array(appealSchema),
  })
  .strict();
export type AppealsMine = z.infer<typeof appealsMineSchema>;

/** What compliance reads: the appeal, whose it is and who set the restriction it names. */
export const appealForStaffSchema = appealSchema
  .extend({ userId: z.string().uuid(), restrictedBy: z.string().uuid().nullable(), decidedBy: z.string().uuid().nullable() })
  .strict();
export type AppealForStaff = z.infer<typeof appealForStaffSchema>;

export const appealDecideInputSchema = z
  .object({
    appealId: z.string().uuid(),
    decision: z.enum(['lift', 'uphold']),
    reasonCode: kycReasonCodeSchema,
    /** The appeal version the decider read. */
    expectedVersion: z.string().regex(/^\d+$/),
    /**
     * A lift only: the `trading.restrict` four-eyes approval over the restore whose reason is `appeal:<appealId>`, at
     * the restriction version the decider read (`restrictionVersion`). An uphold carries neither.
     */
    approvalId: z.string().min(1).max(128).optional(),
    restrictionVersion: z.string().regex(/^\d+$/).optional(),
  })
  .strict()
  .refine((input) => (input.decision === 'lift') === (input.approvalId !== undefined && input.restrictionVersion !== undefined), {
    message: 'A lift carries approvalId and restrictionVersion; an uphold carries neither',
  });
export type AppealDecideInput = z.infer<typeof appealDecideInputSchema>;

/** The restore reason a lift's approval binds: the appeal is the reason source. */
export function appealLiftReason(appealId: string): string {
  return `appeal:${appealId.toLowerCase()}`;
}
