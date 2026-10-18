import { readAdminJson } from '@/lib/admin-json';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest } from '@/lib/founder-session';
import { fromFailure, json } from '@/lib/merchants/bff';
import { payCall, type PayCallContext } from '@/lib/merchants/pay-call';
import { asNote, NOTE_BODY_MAX, NOTE_TAG_MAX, NOTE_TAGS_MAX, RETRACT_REASON_MAX, RETRACT_REASON_MIN } from '@/lib/founder-ops/notes';
import { isUuid } from '@/lib/founder-ops/read-model';
import { moduleDisabledResponse } from '@/lib/modules';

/**
 * Merchants panel BFF: operator notes (founder only, never shown to the merchant).
 *
 *   POST { action: 'add',     merchantId, body, tags, flagged }   append a note
 *   POST { action: 'retract', noteId, reason }                    withdraw a note; the text and the reason stay in the history
 *
 * Founder-only (`authorizeAdminRequest`: sealed cookie, exact origin, CSRF nonce, live founder entitlement). The service records
 * which founder wrote or retracted a note from the founder's own Bearer token; the browser never names an actor. No money moves.
 */

export const dynamic = 'force-dynamic';

const bad = () => new AdminSessionError('admin.merchants_input', 400);

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('merchants');
  if (disabled) return disabled;
  try {
    await authorizeAdminRequest(request);
    return json({ error: 'method_not_allowed', allow: 'POST' }, 405);
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('merchants');
  if (disabled) return disabled;
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const ctx: PayCallContext = { session, config };
    const body = await readAdminJson(request);

    if (body.action === 'add') {
      const merchantId = typeof body.merchantId === 'string' ? body.merchantId.trim().toLowerCase() : '';
      const text = typeof body.body === 'string' ? body.body.trim() : '';
      const tags = body.tags === undefined ? [] : body.tags;
      if (!isUuid(merchantId) || text.length === 0 || text.length > NOTE_BODY_MAX) throw bad();
      if (
        !Array.isArray(tags) ||
        tags.length > NOTE_TAGS_MAX ||
        !tags.every((t) => typeof t === 'string' && t.trim().length > 0 && t.trim().length <= NOTE_TAG_MAX)
      )
        throw bad();
      if (body.flagged !== undefined && typeof body.flagged !== 'boolean') throw bad();
      const result = await payCall(
        ctx,
        'founderAdmin.ops.notes.add',
        'POST',
        { merchantId, body: text, tags: (tags as string[]).map((t) => t.trim()), flagged: body.flagged === true },
        asNote,
      );
      if (result.kind !== 'ok') return fromFailure(result);
      return json({ ok: true, note: result.data });
    }

    if (body.action === 'retract') {
      const noteId = typeof body.noteId === 'string' ? body.noteId.trim().toLowerCase() : '';
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!isUuid(noteId) || reason.length < RETRACT_REASON_MIN || reason.length > RETRACT_REASON_MAX) throw bad();
      const result = await payCall(ctx, 'founderAdmin.ops.notes.retract', 'POST', { noteId, reason }, asNote);
      if (result.kind !== 'ok') return fromFailure(result, { notFoundCode: 'pay.note_not_found' });
      return json({ ok: true, note: result.data });
    }

    throw bad();
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
