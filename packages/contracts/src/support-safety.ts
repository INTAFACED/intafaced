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
import { bankTransferIdSchema } from './bank-transfer-id.js';

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

/** When the scam happened: before any money was sent, or after the person sent some. */
export const supportScamWhenSchema = z.enum(['before_sending', 'after_sending']);
export type SupportScamWhen = z.infer<typeof supportScamWhenSchema>;

/** How the scammer got in touch. */
export const supportScamContactSchema = z.enum([
  'phone_call',
  'text_message',
  'email',
  'social_media',
  'messaging_app',
  'in_person',
  'other',
]);
export type SupportScamContact = z.infer<typeof supportScamContactSchema>;

/**
 * A scam report (BK-safe-02, J-bank-18 #3): when (before or after sending money), the amount, how the person was contacted
 * and, once money went out, the transfer it went out on. That transfer is one the person sent from their bank; svc-support
 * asks svc-bank before it takes the report (`bank-scam-transfer.ts`), and a transfer that is not theirs is refused. Before
 * any money moved there is no transfer to name. Its business key: one report per transfer
 * (`scam-report:<transferId>`, under the person); before sending, one per set of words. A double submit, or the same
 * transfer reported again, answers with the first report's acknowledgement.
 */
export const supportScamReportInputSchema = z
  .object({
    when: supportScamWhenSchema,
    /** The amount the scam was about, a decimal string greater than zero. */
    amount: z
      .string()
      .trim()
      .regex(/^\d{1,18}(\.\d{1,18})?$/, 'an amount is a decimal number')
      .refine((v) => /[1-9]/.test(v), 'an amount is greater than zero'),
    assetId: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{2,16}$/),
    /** svc-bank's id of the transfer the money went out on, from the person's transfer record; only after sending. */
    transferId: bankTransferIdSchema.optional(),
    contactedBy: supportScamContactSchema,
    /** What happened, in the person's words. */
    details: z.string().trim().max(5000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.when === 'after_sending' && !v.transferId)
      ctx.addIssue({ code: 'custom', path: ['transferId'], message: 'a report after sending money names the transfer' });
    if (v.when === 'before_sending' && v.transferId)
      ctx.addIssue({ code: 'custom', path: ['transferId'], message: 'before sending money there is no transfer to name' });
  });
export type SupportScamReportInput = z.infer<typeof supportScamReportInputSchema>;

/**
 * The owner's money-mule policy (BK-safe-02, J-bank-18 #3): receiving money and passing it on for someone else is money
 * laundering, and how to report a suspected mule account. Owner copy from `SUPPORT_MULE_POLICY`; blank is unpublished, and
 * the page says so rather than showing words of ours.
 */
export const supportMulePolicySchema = z.discriminatedUnion('published', [
  z.object({ published: z.literal(true), text: z.string().min(1) }),
  z.object({ published: z.literal(false) }),
]);
export type SupportMulePolicy = z.infer<typeof supportMulePolicySchema>;

/** The transfer the report names is not one the person sent. */
export const SUPPORT_SCAM_TRANSFER_NOT_YOURS = 'support.scam_transfer_not_yours';
/** The bank could not be asked whether the transfer is the person's: the report is not taken as checked. */
export const SUPPORT_SCAM_TRANSFER_UNCHECKED = 'support.scam_transfer_unchecked';

/** The final-response deadline: from the owner's limit, or not set while the owner has published none. */
export const supportResponseDeadlineSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('set'), dueAt: z.string().datetime(), limitDays: z.number().int().positive() }),
  z.object({ status: z.literal('not_set') }),
]);
export type SupportResponseDeadline = z.infer<typeof supportResponseDeadlineSchema>;

export const supportSafetyCaseKindSchema = z.enum(['complaint', 'bereavement', 'scam']);
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
  /** A scam report's case note, written once when it was acknowledged; null for every other kind. */
  caseNote: z.string().nullable(),
});
export type SupportSafetyAcknowledgement = z.infer<typeof supportSafetyAcknowledgementSchema>;

export const supportSafetyAcknowledgementsSchema = z.object({ acknowledgements: z.array(supportSafetyAcknowledgementSchema) });
export type SupportSafetyAcknowledgements = z.infer<typeof supportSafetyAcknowledgementsSchema>;

/** The same request key sent again with different words: refused, never a second case. */
export const SUPPORT_SAFETY_KEY_REUSED = 'support.safety_key_reused';
/** A date of death in the future. */
export const SUPPORT_BEREAVEMENT_DATE_INVALID = 'support.bereavement_date_invalid';
