import { limitReviewInputSchema } from '@intafaced/contracts/api-rate-limits';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { moduleDisabledResponse } from '@/lib/modules';
import { explainLimitFailure } from '@/lib/identity-ops/limits-refusal';
import { loadLimitDesk, reviewLimit } from '@/lib/identity-ops/limits-server';

/**
 * API limit request desk (DV-limits-03). GET reads the desk. POST grants (all or part) or refuses ONE request, as the
 * signed-in founder: svc-identity takes the reviewer from the verified session, needs the support operator permission
 * and a second factor, refuses a reviewer's own key, and writes one audit entry with the decision.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('identity-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json(await loadLimitDesk(session), { headers: NO_STORE });
}

const INVALID = {
  ok: false,
  refusal: {
    title: 'That decision was not accepted',
    body: 'A decision names one request, grant with a whole number of calls a minute or refuse, and a reason of 4 to 500 characters. Nothing was sent.',
    next: 'Fix the fields and try again.',
    code: 'admin.request_invalid',
    changed: 'no',
  },
} as const;

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('identity-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  let raw: unknown;
  try {
    raw = await readAdminJson(request);
  } catch (error) {
    return adminSessionErrorResponse(error instanceof AdminSessionError ? error : new AdminSessionError('admin.json_required', 400));
  }
  const parsed = limitReviewInputSchema.safeParse(raw);
  if (!parsed.success) return Response.json(INVALID, { status: 400, headers: NO_STORE });
  const result = await reviewLimit(session, parsed.data);
  // The console's own line; svc-identity keeps the audit entry of record.
  console.warn(
    JSON.stringify({
      audit: `admin.api_limit_${parsed.data.decision}`,
      at: new Date().toISOString(),
      founder: session.session.userId,
      requestId: parsed.data.id,
      outcome: result.kind,
    }),
  );
  if (result.kind === 'ok') {
    if (result.data.id !== parsed.data.id || result.data.status === 'waiting') {
      return Response.json(
        { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) },
        { status: 502, headers: NO_STORE },
      );
    }
    return Response.json({ ok: true, request: result.data }, { headers: NO_STORE });
  }
  const status = result.kind === 'forbidden' ? (result.refusal.status === 401 ? 401 : 403) : result.kind === 'refused' ? 409 : 502;
  return Response.json({ ok: false, refusal: explainLimitFailure(result) }, { status, headers: NO_STORE });
}
