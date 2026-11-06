import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../../shared/api';

/**
 * Payment requests kept by svc-bank (`bank.personalRequest.*`, PP-send-request-12 and -13). The person who asks is the
 * payee; the person asked is the payer. Making, reminding, declining or reporting a request moves no money. Paying is one
 * send under the request's own key (`request:<requestId>`), so paying twice is the same transfer and answers its receipt.
 */

const amount = z.string().regex(/^\d+(\.\d{1,18})?$/);
export const requestStatuses = ['open', 'paid', 'declined', 'cancelled', 'expired'] as const;
export type RequestStatus = (typeof requestStatuses)[number];

export const serverRequestSchema = z.object({
  requestId: z.string().guid(),
  payeeUserId: z.string(),
  payerUserId: z.string(),
  payeeHandle: z.string().nullable(),
  payerHandle: z.string().nullable(),
  assetId: z.string(),
  amount,
  note: z.string().nullable(),
  expiresAt: z.string(),
  status: z.enum(requestStatuses),
  ledgerTxId: z.string().nullable(),
  createdAt: z.string(),
  notice: z.object({ delivered: z.boolean(), blocker: z.string().nullable() }),
});
export type ServerRequest = z.infer<typeof serverRequestSchema>;

export const reminderFactsSchema = z.object({
  sentInWindow: z.number(),
  cap: z.number(),
  windowSeconds: z.number(),
  nextAllowedAt: z.string().nullable(),
});
export type ReminderFacts = z.infer<typeof reminderFactsSchema>;

export const reportReasons = ['scam', 'spam', 'harassment', 'other'] as const;
export type ReportReason = (typeof reportReasons)[number];

export const safetySchema = z.object({
  caseId: z.string().guid(),
  reason: z.enum(reportReasons),
  state: z.enum(['open', 'closed']),
  openedAt: z.string(),
  blocked: z.boolean(),
});
export type RequestSafety = z.infer<typeof safetySchema>;

/** The transfer id a request is paid under: its ledger key is the request's own. */
export const requestTransferId = (requestId: string): string => `request:${requestId}`;

/** A server request id, as opposed to a payment link this device made. */
export const isServerRequestId = (id: string): boolean => z.string().guid().safeParse(id).success;

export function createRequestsApi(api: ApiClient) {
  return {
    create: (input: { payerUserId: string; assetId: string; amount: string; note?: string; expiresAt: string; idempotencyKey: string }) =>
      api.mutate('bank', 'personalRequest.create', input, serverRequestSchema),
    list: (direction: 'incoming' | 'outgoing', signal?: AbortSignal): Promise<ApiResult<ServerRequest[]>> =>
      api.query('bank', 'personalRequest.list', { direction, limit: 50 }, z.array(serverRequestSchema), { signal }),
    get: (requestId: string, signal?: AbortSignal) =>
      api.query('bank', 'personalRequest.get', { requestId }, serverRequestSchema, { signal }),
    decline: (requestId: string) => api.mutate('bank', 'personalRequest.decline', { requestId }, serverRequestSchema),
    cancel: (requestId: string) => api.mutate('bank', 'personalRequest.cancel', { requestId }, serverRequestSchema),
    remind: (requestId: string, idempotencyKey: string) =>
      api.mutate(
        'bank',
        'personalRequest.remind',
        { requestId, idempotencyKey },
        serverRequestSchema.extend({ reminder: reminderFactsSchema }),
      ),
    reminders: (requestId: string, signal?: AbortSignal) =>
      api.query('bank', 'personalRequest.reminders', { requestId }, reminderFactsSchema, { signal }),
    report: (requestId: string, reason: ReportReason, block: boolean) =>
      api.mutate(
        'bank',
        'personalRequest.report',
        { requestId, reason, block },
        z.object({ request: serverRequestSchema, safety: safetySchema }),
      ),
    safety: (requestId: string, signal?: AbortSignal) =>
      api.query('bank', 'personalRequest.safety', { requestId }, safetySchema.nullable(), { signal }),
  };
}
export type RequestsApi = ReturnType<typeof createRequestsApi>;
