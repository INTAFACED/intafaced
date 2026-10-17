import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { dispositionGate, dispositionPhrase, type Disposition } from '@/lib/compliance/model';
import { disposeCase, loadCompliance } from '@/lib/compliance/server';
import { explainRefusal, type RefusalView } from '@/lib/desk/refusal-copy';

/**
 * Live compliance state and queue dispositions (svc-edge `/admin/status`, `/admin/compliance/*`).
 *
 * GET reads. POST clears or rejects ONE queue case. That is one person's decision: the edge has no second-approver
 * on this door, so the console adds friction (a written reason and the case id typed back) and a log line naming the
 * founder, and says plainly that the edge records its own credential's user, not the founder. Dual control here
 * would need a back-end change, filed in admin-BACKEND-NEEDS.md.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('jurisdiction');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json(await loadCompliance(), { headers: NO_STORE });
}

function refusal(view: RefusalView, status: number): Response {
  return Response.json({ ok: false, refusal: view }, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('jurisdiction');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;

  let raw: Record<string, unknown>;
  try {
    raw = await readAdminJson(request);
  } catch (error) {
    return adminSessionErrorResponse(error instanceof AdminSessionError ? error : new AdminSessionError('admin.json_required', 400));
  }
  const status: Disposition | null = raw.status === 'cleared' || raw.status === 'rejected' ? raw.status : null;
  const itemId = typeof raw.itemId === 'string' ? raw.itemId.trim() : '';
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (raw.action !== 'dispose' || !status || itemId === '' || itemId.length > 128) {
    return refusal(
      {
        ...explainRefusal('admin.request_invalid', 400, false),
        title: 'That request was not accepted',
        body: 'Name the case and whether to clear or reject it. Nothing was sent.',
        next: 'Fix the fields and try again.',
      },
      400,
    );
  }
  const gate = dispositionGate({ status, itemId, reason, confirm: typeof raw.confirm === 'string' ? raw.confirm : '', busy: false });
  if (!gate.ok) {
    return refusal(
      {
        ...explainRefusal('admin.request_invalid', 400, false),
        title: 'That request was not accepted',
        body: `${gate.why} Nothing was sent.`,
        next: 'Fix it and try again.',
      },
      400,
    );
  }

  const result = await disposeCase(itemId, status, reason);
  console.warn(
    JSON.stringify({
      audit: 'admin.compliance_disposition',
      at: new Date().toISOString(),
      founder: session.session.userId,
      itemId,
      status,
      reasonLength: reason.length,
      outcome: result.kind,
    }),
  );
  if (result.kind === 'applied') {
    return Response.json({ ok: true, itemId, status, phrase: dispositionPhrase(status, itemId) }, { headers: NO_STORE });
  }
  if (result.kind === 'unconfigured') {
    return refusal({ ...explainRefusal('admin.kill_unconfigured', 503, false), body: result.detail }, 503);
  }
  if (result.kind === 'unknown') {
    return refusal(
      { ...explainRefusal(null, 502, true), body: `${result.detail} It is not known whether the case was dispositioned.` },
      502,
    );
  }
  return refusal(
    {
      title: 'svc-edge refused the disposition',
      body: result.message,
      next: 'Nothing was changed. Read the queue again.',
      code: result.code,
      changed: 'no',
    },
    409,
  );
}
