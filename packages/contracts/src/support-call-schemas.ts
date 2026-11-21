import { z } from 'zod';
import { supportTicketStatusSchema } from './support.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** The schemas svc-support's records share, moved from the service so the records and every caller read one copy. */

export const queueEntrySchema = z.object({
  ticketId: z.string().guid(),
  userId: z.string().guid(),
  category: z.string().min(1),
  status: supportTicketStatusSchema,
  subject: z.string().min(1),
  score: z.number().finite(),
  ageMs: z.number().nonnegative(),
  createdAt: z.string().datetime(),
  timingKind: z.literal('score_not_promise'),
  sla: z.literal(false),
  responseDue: z.object({ dueAt: z.string().datetime(), targetMinutes: z.number().int().positive() }).nullable(),
});

export const queueResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), entries: z.array(queueEntrySchema) }),
  z.object({ status: z.literal('empty') }),
]);
