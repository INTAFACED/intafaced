import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { haltPhrase } from '@/lib/pay-halts/model';
import { loadPayHalts, readSetBody, setHalt } from '@/lib/pay-halts/server';

/**
 * Pay halts: read them, stop an operation, and clear a halt with a second founder.
 *
 * Runs as the signed-in founder: svc-pay checks the caller is a live founder itself and records which one. The
 * rules that matter live in svc-pay and are surfaced here, not re-invented:
 *   - a halt is one founder and immediate (the fast stop);
 *   - clearing takes two different founders: the first answers `pending_confirmation`, a different founder repeating
 *     the same request applies it.
 * The console adds typed confirmation and a written reason (checked here as well as in the page), and reports
 * exactly what svc-pay answered. The page then re-reads; it never advances a state itself.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json(await loadPayHalts(session), { headers: NO_STORE });
}

const ACTIONS = ['halt', 'clear', 'confirm_clear'] as const;

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;

  let raw: Record<string, unknown>;
  try {
    raw = await readAdminJson(request);
  } catch (error) {
    return adminSessionErrorResponse(error instanceof AdminSessionError ? error : new AdminSessionError('admin.json_required', 400));
  }
  const action = ACTIONS.find((a) => a === raw.action);
  const halted = action === 'halt';
  const body = action
    ? readSetBody({
        requestId: raw.requestId,
        scope: raw.scope,
        target: raw.target,
        halted,
        reason: typeof raw.reason === 'string' ? raw.reason.trim() : raw.reason,
        expectedVersion: raw.expectedVersion,
      })
    : null;
  if (!action || !body) {
    return Response.json(
      {
        ok: false,
        refusal: {
          title: 'That request was not accepted',
          body: 'Check the operation, the target, the version and that the reason is 12 to 500 characters. Nothing was sent.',
          next: 'Fix the fields and try again.',
          code: 'admin.request_invalid',
          changed: 'no',
        },
      },
      { status: 400, headers: NO_STORE },
    );
  }
  if (raw.confirm !== haltPhrase(body.scope, body.halted)) {
    return Response.json(
      {
        ok: false,
        refusal: {
          title: 'The confirmation phrase did not match',
          body: `Type ${haltPhrase(body.scope, body.halted)} exactly. Nothing was sent.`,
          next: 'Type it again.',
          code: 'admin.request_invalid',
          changed: 'no',
        },
      },
      { status: 400, headers: NO_STORE },
    );
  }

  const result = await setHalt(session, body);
  const outcome = result.kind === 'ok' ? result.data.outcome : result.kind;
  console.warn(
    JSON.stringify({
      audit: 'admin.pay_halt',
      at: new Date().toISOString(),
      founder: session.session.userId,
      action,
      scope: body.scope,
      target: body.target.level,
      requestId: body.requestId,
      outcome,
    }),
  );
  if (result.kind === 'ok') {
    const { requestId, outcome: answered, state } = result.data;
    return Response.json(
      {
        ok: true,
        requestId,
        outcome: answered,
        action,
        state: { scope: state.scope, target: state.target, halted: state.halted, version: state.version },
      },
      { headers: NO_STORE },
    );
  }
  if (result.kind === 'unavailable') {
    return Response.json({ ok: false, refusal: explainRefusal(null, 503, result.uncertain) }, { status: 502, headers: NO_STORE });
  }
  if (result.kind === 'forbidden' || result.kind === 'refused') {
    return Response.json(
      { ok: false, refusal: explainRefusal(result.refusal.code, result.refusal.status) },
      { status: result.refusal.status >= 500 ? 502 : 409, headers: NO_STORE },
    );
  }
  return Response.json(
    { ok: false, refusal: { ...explainRefusal(null, 502, true), body: 'svc-pay answered in a way this console cannot read.' } },
    { status: 502, headers: NO_STORE },
  );
}
