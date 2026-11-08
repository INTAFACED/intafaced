import { z } from 'zod';

/**
 * svc-identity `account.compromised.*` (I-signin-sessions-28, J-identity-13 #3 to #5): "my account is compromised".
 *
 * - `start` (password): in one transaction ends every session and API key, sets the owner's own freeze (reason
 *   `compromise`, so no money leaves) and opens one case. While that case is open, pressing again returns the same case;
 *   it ends any session or key made since and puts the freeze back if it was lifted (`changed: false` when there was
 *   nothing left to end).
 * - `mine`: the open case, or null. Its checklist ticks from what identity sees, never by the person ticking it:
 *   `password` and `second_factor` from a password or sign-in method change recorded after the case opened, `devices`
 *   and `addresses` from the person's review of their devices or addresses, `api_keys` when the case opened (every key
 *   ended then; a live key made since puts it back to be done). `second_factor` ticks
 *   on a second step set up or replaced, never on a removal alone.
 * - `reportStolenFunds`: a free-text report kept as a note on the case. It moves no money and promises nothing back.
 *   Idempotent on the client's request id.
 * - `markReviewed`: the person reviewed their devices or withdrawal addresses while the case is open.
 *
 * Refusals: `identity.compromise_no_case` (nothing open to note or review), `auth.invalid_credentials`,
 * `auth.mfa_required` (an API key or sub-account cannot; the person signs in themselves).
 */
export const COMPROMISE_CHECKLIST_ITEMS = ['password', 'second_factor', 'devices', 'api_keys', 'addresses'] as const;
export type CompromiseChecklistItem = (typeof COMPROMISE_CHECKLIST_ITEMS)[number];

/** The items a person marks by reviewing; the others tick from changes identity records. */
export const COMPROMISE_REVIEW_ITEMS = ['devices', 'addresses'] as const;
export type CompromiseReviewItem = (typeof COMPROMISE_REVIEW_ITEMS)[number];

export const COMPROMISE_NOTE_KINDS = ['stolen_funds'] as const;

/** The longest stolen-funds report identity keeps, in characters. */
export const COMPROMISE_NOTE_MAX = 4_000;

export const compromiseStartInputSchema = z.object({ password: z.string().min(1).max(200) }).strict();
export const compromiseStartOutputSchema = z.object({
  caseId: z.string().uuid(),
  openedAt: z.string(),
  /** False when a case was already open and there was nothing left to end or freeze. */
  changed: z.boolean(),
});

export const compromiseChecklistEntrySchema = z.object({
  item: z.enum(COMPROMISE_CHECKLIST_ITEMS),
  doneAt: z.string().nullable(),
});

export const compromiseNoteSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(COMPROMISE_NOTE_KINDS),
  body: z.string(),
  createdAt: z.string(),
});

export const compromiseCaseSchema = z.object({
  id: z.string().uuid(),
  openedAt: z.string(),
  sessionsEnded: z.number().int().nonnegative(),
  keysEnded: z.number().int().nonnegative(),
  checklist: z.array(compromiseChecklistEntrySchema),
  notes: z.array(compromiseNoteSchema),
});
export type CompromiseCase = z.infer<typeof compromiseCaseSchema>;

export const compromiseMineOutputSchema = z.object({ case: compromiseCaseSchema.nullable() });

export const compromiseReportInputSchema = z
  .object({
    body: z.string().trim().min(1).max(COMPROMISE_NOTE_MAX),
    clientRequestId: z.string().min(8).max(100),
  })
  .strict();
export const compromiseReportOutputSchema = z.object({ noteId: z.string().uuid(), changed: z.boolean() });

export const compromiseReviewInputSchema = z.object({ item: z.enum(COMPROMISE_REVIEW_ITEMS) }).strict();
export const compromiseReviewOutputSchema = z.object({ item: z.enum(COMPROMISE_REVIEW_ITEMS), reviewedAt: z.string() });
