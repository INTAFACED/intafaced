import { adminBffSession } from '@/lib/admin-bff-gate';
import { moduleDisabledResponse } from '@/lib/modules';
import { explainDownloadFailure } from '@/lib/support/attachments-refusal';
import { isFileId } from '@/lib/support/files';
import { downloadTicketFile } from '@/lib/support/files-server';

/**
 * Download one ticket file (SP-tickets-02). svc-support serves only a clean file on a ticket assigned to this operator, with
 * a fixed content type. The answer here is always a download, never a page: the type is `application/octet-stream`, the
 * disposition is `attachment` and the browser may not guess a type. The audit line names who and which file, never the bytes.
 */

export const dynamic = 'force-dynamic';

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('support');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const id = new URL(request.url).searchParams.get('id');
  if (!isFileId(id)) return Response.json({ code: 'admin.support_file_id' }, { status: 400, headers: HEADERS });

  const result = await downloadTicketFile(session, id);
  console.warn(
    JSON.stringify({
      audit: 'admin.support_file_download',
      at: new Date().toISOString(),
      founder: session.session.userId,
      file: id,
      outcome: result.kind,
    }),
  );
  if (result.kind !== 'ok') {
    const status = result.kind === 'forbidden' ? (result.refusal.status === 401 ? 401 : 403) : result.kind === 'refused' ? 409 : 502;
    return Response.json(
      { ok: false, refusal: explainDownloadFailure(result) },
      { status: result.kind === 'refused' && result.refusal.status === 404 ? 404 : status, headers: HEADERS },
    );
  }
  const bytes = Buffer.from(result.data.bodyBase64, 'base64');
  if (bytes.length !== result.data.byteLength) {
    return Response.json(
      {
        ok: false,
        refusal: {
          title: 'The file was not served',
          body: 'The bytes did not match the size svc-support reported.',
          next: 'Nothing was changed. Try again later.',
          code: 'admin.ops_invalid_response',
          changed: 'no',
        },
      },
      { status: 502, headers: HEADERS },
    );
  }
  return new Response(bytes, {
    headers: {
      ...HEADERS,
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="attachment-${id.slice(0, 8)}"`,
      'content-length': String(bytes.length),
    },
  });
}
