import 'server-only';
import type { ExecuteFn } from '@/lib/desk/approval-steps';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { failureRefusal } from '@/lib/ops-desk/execute';
import { readOpenedDocument } from './document';

/**
 * Open one approved KYC document (J-ops-console-02 #5) at identity, as the signed-in founder.
 *
 * Identity checks the approval is for this document and that the caller is the operator who asked for it, then spends it on
 * the read; a second run with the same approval refuses. The answer goes back to the page that asked and nowhere else: it is
 * not logged, cached or stored here.
 */

/** A document is up to 10 MiB, so its read gets longer than an ordinary call. */
const OPEN_TIMEOUT_MS = 30_000;

export function kycDocumentOpenExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    if (request.kind !== 'identity.kyc_document.open') return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    const result = await founderCall(
      ctx,
      'identity',
      'kyc.getDocument',
      'POST',
      { documentId: request.documentId, approvalId: ids.approvalId, operationId: ids.operationId },
      readOpenedDocument,
      { timeoutMs: OPEN_TIMEOUT_MS },
    );
    if (result.kind !== 'ok') return failureRefusal('svc-identity', 'identity', result);
    const document = result.data;
    if (document.id !== request.documentId) return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
    return {
      ok: true,
      detail: `Identity opened document ${document.id} (${document.contentType}, ${document.byteLength} bytes) for you, once. The approval that names you as the requester is now spent.`,
      document,
    };
  };
}
