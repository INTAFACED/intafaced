import {
  SUPPORT_ATTACH,
  SUPPORT_ATTACHMENT_DOWNLOAD,
  SUPPORT_ATTACHMENT_LIMITS,
  SUPPORT_CLOSE,
  SUPPORT_KB_FEEDBACK,
  SUPPORT_KB_RELATED,
  SUPPORT_RATE,
  SUPPORT_RATED_MINE,
  SUPPORT_RATING,
  SUPPORT_TICKET_ATTACHMENTS,
} from '@intafaced/contracts/support-customer-procedures';
import type { ApiClient } from '../../shared/api';
import { plainSupportResult } from './support-refusal';

/**
 * The calls the support desk makes to the support service for close, rate, attach and help-article feedback: which
 * procedure, which input, and which answer is believed. Each answer is checked against the request and the signed-in
 * account before it is used, and each refusal is turned into a plain sentence (see support-refusal.ts).
 *
 * Every send carries a request id that the caller makes once per decision. The service answers a repeat of the same id with
 * the first result instead of doing it twice, so a double tap or a retry cannot close, rate, attach or vote twice.
 */
export function readRating(api: ApiClient, ticketId: string, userId: string | null, signal?: AbortSignal) {
  return api.call(
    SUPPORT_RATING,
    { ticketId },
    { signal, accept: (row) => row === null || (row.ticketId === ticketId && row.userId === userId) },
  );
}

/** Ids of the signed-in person's own requests that already carry a rating. Only used to offer "rate this" on the rest. */
export function readRatedTicketIds(api: ApiClient, signal?: AbortSignal) {
  return api.call(SUPPORT_RATED_MINE, undefined, { signal });
}

export async function closeRequest(api: ApiClient, input: { ticketId: string; userId: string | null; clientRequestId: string }) {
  return plainSupportResult(
    await api.call(
      SUPPORT_CLOSE,
      { ticketId: input.ticketId, clientRequestId: input.clientRequestId },
      { accept: (row) => row.id === input.ticketId && row.userId === input.userId && row.status === 'closed' },
    ),
  );
}

export async function rateRequest(
  api: ApiClient,
  input: { ticketId: string; userId: string | null; score: number; note: string; clientRequestId: string },
) {
  const note = input.note.trim();
  return plainSupportResult(
    await api.call(
      SUPPORT_RATE,
      { ticketId: input.ticketId, score: input.score, ...(note ? { note } : {}), clientRequestId: input.clientRequestId },
      { accept: (row) => row.ticketId === input.ticketId && row.userId === input.userId && row.score === input.score },
    ),
  );
}

export async function attachFile(
  api: ApiClient,
  input: { ticketId: string; userId: string | null; contentType: string; bodyBase64: string; byteLength: number; clientRequestId: string },
) {
  return plainSupportResult(
    await api.call(
      SUPPORT_ATTACH,
      {
        ticketId: input.ticketId,
        clientRequestId: input.clientRequestId,
        contentType: input.contentType,
        bodyBase64: input.bodyBase64,
      },
      { accept: (row) => row.ticketId === input.ticketId && row.ownerId === input.userId && row.byteLength === input.byteLength },
    ),
  );
}

export async function sendArticleFeedback(
  api: ApiClient,
  input: { articleId: string; userId: string | null; helpful: boolean; clientRequestId: string; comment?: string; openRequest?: boolean },
) {
  return plainSupportResult(
    await api.call(
      SUPPORT_KB_FEEDBACK,
      {
        id: input.articleId,
        helpful: input.helpful,
        clientRequestId: input.clientRequestId,
        ...(input.comment ? { comment: input.comment } : {}),
        ...(input.openRequest ? { openRequest: true } : {}),
      },
      { accept: (row) => row.articleId === input.articleId && row.userId === input.userId },
    ),
  );
}

export function readRelated(api: ApiClient, articleId: string, signal?: AbortSignal) {
  return api.call(SUPPORT_KB_RELATED, { id: articleId }, { signal });
}

/** The limits the owner set, read from the service. A blank limit is `null`; nothing here fills one in. */
export function readAttachLimits(api: ApiClient, signal?: AbortSignal) {
  return api.call(SUPPORT_ATTACHMENT_LIMITS, undefined, { signal });
}

/** The files on one of the person's own requests, each with its scan state. Every row must belong to that request and person. */
export function readTicketFiles(api: ApiClient, ticketId: string, userId: string | null, limit: number, signal?: AbortSignal) {
  return api.call(
    SUPPORT_TICKET_ATTACHMENTS,
    { ticketId, limit },
    { signal, accept: (rows) => rows.every((row) => row.ticketId === ticketId && row.ownerId === userId) },
  );
}

/** One of the person's own clean files, as base64. The service refuses a file that is still being checked or was not accepted. */
export async function downloadFile(api: ApiClient, attachmentId: string) {
  return plainSupportResult(await api.call(SUPPORT_ATTACHMENT_DOWNLOAD, { attachmentId }));
}
