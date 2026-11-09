/**
 * Bank safety cases on the support desk (BK-safe-03; J-bank-18 #5 and #6).
 *
 * Browser safe: nothing here imports Node. A complaint and a bereavement report are each a request on the support desk
 * (category `complaint` or `bereavement`) with one acknowledgement kept beside it. The acknowledgement is made once per
 * request key: sending the same key again answers with the first acknowledgement, its reference and its deadline, and
 * makes no second request.
 *
 * A complaint's final-response deadline comes from the owner's limit (`SUPPORT_COMPLAINT_RESPONSE_DAYS`, calendar days),
 * fixed when the complaint is acknowledged. With the limit blank the complaint is still taken and acknowledged, and its
 * deadline reads `not_set`: no limit is ever made up.
 */
import { z } from 'zod';

/** What a complaint is about. */
export const supportComplaintTopicSchema = z.enum(['account', 'cards', 'payments', 'trading', 'support', 'other']);
export type SupportComplaintTopic = z.infer<typeof supportComplaintTopicSchema>;

/** Who is reporting a death: their relation to the customer who died. */
export const supportBereavementRelationSchema = z.enum([
  'spouse_or_partner',
  'child',
  'parent',
  'sibling',
  'executor',
  'law_firm',
  'other',
]);
export type SupportBereavementRelation = z.infer<typeof supportBereavementRelationSchema>;

/** One key per submission, chosen by the page; a retry after a lost answer sends the same key. */
const requestKey = z
  .string()
  .min(8)
  .max(120)
  .regex(/^[A-Za-z0-9._:-]+$/, 'a request key is letters, digits and . _ : -');

/** A calendar date, `YYYY-MM-DD`. */
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date is YYYY-MM-DD');

export const supportComplaintInputSchema = z.object({
  requestKey,
  topic: supportComplaintTopicSchema,
  /** What went wrong, in the customer's words. */
  details: z.string().trim().min(10).max(5000),
  /** What the customer wants done about it. */
  outcome: z.string().trim().max(2000).optional(),
});
export type SupportComplaintInput = z.infer<typeof supportComplaintInputSchema>;

export const supportBereavementInputSchema = z.object({
  requestKey,
  /** The customer who died, as the reporter knows them. Nothing is said back about whether such an account exists. */
  deceasedName: z.string().trim().min(2).max(200),
  /** The email or handle the customer used, if the reporter knows it. */
  deceasedContact: z.string().trim().max(200).optional(),
  dateOfDeath: calendarDate,
  relation: supportBereavementRelationSchema,
  /** The reporter's own name and a way to reach them. */
  reporterName: z.string().trim().min(2).max(200),
  reporterContact: z.string().trim().min(3).max(200),
  details: z.string().trim().max(5000).optional(),
});
export type SupportBereavementInput = z.infer<typeof supportBereavementInputSchema>;

/** The final-response deadline: from the owner's limit, or not set while the owner has published none. */
export const supportResponseDeadlineSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('set'), dueAt: z.string().datetime(), limitDays: z.number().int().positive() }),
  z.object({ status: z.literal('not_set') }),
]);
export type SupportResponseDeadline = z.infer<typeof supportResponseDeadlineSchema>;

export const supportSafetyCaseKindSchema = z.enum(['complaint', 'bereavement']);
export type SupportSafetyCaseKind = z.infer<typeof supportSafetyCaseKindSchema>;

/** The acknowledgement the person reads: the request it made, a reference to quote, when, and (a complaint) its deadline. */
export const supportSafetyAcknowledgementSchema = z.object({
  id: z.string().guid(),
  kind: supportSafetyCaseKindSchema,
  ticketId: z.string().guid(),
  /** The short reference the person quotes; the same one on every read of this acknowledgement. */
  reference: z.string().regex(/^[A-Z]{2}-[0-9A-F]{8}$/),
  acknowledgedAt: z.string().datetime(),
  /** A complaint's final-response deadline; null for a bereavement report, which has none. */
  responseDeadline: supportResponseDeadlineSchema.nullable(),
});
export type SupportSafetyAcknowledgement = z.infer<typeof supportSafetyAcknowledgementSchema>;

export const supportSafetyAcknowledgementsSchema = z.object({ acknowledgements: z.array(supportSafetyAcknowledgementSchema) });
export type SupportSafetyAcknowledgements = z.infer<typeof supportSafetyAcknowledgementsSchema>;

/** The same request key sent again with different words: refused, never a second case. */
export const SUPPORT_SAFETY_KEY_REUSED = 'support.safety_key_reused';
/** A date of death in the future. */
export const SUPPORT_BEREAVEMENT_DATE_INVALID = 'support.bereavement_date_invalid';
