import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { changeMedia, isMediaOp, loadItemMedia } from '@/lib/academy/media-server';

/**
 * Course files (AC-videos-02).
 *
 *   GET ?itemId=<uuid>   one item's uploads, caption languages and the owner's upload limits
 *   POST { op: 'confirm', mediaId }   svc-academy reads the stored file back again; a size or type other than declared refuses
 *   POST { op: 'captions', itemId, language, label, format: 'srt' | 'vtt', text }   the first malformed line comes back
 *
 * Founder-only. A file's bytes go through ./upload, never through this route.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const CAPTIONS_BODY_BYTES = 540_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const incomplete = (body: string) =>
  Response.json(
    {
      ok: false,
      title: 'That request is not complete',
      body,
      next: 'Nothing was changed. Correct it and try again.',
      code: null,
      changed: 'no',
    },
    { status: 400, headers: NO_STORE },
  );

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const itemId = new URL(request.url).searchParams.get('itemId') ?? '';
  if (!UUID.test(itemId)) return incomplete('Which item?');
  return Response.json(await loadItemMedia(session, itemId), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    // A caption file is up to 512 KiB of text, so this route takes more than the console's 16 KiB.
    const body = await readAdminJson(request, CAPTIONS_BODY_BYTES);
    if (!isMediaOp(body.op)) return incomplete('Unknown action.');
    const answer = await changeMedia(session, body.op, body);
    if ('why' in answer) return incomplete(answer.why);
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
