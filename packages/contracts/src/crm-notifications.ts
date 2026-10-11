import { z } from 'zod';
import { crmActivitySchema, crmOpportunitySchema } from './outreach-crm.js';
import { guestNotificationReceiptSchema } from './guest-notifications.js';

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
export const crmQueueMessageInputSchema = z
  .object({
    requestId: id,
    opportunityId: id,
    expectedRevision: z.number().int().positive(),
    kind: z.enum(['information_request', 'call_invitation', 'follow_up']),
    staffText: z.string().trim().min(1).max(2000),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

/** A durable queue receipt is not evidence that an email was accepted or delivered. */
export const crmMessageSchema = z
  .object({
    id,
    opportunityId: id,
    submissionId: id,
    kind: crmQueueMessageInputSchema.shape.kind,
    actorUserId: id,
    status: z.enum(['pending', 'unconfigured', 'accepted', 'failed', 'unresolved']),
    createdAt: timestamp,
    notification: guestNotificationReceiptSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.notification !== null && value.notification.businessKey !== `staff_message:${value.id}`)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Notification evidence must belong to this queued message' });
    if (value.status === 'accepted' && value.notification?.status !== 'accepted')
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Acceptance requires a verified gateway receipt' });
  });
export const crmQueueMessageReceiptSchema = z
  .object({
    opportunity: crmOpportunitySchema,
    activity: crmActivitySchema,
    message: crmMessageSchema,
  })
  .strict();
export const crmMessageListInputSchema = z
  .object({
    opportunityId: id,
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().max(1024).optional(),
  })
  .strict();
export const crmMessagePageSchema = z.object({ items: z.array(crmMessageSchema), nextCursor: z.string().nullable() }).strict();
