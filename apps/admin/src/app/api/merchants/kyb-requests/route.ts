import { readAdminJson } from '@/lib/admin-json';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest } from '@/lib/founder-session';
import { kybRequestFileBytesSchema, kybRequestResultSchema } from '@intafaced/contracts/kyb-information-requests';
import { fromFailure, json } from '@/lib/merchants/bff';
import { payCall, type PayCallContext } from '@/lib/merchants/pay-call';
import { isUuid } from '@/lib/founder-ops/read-model';
import { KYB_CLOSE_NOTE_MAX, KYB_REASON_MIN, KYB_REQUEST_TEXT_MAX, kybRequestKey, reasonLength } from '@/lib/merchants/kyb-review-model';
import { moduleDisabledResponse } from '@/lib/modules';

/**
 * Merchants panel BFF: information requests to a business (compliance, J-merchant-02 step 4).
 *
 *   POST { action: 'create', merchantId, text, dueAt }   ask the merchant for more, due at a future time
 *   POST { action: 'close',  requestId, note }           close an open or answered request with a note the merchant reads
 *   POST { action: 'file',   requestId }                 the answer file's bytes, to open it
 *
 * Founder-only (`authorizeAdminRequest`: sealed cookie, exact origin, CSRF nonce, live founder entitlement). svc-pay checks
 * admin:compliance and the second factor on the founder's own token and records who asked, who closed and who opened
 * each file. The request key is derived here from the merchant, words and due date, so a resend is the same request.
 * The browser never names an actor. No money moves.
 */

export const dynamic = 'force-dynamic';

const bad = () => new AdminSessionError('admin.merchants_input', 400);
const id = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const words = (value: unknown, max: number) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (reasonLength(text) < KYB_REASON_MIN || reasonLength(text) > max) throw bad();
  return text;
};

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
    const parseResult = (raw: unknown) => {
      const parsed = kybRequestResultSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    };

    if (body.action === 'create') {
      const merchantId = id(body.merchantId);
      if (!isUuid(merchantId)) throw bad();
      const text = words(body.text, KYB_REQUEST_TEXT_MAX);
      const due = typeof body.dueAt === 'string' ? new Date(body.dueAt) : null;
      if (!due || Number.isNaN(due.getTime())) throw bad();
      const dueAt = due.toISOString();
      const requestKey = await kybRequestKey(merchantId, text, dueAt);
      const result = await payCall(ctx, 'kyb.requests.create', 'POST', { merchantId, requestKey, text, dueAt }, parseResult);
      if (result.kind !== 'ok') return fromFailure(result, { notFoundCode: 'pay.merchant_not_found' });
      return json({ ok: true, request: result.data.request });
    }

    const requestId = id(body.requestId);
    if (!isUuid(requestId)) throw bad();

    if (body.action === 'close') {
      const note = words(body.note, KYB_CLOSE_NOTE_MAX);
      const result = await payCall(ctx, 'kyb.requests.close', 'POST', { requestId, note }, parseResult);
      if (result.kind !== 'ok') return fromFailure(result, { notFoundCode: 'pay.kyb_request_not_found' });
      return json({ ok: true, request: result.data.request });
    }

    if (body.action === 'file') {
      const result = await payCall(ctx, 'kyb.requests.file', 'POST', { requestId }, (raw) => {
        const parsed = kybRequestFileBytesSchema.safeParse(raw);
        return parsed.success ? parsed.data : null;
      });
      if (result.kind !== 'ok') return fromFailure(result, { notFoundCode: 'pay.kyb_request_file_not_found' });
      return json({ ok: true, file: result.data });
    }

    throw bad();
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
