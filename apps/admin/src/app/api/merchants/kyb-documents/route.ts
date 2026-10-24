import { readAdminJson } from '@/lib/admin-json';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest } from '@/lib/founder-session';
import { kybDocumentFileSchema, kybDocumentsUploadResultSchema } from '@intafaced/contracts/kyb-documents';
import { fromFailure, json } from '@/lib/merchants/bff';
import { payCall, type PayCallContext } from '@/lib/merchants/pay-call';
import { isUuid } from '@/lib/founder-ops/read-model';
import { KYB_REASON_MAX, KYB_REASON_MIN, reasonLength } from '@/lib/merchants/kyb-review-model';
import { moduleDisabledResponse } from '@/lib/modules';

/**
 * Merchants panel BFF: business verification documents (compliance).
 *
 *   POST { action: 'review', applicationId, documentId, verdict: 'accepted' | 'rejected', reason? }   one verdict on a current upload
 *   POST { action: 'file',   applicationId, documentId }                                            the file's bytes, to open it
 *
 * Founder-only (`authorizeAdminRequest`: sealed cookie, exact origin, CSRF nonce, live founder entitlement). svc-pay checks
 * admin:compliance and the second factor on the founder's own token, records who gave each verdict and who opened each
 * file. The browser never names an actor. No money moves.
 */

export const dynamic = 'force-dynamic';

const bad = () => new AdminSessionError('admin.merchants_input', 400);
const id = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

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
    const applicationId = id(body.applicationId);
    const documentId = id(body.documentId);
    if (!isUuid(applicationId) || !isUuid(documentId)) throw bad();

    if (body.action === 'review') {
      const verdict = body.verdict;
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (verdict !== 'accepted' && verdict !== 'rejected') throw bad();
      if (verdict === 'rejected' && (reasonLength(reason) < KYB_REASON_MIN || reasonLength(reason) > KYB_REASON_MAX)) throw bad();
      if (verdict === 'accepted' && reason.length > 0) throw bad();
      const result = await payCall(
        ctx,
        'kyb.documents.review',
        'POST',
        { applicationId, documentId, verdict, ...(verdict === 'rejected' ? { reason } : {}) },
        (raw) => {
          const parsed = kybDocumentsUploadResultSchema.safeParse(raw);
          return parsed.success ? parsed.data : null;
        },
      );
      if (result.kind !== 'ok') return fromFailure(result, { notFoundCode: 'pay.kyb_document_not_found' });
      return json({ ok: true, row: result.data.row });
    }

    if (body.action === 'file') {
      const result = await payCall(ctx, 'kyb.documents.file', 'POST', { applicationId, documentId }, (raw) => {
        const parsed = kybDocumentFileSchema.safeParse(raw);
        return parsed.success ? parsed.data : null;
      });
      if (result.kind !== 'ok') return fromFailure(result, { notFoundCode: 'pay.kyb_document_not_found' });
      return json({ ok: true, file: result.data });
    }

    throw bad();
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
