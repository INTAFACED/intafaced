import { z } from 'zod';
import {
  BANK_PERSONAL_REQUEST_CANCEL,
  BANK_PERSONAL_REQUEST_CREATE,
  BANK_PERSONAL_REQUEST_DECLINE,
  BANK_PERSONAL_REQUEST_GET,
  BANK_PERSONAL_REQUEST_LIST,
  BANK_PERSONAL_REQUEST_REMIND,
  BANK_PERSONAL_REQUEST_REMINDERS,
  BANK_PERSONAL_REQUEST_REPORT,
  BANK_PERSONAL_REQUEST_SAFETY,
  PERSONAL_REQUEST_REPORT_REASONS,
  type PersonalRequest,
  type PersonalRequestReminder,
  type PersonalRequestSafety,
} from '@intafaced/contracts/bank-personal-request-procedures';
import type { ApiClient } from '../../../shared/api';

/**
 * Payment requests kept by svc-bank (`bank.personalRequest.*`, PP-send-request-12 and -13), called through their records
 * (`@intafaced/contracts/bank-personal-request-procedures`). The person who asks is the payee; the person asked is the
 * payer. Making, reminding, declining or reporting a request moves no money. Paying is one send under the request's own
 * key (`request:<requestId>`), so paying twice is the same transfer and answers its receipt.
 */

export type ServerRequest = PersonalRequest;
export type ReminderFacts = PersonalRequestReminder;
export const reportReasons = PERSONAL_REQUEST_REPORT_REASONS;
export type ReportReason = (typeof reportReasons)[number];
export type RequestSafety = PersonalRequestSafety;

/** The transfer id a request is paid under: its ledger key is the request's own. */
export const requestTransferId = (requestId: string): string => `request:${requestId}`;

/** A server request id, as opposed to a payment link this device made. */
export const isServerRequestId = (id: string): boolean => z.string().guid().safeParse(id).success;

export function createRequestsApi(api: ApiClient) {
  return {
    create: (input: { payerUserId: string; assetId: string; amount: string; note?: string; expiresAt: string; idempotencyKey: string }) =>
      api.call(BANK_PERSONAL_REQUEST_CREATE, input),
    list: (direction: 'incoming' | 'outgoing', signal?: AbortSignal) =>
      api.call(BANK_PERSONAL_REQUEST_LIST, { direction, limit: 50 }, { signal }),
    get: (requestId: string, signal?: AbortSignal) => api.call(BANK_PERSONAL_REQUEST_GET, { requestId }, { signal }),
    decline: (requestId: string) => api.call(BANK_PERSONAL_REQUEST_DECLINE, { requestId }),
    cancel: (requestId: string) => api.call(BANK_PERSONAL_REQUEST_CANCEL, { requestId }),
    remind: (requestId: string, idempotencyKey: string) => api.call(BANK_PERSONAL_REQUEST_REMIND, { requestId, idempotencyKey }),
    reminders: (requestId: string, signal?: AbortSignal) => api.call(BANK_PERSONAL_REQUEST_REMINDERS, { requestId }, { signal }),
    report: (requestId: string, reason: ReportReason, block: boolean) =>
      api.call(BANK_PERSONAL_REQUEST_REPORT, { requestId, reason, block }),
    safety: (requestId: string, signal?: AbortSignal) => api.call(BANK_PERSONAL_REQUEST_SAFETY, { requestId }, { signal }),
  };
}
export type RequestsApi = ReturnType<typeof createRequestsApi>;
