import { z } from 'zod';
import {
  supportAttachmentDownloadSchema,
  supportAttachmentLimitsSchema,
  supportAttachmentSchema,
} from '@intafaced/contracts/support-attachments';
import type { ApiClient } from '../../shared/api';
import { contractProcedure, readContract } from '../../shared/contract-call';
import { deskCopy } from './support-desk-copy';
import { plainSupportResult } from './support-refusal';
import { ticketSchema } from './support-schemas';

/**
 * The calls the support desk makes to the support service for close, rate, attach and help-article feedback: which
 * procedure, which input, and which answer is believed. Each answer is checked against the request and the signed-in
 * account before it is used, and each refusal is turned into a plain sentence (see support-refusal.ts).
 *
 * Every send carries a request id that the caller makes once per decision. The service answers a repeat of the same id with
 * the first result instead of doing it twice, so a double tap or a retry cannot close, rate, attach or vote twice.
 */
const mismatch = () => deskCopy.t('answerMismatch');

export const ratingSchema = z.object({
  ticketId: z.string().guid(),
  userId: z.string().guid(),
  score: z.number().int(),
  note: z.string().nullable(),
  createdAt: z.string(),
});
/** The service's own shape for a stored file: no store key, and the scan state the person is shown. */
export const attachmentSchema = supportAttachmentSchema;
const limitsCall = contractProcedure('support', 'attachmentLimits', { output: supportAttachmentLimitsSchema });
const downloadCall = contractProcedure('support', 'attachmentDownload', {
  output: supportAttachmentDownloadSchema,
  input: z.object({ attachmentId: z.string().guid() }),
});
const feedbackSchema = z.object({
  articleId: z.string(),
  version: z.number().int().positive(),
  userId: z.string().guid(),
  helpful: z.boolean(),
});

export function readRating(api: ApiClient, ticketId: string, userId: string | null, signal?: AbortSignal) {
  return api.query(
    'support',
    'rating',
    { ticketId },
    ratingSchema.nullable().refine((row) => row === null || (row.ticketId === ticketId && row.userId === userId), mismatch()),
    { signal },
  );
}

/** Ids of the signed-in person's own requests that already carry a rating. Only used to offer "rate this" on the rest. */
export function readRatedTicketIds(api: ApiClient, signal?: AbortSignal) {
  return api.query('support', 'ratedMine', undefined, z.array(z.string().guid()), { signal });
}

export async function closeRequest(api: ApiClient, input: { ticketId: string; userId: string | null; clientRequestId: string }) {
  return plainSupportResult(
    await api.mutate(
      'support',
      'close',
      { ticketId: input.ticketId, clientRequestId: input.clientRequestId },
      ticketSchema.refine((row) => row.id === input.ticketId && row.userId === input.userId && row.status === 'closed', mismatch()),
    ),
  );
}

export async function rateRequest(
  api: ApiClient,
  input: { ticketId: string; userId: string | null; score: number; note: string; clientRequestId: string },
) {
  const note = input.note.trim();
  return plainSupportResult(
    await api.mutate(
      'support',
      'rate',
      { ticketId: input.ticketId, score: input.score, ...(note ? { note } : {}), clientRequestId: input.clientRequestId },
      ratingSchema.refine((row) => row.ticketId === input.ticketId && row.userId === input.userId && row.score === input.score, mismatch()),
    ),
  );
}

export async function attachFile(
  api: ApiClient,
  input: { ticketId: string; userId: string | null; contentType: string; bodyBase64: string; byteLength: number; clientRequestId: string },
) {
  return plainSupportResult(
    await api.mutate(
      'support',
      'attach',
      {
        ticketId: input.ticketId,
        clientRequestId: input.clientRequestId,
        contentType: input.contentType,
        bodyBase64: input.bodyBase64,
      },
      attachmentSchema.refine(
        (row) => row.ticketId === input.ticketId && row.ownerId === input.userId && row.byteLength === input.byteLength,
        mismatch(),
      ),
    ),
  );
}

export async function sendArticleFeedback(
  api: ApiClient,
  input: { articleId: string; userId: string | null; helpful: boolean; clientRequestId: string },
) {
  return plainSupportResult(
    await api.mutate(
      'support',
      'kbFeedback',
      { id: input.articleId, helpful: input.helpful, clientRequestId: input.clientRequestId },
      feedbackSchema.refine((row) => row.articleId === input.articleId && row.userId === input.userId, mismatch()),
    ),
  );
}

export function readRelated(api: ApiClient, articleId: string, signal?: AbortSignal) {
  return api.query(
    'support',
    'kbRelated',
    { id: articleId },
    z.array(
      z.object({
        id: z.string(),
        titleKey: z.string(),
        bodyKey: z.string(),
        version: z.number().int().positive().optional(),
        published: z.boolean().optional(),
      }),
    ),
    { signal },
  );
}

/** The limits the owner set, read from the service. A blank limit is `null`; nothing here fills one in. */
export function readAttachLimits(api: ApiClient, signal?: AbortSignal) {
  return readContract(api, limitsCall, undefined, { signal });
}

/** The files on one of the person's own requests, each with its scan state. Every row must belong to that request and person. */
export function readTicketFiles(api: ApiClient, ticketId: string, userId: string | null, limit: number, signal?: AbortSignal) {
  return api.query(
    'support',
    'ticketAttachments',
    { ticketId, limit },
    z.array(supportAttachmentSchema).refine((rows) => rows.every((row) => row.ticketId === ticketId && row.ownerId === userId), mismatch()),
    { signal },
  );
}

/** One of the person's own clean files, as base64. The service refuses a file that is still being checked or was not accepted. */
export async function downloadFile(api: ApiClient, attachmentId: string) {
  return plainSupportResult(await readContract(api, downloadCall, { attachmentId }));
}
