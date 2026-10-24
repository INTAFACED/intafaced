import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { uploadMedia } from '@/lib/academy/media-server';

/**
 * One course file's bytes (AC-videos-02).
 *
 *   POST ?itemId=<uuid>&kind=video|handout&fileName=<name>&bytes=<n>&sha256=<hex>   body: the file, typed by Content-Type
 *
 * svc-academy checks the declaration against the owner's limits first; a refusal comes back before any byte is read.
 * The bytes then stream to the signed address svc-academy issued, and the stored file is read back and checked.
 * Founder-only, with the console's CSRF header like every change.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const query = new URL(request.url).searchParams;
    const declared = {
      itemId: query.get('itemId') ?? '',
      kind: query.get('kind') ?? '',
      fileName: query.get('fileName') ?? '',
      contentType: request.headers.get('content-type')?.split(';')[0]?.trim() ?? '',
      bytes: Number(query.get('bytes')),
      sha256: query.get('sha256') ?? '',
    };
    if (!request.body)
      return Response.json(
        {
          ok: false,
          title: 'That request is not complete',
          body: 'No file was sent.',
          next: 'Nothing was changed. Choose the file and try again.',
          code: null,
          changed: 'no',
        },
        { status: 400, headers: NO_STORE },
      );
    const answer = await uploadMedia(session, declared, request.body);
    if ('why' in answer)
      return Response.json(
        {
          ok: false,
          title: 'That request is not complete',
          body: answer.why,
          next: 'Nothing was changed. Correct it and try again.',
          code: null,
          changed: 'no',
        },
        { status: 400, headers: NO_STORE },
      );
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
