import { z } from 'zod';
import type { Context } from './trpc.js';

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const businessKey = z.string().regex(/^[A-Za-z0-9:_-]{1,160}$/);
const staffMessage = (kind: 'information_request' | 'call_invitation' | 'follow_up') =>
  z.object({ kind: z.literal(kind), activityId: id, staffText: z.string().trim().min(1).max(2000) }).strict();

/** Only ops derives these facts from saved enquiries and reviewed staff actions. */
export const guestNotificationSendInputSchema = z
  .object({
    businessKey,
    contactId: id,
    submissionId: id,
    recipientEmail: z.string().email().max(320),
    message: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('enquiry_acknowledgement') }).strict(),
      staffMessage('information_request'),
      staffMessage('call_invitation'),
      staffMessage('follow_up'),
    ]),
  })
  .strict();
export type GuestNotificationSendInput = z.infer<typeof guestNotificationSendInputSchema>;
export const guestNotificationGetInputSchema = z.object({ businessKey }).strict();

export const guestNotificationCodeSchema = z.enum([
  'guest.notification_unconfigured',
  'guest.configuration_unverified',
  'guest.request_conflict',
  'guest.gateway_refused',
  'guest.acceptance_unknown',
  'guest.storage_unavailable',
  'guest.address_rate_limited',
  'guest.submission_erased',
  'guest.delivery_in_progress',
]);

/** Gateway acceptance is evidence of acceptance, never arrival or a completed review. */
export const guestNotificationReceiptSchema = z
  .object({
    notificationId: id,
    businessKey,
    status: z.enum(['queued', 'attempting', 'accepted', 'refused', 'unresolved']),
    attemptedAt: timestamp.nullable(),
    acceptedAt: timestamp.nullable(),
    code: guestNotificationCodeSchema.nullable(),
    reference: z.string().max(256).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'accepted') {
      if (value.attemptedAt === null || value.acceptedAt === null || value.code !== null)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Acceptance requires actual attempt and acceptance evidence' });
    } else if (value.acceptedAt !== null || value.reference !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unaccepted states cannot claim gateway acceptance' });
    }
    if ((value.status === 'queued' || value.status === 'attempting') && value.code !== null)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Pending work cannot carry a terminal error' });
    if (value.status === 'queued' && value.attemptedAt !== null)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Queued work has not been attempted' });
    if ((value.status === 'attempting' || value.status === 'unresolved') && value.attemptedAt === null)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'An in-flight or uncertain outcome requires an actual attempt' });
    if ((value.status === 'refused' || value.status === 'unresolved') && value.code === null)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Refusal and uncertainty require a typed reason' });
    if (value.attemptedAt && value.acceptedAt && Date.parse(value.acceptedAt) < Date.parse(value.attemptedAt))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Acceptance cannot precede the attempt' });
  });
export type GuestNotificationReceipt = z.infer<typeof guestNotificationReceiptSchema>;

export const guestNotificationEraseInputSchema = z.object({ requestId: id, submissionId: id }).strict();
export const guestNotificationEraseReceiptSchema = z
  .object({
    requestId: id,
    submissionId: id,
    erasedCount: z.number().int().safe().nonnegative(),
    erasedAt: timestamp,
  })
  .strict();

/** Both operations use exact-body authenticated POSTs restricted to svc-ops. */
export interface GuestNotificationsContract {
  send(context: Context, input: GuestNotificationSendInput): Promise<GuestNotificationReceipt>;
  get(context: Context, input: z.infer<typeof guestNotificationGetInputSchema>): Promise<GuestNotificationReceipt | null>;
  /** Erase recipient/text; retain a minimal tombstone to refuse future sends. */
  eraseSubmission(
    context: Context,
    input: z.infer<typeof guestNotificationEraseInputSchema>,
  ): Promise<z.infer<typeof guestNotificationEraseReceiptSchema>>;
}
