/**
 * Support bulk update contract (SP-tickets-07): one change applied to several requests under one batch key, with each
 * request's outcome reported on its own so a partial result is visible.
 *
 * Browser safe: nothing here imports Node. How many requests one batch may hold is an owner value and is blank until
 * the owner sets it: a read says `null`, a write refuses `support.bulk_cap_unset`. The ceiling on `ticketIds` below is a
 * transport bound on the request, never the owner's cap and never shown as one.
 *
 * Rules carried by the shapes below:
 * - A batch has one change: an assignee, a status or a priority. There is no mix, so the outcome of a request is one answer.
 * - Each request is changed through the same path as a single change and writes its own audit row; the batch key and the
 *   request id make the per-request key (`supportBulkKey`), so a replayed batch changes nothing twice.
 * - A request the change does not apply to is `refused` with the typed code the single change would give, and the rest
 *   of the batch still runs. A request already at the asked value is `unchanged`.
 */
import { z } from 'zod';
import { supportTicketPrioritySchema, supportTicketStatusSchema } from './support.js';

export const SUPPORT_BULK_ERROR_CODES = ['support.bulk_cap_unset', 'support.bulk_too_large'] as const;
export type SupportBulkErrorCode = (typeof SUPPORT_BULK_ERROR_CODES)[number];

/** The setting a blank cap names. */
export const SUPPORT_BULK_CAP_KEY = 'support.bulk_cap' as const;

/** Transport bound on the request body. Not a product limit. */
export const SUPPORT_BULK_TRANSPORT_MAX = 1000;

export const supportBulkChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assign'), assigneeId: z.string().guid() }).strict(),
  z.object({ kind: z.literal('status'), status: supportTicketStatusSchema }).strict(),
  z.object({ kind: z.literal('priority'), priority: supportTicketPrioritySchema.nullable() }).strict(),
]);
export type SupportBulkChange = z.infer<typeof supportBulkChangeSchema>;

export const supportBulkInputSchema = z
  .object({
    /** A business key for this batch, chosen by the caller and reused to replay it. */
    batchKey: z.string().min(8).max(120),
    ticketIds: z.array(z.string().guid()).min(1).max(SUPPORT_BULK_TRANSPORT_MAX),
    change: supportBulkChangeSchema,
    /** Recorded on each request's trail row. */
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((v) => new Set(v.ticketIds).size === v.ticketIds.length, { message: 'a request appears once in a batch', path: ['ticketIds'] });
export type SupportBulkInput = z.infer<typeof supportBulkInputSchema>;

export const SUPPORT_BULK_OUTCOMES = ['changed', 'unchanged', 'refused'] as const;
export const supportBulkOutcomeSchema = z.enum(SUPPORT_BULK_OUTCOMES);

export const supportBulkResultSchema = z
  .object({
    batchKey: z.string(),
    results: z.array(
      z
        .object({
          ticketId: z.string().guid(),
          outcome: supportBulkOutcomeSchema,
          /** The typed code behind a `refused`; null for the other two. */
          code: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type SupportBulkResult = z.infer<typeof supportBulkResultSchema>;

/** What the desk may do in bulk: `cap` is the owner's batch size, or `null` while it is not set. */
export const supportBulkPolicySchema = z
  .object({
    cap: z.number().int().positive().nullable(),
    missing: z.literal(SUPPORT_BULK_CAP_KEY).nullable(),
  })
  .strict();
export type SupportBulkPolicy = z.infer<typeof supportBulkPolicySchema>;

/** The key one request in a batch is changed under. */
export const supportBulkKey = (batchKey: string, ticketId: string): string => `bulk:${batchKey}:${ticketId}`;
