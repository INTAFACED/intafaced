import { z } from 'zod';

/**
 * svc-identity `kyc.history` and `kyc.historyFor` (I-kyc-compliance-01): a person's verification cases, newest first.
 * A case is one request and what was decided on it. `history` lists each transition in order (version 1 is the
 * submission). A rejected case names a code from the owner's reason list with the reason and the fix guidance the
 * owner wrote for it; `text` and `guidance` are null when the code is no longer on the list, and `reason` is null on a
 * case rejected before reasons existed. `note` is the reviewer's note, present only when the reviewer marked it for
 * the customer. `followsCaseId` is the rejected case a resubmission follows. No document, image or reviewer is here.
 */
/** `info_requested`: a reviewer asked for more (I-kyc-compliance-03); the case waits for the customer's answers. */
export const KYC_CASE_STATES = ['submitted', 'info_requested', 'approved', 'rejected', 'expired'] as const;
export const kycCaseStateSchema = z.enum(KYC_CASE_STATES);
export type KycCaseState = z.infer<typeof kycCaseStateSchema>;

/** The shape of a reject reason code in the owner's list. */
export const kycReasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);

const isoSchema = z.string().datetime({ offset: true });

/**
 * One task of a request for information (I-kyc-compliance-03): what the reviewer asked for (`key`, a short code, and `hint`,
 * what to send), its state, and when it is due (null when the owner states no deadline).
 */
export const kycInfoTaskSchema = z.object({
  key: kycReasonCodeSchema,
  hint: z.string().min(1).max(500),
  state: z.enum(['requested', 'provided']),
  dueAt: isoSchema.nullable(),
});
export type KycInfoTask = z.infer<typeof kycInfoTaskSchema>;

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
  /** The tasks of the case's latest request for information, oldest first; empty when none was asked. */
  tasks: z.array(kycInfoTaskSchema),
});
export type KycCase = z.infer<typeof kycCaseSchema>;

export const kycHistoryOutputSchema = z.object({ cases: z.array(kycCaseSchema) });
export type KycHistory = z.infer<typeof kycHistoryOutputSchema>;

/**
 * The verification review queue (I-kyc-compliance-02, J-identity-20 #1 #2), compliance only. `kyc.review.list` gives the
 * open (submitted) cases oldest first, one page of the owner's page size at a time, with `nextCursor` null on the last
 * page. A case has at most one reviewer: `kyc.review.assign` claims it by compare-and-set, and a case another reviewer
 * holds refuses `kyc.case_assigned`. `kyc.review.case` is one case for review: the case as the person sees it, the owner's
 * reject reasons, and the reviewers' internal notes, which are never in anything the customer reads.
 */
export const kycReviewQueueRowSchema = z.object({
  caseId: z.string().guid(),
  recordId: z.string().guid(),
  userId: z.string().guid(),
  tier: z.enum(['none', 'basic', 'full', 'institutional']),
  jurisdiction: z.string().max(64),
  submittedAt: isoSchema,
  assignedTo: z.string().nullable(),
  assignedAt: isoSchema.nullable(),
  /** Staff only: the case names the same person as another account's verification (I-kyc-compliance-14). */
  duplicateFlag: z.boolean(),
  /**
   * When the level's stated review time runs out for this case (I-kyc-compliance-05), or null when none is stated; `overdue`
   * is true once it has passed, and the queue shows an escalation line.
   */
  reviewDueAt: isoSchema.nullable(),
  overdue: z.boolean(),
});
export type KycReviewQueueRow = z.infer<typeof kycReviewQueueRowSchema>;

export const kycReviewListInputSchema = z.object({ cursor: z.string().min(1).max(200).nullish() });
export const kycReviewListOutputSchema = z.object({
  pageSize: z.number().int().min(1).max(200),
  cases: z.array(kycReviewQueueRowSchema),
  nextCursor: z.string().nullable(),
});
export type KycReviewList = z.infer<typeof kycReviewListOutputSchema>;

export const kycReviewAssignInputSchema = z.object({ caseId: z.string().guid(), action: z.enum(['claim', 'release']) });
export const kycReviewAssignmentSchema = z.object({
  caseId: z.string().guid(),
  assignedTo: z.string().nullable(),
  assignedAt: isoSchema.nullable(),
});
export type KycReviewAssignment = z.infer<typeof kycReviewAssignmentSchema>;

export const kycReviewNoteSchema = z.object({
  id: z.string().guid(),
  authorId: z.string(),
  body: z.string().min(1).max(2000),
  at: isoSchema,
});
export type KycReviewNote = z.infer<typeof kycReviewNoteSchema>;

/**
 * An appeal on a rejected case (I-kyc-compliance-02, J-identity-20 #8). The customer appeals a rejection once, within the
 * owner's window (`kyc.appeal_closed` outside it or when unset); a final rejection refuses `kyc.case_final`. A reviewer other
 * than the one who rejected decides it (`kyc.same_reviewer`): `upheld` makes the rejection final, `overturned` sends the
 * request back to the queue.
 */
export const kycAppealSchema = z.object({
  id: z.string().guid(),
  caseId: z.string().guid(),
  body: z.string().min(1).max(2000),
  submittedAt: isoSchema,
  decision: z.enum(['upheld', 'overturned']).nullable(),
  decidedAt: isoSchema.nullable(),
});
export type KycAppeal = z.infer<typeof kycAppealSchema>;
export const kycAppealSubmitInputSchema = z.object({ caseId: z.string().guid(), body: z.string().trim().min(1).max(2000) });
export const kycAppealDecideInputSchema = z.object({ caseId: z.string().guid(), decision: z.enum(['upheld', 'overturned']) });

export const kycReviewCaseInputSchema = z.object({ caseId: z.string().guid() });
export const kycReviewCaseSchema = z.object({
  userId: z.string().guid(),
  recordStatus: z.enum(['pending', 'approved', 'rejected', 'expired']),
  case: kycCaseSchema,
  assignedTo: z.string().nullable(),
  assignedAt: isoSchema.nullable(),
  /** The owner's reject reasons, in the owner's order. Empty when the list is unset: a reject then refuses. */
  reasonCodes: z.array(z.object({ code: kycReasonCodeSchema, reason: z.string().min(1) })),
  notes: z.array(kycReviewNoteSchema),
  /**
   * Staff only (I-kyc-compliance-14): the other account whose verification names the same person, or null. Never in
   * anything the customer reads.
   */
  duplicateOfUserId: z.string().guid().nullable(),
  /** As on the queue row: when the stated review time runs out, and whether it has. */
  reviewDueAt: isoSchema.nullable(),
  overdue: z.boolean(),
  /** A final rejection takes no more appeals. */
  final: z.boolean(),
  /** The appeals on this case, oldest first. */
  appeals: z.array(kycAppealSchema),
});
export type KycReviewCase = z.infer<typeof kycReviewCaseSchema>;

export const kycReviewAddNoteInputSchema = z.object({ caseId: z.string().guid(), body: z.string().trim().min(1).max(2000) });

/** `kyc.review.requestInfo`: ask the customer for one to ten named items on an open case (I-kyc-compliance-03). */
export const kycRequestInfoInputSchema = z.object({
  caseId: z.string().guid(),
  items: z
    .array(z.object({ key: kycReasonCodeSchema, hint: z.string().trim().min(1).max(500) }))
    .min(1)
    .max(10),
});
