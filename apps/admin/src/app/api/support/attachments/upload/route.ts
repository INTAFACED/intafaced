import { adminBffSession } from '@/lib/admin-bff-gate';
import { moduleDisabledResponse } from '@/lib/modules';
import { explainUploadFailure } from '@/lib/support/attachments-refusal';
import { UPLOAD_TRANSPORT_BYTES, readUploadParams } from '@/lib/support/files';
import { uploadTicketFile } from '@/lib/support/files-server';

/**
 * Add a file to a ticket as its assigned operator (SP-tickets-02). The body is the file's own bytes, its media type is the
 * request's content type, and the ticket and the retry key are in the query: a file does not fit the console's small JSON
 * body. The customer sees the file like a comment. svc-support checks the assignment, the owner's limits and the scan, and
 * answers `ok` only for a file it recorded under the operator's name; any other answer is a refusal in words. The audit line
 * names who and which ticket and file, never the bytes.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

const refusal = (title: string, body: string, next: string, code: string, status: number) =>
  Response.json({ ok: false, refusal: { title, body, next, code, changed: 'no' } }, { status, headers: NO_STORE });

async function readBytes(request: Request): Promise<Uint8Array | 'too_large' | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > UPLOAD_TRANSPORT_BYTES) {
        await reader.cancel();
        return 'too_large';
      }
      chunks.push(next.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  return size === 0 ? null : Buffer.concat(chunks);
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('support');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;

  const params = readUploadParams(request.url, request.headers.get('content-type'));
  if (!params) {
    return refusal(
      'That file was not accepted',
      'An upload names a ticket, a retry key and the file’s media type. Nothing was sent.',
      'Choose the file again.',
      'admin.request_invalid',
      400,
    );
  }
  const bytes = await readBytes(request);
  if (bytes === 'too_large') {
    return refusal(
      'That file is too large for the console',
      'The console cannot carry a file this big in one request.',
      'Nothing was added. Choose a smaller file.',
      'admin.body_too_large',
      413,
    );
  }
  if (bytes === null) {
    return refusal('That file is empty', 'No bytes were sent.', 'Nothing was added. Choose the file again.', 'admin.request_invalid', 400);
  }

  const result = await uploadTicketFile(session, params, bytes);
  console.warn(
    JSON.stringify({
      audit: 'admin.support_file_upload',
      at: new Date().toISOString(),
      founder: session.session.userId,
      ticket: params.ticketId,
      file: result.kind === 'ok' ? result.data.id : null,
      outcome: result.kind,
    }),
  );
  if (result.kind === 'ok') return Response.json({ ok: true, file: result.data }, { headers: NO_STORE });
  const status = result.kind === 'forbidden' ? (result.refusal.status === 401 ? 401 : 403) : result.kind === 'refused' ? 409 : 502;
  return Response.json(
    { ok: false, refusal: explainUploadFailure(result) },
    { status: result.kind === 'refused' && result.refusal.status === 404 ? 404 : status, headers: NO_STORE },
  );
}
