import { z } from 'zod';

/**
 * svc-identity `kyc.history` and `kyc.historyFor` (I-kyc-compliance-01): a person's verification cases, newest first.
 * A case is one request and what was decided on it. `history` lists each transition in order (version 1 is the
 * submission). A rejected case names a code from the owner's reason list with the reason and the fix guidance the
 * owner wrote for it; `text` and `guidance` are null when the code is no longer on the list, and `reason` is null on a
 * case rejected before reasons existed. `note` is the reviewer's note, present only when the reviewer marked it for
 * the customer. `followsCaseId` is the rejected case a resubmission follows. No document, image or reviewer is here.
 */
export const KYC_CASE_STATES = ['submitted', 'approved', 'rejected', 'expired'] as const;
export const kycCaseStateSchema = z.enum(KYC_CASE_STATES);
export type KycCaseState = z.infer<typeof kycCaseStateSchema>;

/** The shape of a reject reason code in the owner's list. */
export const kycReasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);

const isoSchema = z.string().datetime({ offset: true });

export const kycCaseSchema = z.object({
  id: z.string().guid(),
  recordId: z.string().guid(),
  tier: z.enum(['none', 'basic', 'full', 'institutional']),
  jurisdiction: z.string().max(64),
  state: kycCaseStateSchema,
  version: z.number().int().min(1),
  followsCaseId: z.string().guid().nullable(),
  submittedAt: isoSchema,
  decidedAt: isoSchema.nullable(),
  /** When an approved level lapses; past it the case reads expired. */
  expiresAt: isoSchema.nullable(),
  reason: z.object({ code: kycReasonCodeSchema, text: z.string().min(1).nullable(), guidance: z.string().min(1).nullable() }).nullable(),
  note: z.string().min(1).max(500).nullable(),
  history: z.array(z.object({ version: z.number().int().min(1), state: kycCaseStateSchema, at: isoSchema })).min(1),
});
export type KycCase = z.infer<typeof kycCaseSchema>;

export const kycHistoryOutputSchema = z.object({ cases: z.array(kycCaseSchema) });
export type KycHistory = z.infer<typeof kycHistoryOutputSchema>;
