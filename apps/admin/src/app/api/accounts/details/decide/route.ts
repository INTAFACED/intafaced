import { customerDetailsResultSchema } from '@intafaced/contracts';
import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { adminSessionErrorResponse, AdminSessionError } from '@/lib/founder-session';
import { founderCall, parseWith } from '@/lib/desk/founder-call';
import { readDecideForm } from '@/lib/accounts/details-forms';
import { detailsAnswer } from '@/lib/accounts/details-server';

/**
 * The other founder's decision on a compliance review of a customer's protected details (J-ops-console-04 #9). A pass
 * applies the proposed values; a reject leaves the record as it was. Identity refuses the founder who asked for the change.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  let raw: Record<string, unknown>;
  try {
    raw = await readAdminJson(request);
  } catch (error) {
    return adminSessionErrorResponse(error instanceof AdminSessionError ? error : new AdminSessionError('admin.json_required', 400));
  }
  const form = readDecideForm(raw, session.session.userId);
  if (!form)
    return Response.json(
      { ok: false, text: 'That decision was not accepted: give a note of 12 to 255 characters. Nothing was sent.' },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  const result = await founderCall(
    session,
    'identity',
    'accountControls.detailsDecide',
    'POST',
    { requestId: form.requestId, userId: form.userId, reviewId: form.reviewId, decision: form.decision, note: form.note },
    parseWith(customerDetailsResultSchema),
  );
  return detailsAnswer(result, form.userId);
}
