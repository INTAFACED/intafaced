import 'server-only';
import { createHash } from 'node:crypto';
import {
  academyConfirmMediaInputSchema,
  academyItemMediaSchema,
  academyMediaIntentInputSchema,
  academyMediaIntentSchema,
  academyMediaSchema,
  academySetItemCaptionsInputSchema,
  academySetItemCaptionsResultSchema,
} from '@intafaced/contracts/academy-courses';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import type { MediaDeskReply, MediaView } from './media-model';

/**
 * Course files as the signed-in founder. The browser sends a file's bytes straight to our own object store through the
 * signed address svc-academy issues; this hop carries only the declaration, the confirm and caption text. No money
 * moves and no learner record is written.
 */

const ACADEMY: PartLabels = {
  service: 'svc-academy',
  forbiddenMessage:
    'svc-academy did not accept your founder session. Course files need the Academy operator permission (admin:read, admin:write).',
  refusedMessage: (code) => (code ? explainRefusal(code, 409).body : null),
};

const readItemMedia = parseWith(academyItemMediaSchema);
const readIntent = parseWith(academyMediaIntentSchema);
const readMedia = parseWith(academyMediaSchema);
const readCaptions = parseWith(academySetItemCaptionsResultSchema);

export async function loadItemMedia(ctx: FounderCallContext, itemId: string): Promise<MediaView> {
  const media = await founderCall(ctx, 'academy', 'admin.itemMedia', 'GET', { itemId }, readItemMedia);
  return { media: partFrom(media, (d) => d, ACADEMY), asOf: new Date().toISOString() };
}

function reply<T>(
  result: FounderCallResult<T | null>,
  ok: (data: T) => { status: number; reply: MediaDeskReply },
): { status: number; reply: MediaDeskReply } {
  const refused = (code: string | null, status: number, uncertain = false) => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false as const, ...explainRefusal(code, status, uncertain) },
  });
  switch (result.kind) {
    case 'ok':
      return result.data ? ok(result.data) : refused(null, 502, true);
    case 'refused':
      return refused(result.refusal.code, result.refusal.status);
    case 'forbidden':
      return refused(result.refusal.code ?? 'operator.denied', 403);
    case 'not_built':
      return refused('not_built', 501);
    case 'unavailable':
      return refused(null, 503, result.uncertain);
    case 'invalid':
      return refused(null, 502, true);
  }
}

export type MediaOp = 'confirm' | 'captions';
export const isMediaOp = (op: unknown): op is MediaOp => op === 'confirm' || op === 'captions';

export async function changeMedia(
  ctx: FounderCallContext,
  op: MediaOp,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: MediaDeskReply } | { why: string }> {
  const { op: _op, ...input } = body;
  switch (op) {
    case 'confirm': {
      const parsed = academyConfirmMediaInputSchema.safeParse(input);
      if (!parsed.success) return { why: 'Which upload?' };
      const result = await founderCall(ctx, 'academy', 'admin.confirmMedia', 'POST', parsed.data, readMedia);
      return reply(result, (media) => ({ status: 200, reply: { ok: true, what: 'checked and stored', media } }));
    }
    case 'captions': {
      const parsed = academySetItemCaptionsInputSchema.safeParse(input);
      if (!parsed.success) return { why: 'Which item, which language and label, SRT or WebVTT, and the file text?' };
      const result = await founderCall(ctx, 'academy', 'admin.setItemCaptions', 'POST', parsed.data, readCaptions);
      return reply(result, (answer) =>
        answer.outcome === 'saved'
          ? { status: 200, reply: { ok: true, what: 'captions saved', itemMedia: answer.media } }
          : {
              status: 422,
              reply: {
                ok: false,
                title: 'The caption file has a problem',
                body: answer.problem,
                next: 'Fix that line and add the file again. Nothing was saved.',
                code: 'academy.captions_invalid',
                changed: 'no',
              },
            },
      );
    }
  }
}

const PUT_BASE_MS = 60_000;

/**
 * One file's bytes, streamed from the founder's browser to the signed address svc-academy issues for the declaration,
 * then confirmed. The console's own pages may only call this origin, so the bytes pass through here and are never
 * buffered whole: the stream is cut at the declared size, and its SHA-256 must match the declared one before svc-academy
 * is asked to confirm. The upload address comes only from svc-academy, never from the browser.
 */
export async function uploadMedia(
  ctx: FounderCallContext,
  declared: Record<string, unknown>,
  bytes: ReadableStream<Uint8Array>,
): Promise<{ status: number; reply: MediaDeskReply } | { why: string }> {
  const parsed = academyMediaIntentInputSchema.safeParse(declared);
  if (!parsed.success) return { why: 'Which item, which kind of file, and its name, type, size and fingerprint?' };
  const intent = await founderCall(ctx, 'academy', 'admin.mediaUploadIntent', 'POST', parsed.data, readIntent);
  // A refused declaration comes back here, before a byte of the file is read.
  if (intent.kind !== 'ok' || !intent.data)
    return reply(intent, () => ({ status: 502, reply: { ok: false, ...explainRefusal(null, 502, true) } }));
  const { media, uploadUrl } = intent.data;
  if (uploadUrl !== null) {
    const hash = createHash('sha256');
    let seen = 0;
    const counted = bytes.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > parsed.data.bytes) throw new Error('more bytes than declared');
          hash.update(chunk);
          controller.enqueue(chunk);
        },
      }),
    );
    const stopped = (body: string, changed: 'no' | 'unknown' = 'no') => ({
      status: 422,
      reply: {
        ok: false as const,
        title: 'The file did not arrive whole',
        body,
        next: 'Send the file again. Nothing was published.',
        code: 'academy.upload_incomplete',
        changed,
      },
    });
    try {
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': parsed.data.contentType, 'content-length': String(parsed.data.bytes) },
        body: counted,
        // Node's fetch needs this to send a streamed body.
        duplex: 'half',
        // A minute plus a second for each MiB declared, so a large video is not cut off and a stuck store still ends.
        signal: AbortSignal.timeout(PUT_BASE_MS + Math.ceil(parsed.data.bytes / 1_048_576) * 1000),
      } as RequestInit);
      if (!put.ok) return stopped(`Storage answered ${put.status} to the upload.`);
    } catch {
      return stopped('The upload to storage stopped part way, or sent more bytes than declared.', 'unknown');
    }
    if (seen !== parsed.data.bytes || hash.digest('hex') !== parsed.data.sha256)
      return stopped('The bytes sent are not the size or fingerprint the browser declared, so the file was not checked.');
  }
  const confirmed = await founderCall(ctx, 'academy', 'admin.confirmMedia', 'POST', { mediaId: media.id }, readMedia);
  return reply(confirmed, (m) => ({ status: 200, reply: { ok: true, what: 'checked and stored', media: m } }));
}
