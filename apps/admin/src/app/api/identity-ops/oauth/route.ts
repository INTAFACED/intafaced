import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { moduleDisabledResponse } from '@/lib/modules';
import { isReviewStatus, readReviewRequest, statusAfter } from '@/lib/oauth-ops/model';
import { explainOAuthFailure } from '@/lib/oauth-ops/refusal';
import { loadOAuthQueue, reviewOAuthApp } from '@/lib/oauth-ops/server';

/**
 * OAuth app approval queue (DV-oauth-01). GET reads the apps in one status, oldest first. POST approves or suspends ONE app.
 *
 * Runs as the signed-in founder: svc-identity takes the reviewer from the verified session and requires the compliance
 * permission and a second factor, and it refuses the developer approving their own app. A decision is one person's call, so
 * the console adds friction (a written reason, and the app name typed back to approve) and an audit line naming the founder.
 * It reports done only when the app svc-identity returns holds the status that was asked for.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('identity-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const status = new URL(request.url).searchParams.get('status') ?? 'pending';
  if (!isReviewStatus(status)) return Response.json({ code: 'admin.oauth_status' }, { status: 400, headers: NO_STORE });
  return Response.json(await loadOAuthQueue(session, status), { headers: NO_STORE });
}

const INVALID = {
  ok: false,
  refusal: {
    title: 'That request was not accepted',
    body: 'A decision names one app, approve or suspend, and a written reason of 12 to 500 characters. Nothing was sent.',
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

  let raw: Record<string, unknown>;
  try {
    raw = await readAdminJson(request);
  } catch (error) {
    return adminSessionErrorResponse(error instanceof AdminSessionError ? error : new AdminSessionError('admin.json_required', 400));
  }
  const review = readReviewRequest(raw);
  if (!review) return Response.json(INVALID, { status: 400, headers: NO_STORE });

  const result = await reviewOAuthApp(session, review);
  // The audit line names who decided what for which app. It never carries the words the founder wrote.
  console.warn(
    JSON.stringify({
      audit: `admin.oauth_app_${review.decision}`,
      at: new Date().toISOString(),
      founder: session.session.userId,
      appId: review.appId,
      outcome: result.kind,
    }),
  );
  if (result.kind === 'ok') {
    if (result.data.id !== review.appId || result.data.status !== statusAfter(review.decision)) {
      return Response.json(
        { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) },
        { status: 502, headers: NO_STORE },
      );
    }
    return Response.json({ ok: true, appId: result.data.id, status: result.data.status }, { headers: NO_STORE });
  }
  const status = result.kind === 'forbidden' ? (result.refusal.status === 401 ? 401 : 403) : result.kind === 'refused' ? 409 : 502;
  return Response.json({ ok: false, refusal: explainOAuthFailure(result) }, { status, headers: NO_STORE });
}
