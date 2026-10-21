import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { DECISIONS, decisionPhrase } from '@/lib/custody-ops/model';
import { decideTask, loadCustodyOps, loadTask } from '@/lib/custody-ops/server';

/**
 * Custody approvals: the tasks waiting on this founder, recent tasks, one task with its timeline, and a decision.
 *
 * Runs as the signed-in founder. svc-pay checks the caller is a live founder, a registered approver and not the initiator, and
 * binds every approve or reject to the fingerprint (`payloadHash`) the approver read. The console adds a typed phrase carrying the
 * first eight characters of that fingerprint, so a decision is only sent for a payload that was on screen, and then reports what
 * svc-pay answered. The page re-reads afterwards; it never advances a state itself.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;

const invalid = (body: string) =>
  Response.json(
    {
      ok: false,
      refusal: {
        title: 'That request was not accepted',
        body,
        next: 'Fix it and try again.',
        code: 'admin.request_invalid',
        changed: 'no',
      },
    },
    { status: 400, headers: NO_STORE },
  );

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('custody-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const taskId = new URL(request.url).searchParams.get('taskId');
  if (taskId === null) return Response.json(await loadCustodyOps(session), { headers: NO_STORE });
  if (!UUID.test(taskId)) return invalid('That is not a task id.');
  const result = await loadTask(session, taskId.toLowerCase());
  if (result.kind === 'ok') return Response.json({ ok: true, task: result.data }, { headers: NO_STORE });
  if (result.kind === 'refused' || result.kind === 'forbidden')
    return Response.json(
      { ok: false, refusal: explainRefusal(result.refusal.code, result.refusal.status) },
      { status: 409, headers: NO_STORE },
    );
  return Response.json({ ok: false, refusal: explainRefusal(null, 502, false) }, { status: 502, headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('custody-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;

  let raw: Record<string, unknown>;
  try {
    raw = await readAdminJson(request);
  } catch (error) {
    return adminSessionErrorResponse(error instanceof AdminSessionError ? error : new AdminSessionError('admin.json_required', 400));
  }
  const decision = DECISIONS.find((d) => d === raw.action);
  const taskId = typeof raw.taskId === 'string' && UUID.test(raw.taskId) ? raw.taskId.toLowerCase() : null;
  const payloadHash = typeof raw.payloadHash === 'string' && HASH.test(raw.payloadHash) ? raw.payloadHash : null;
  if (!decision || !taskId || (decision !== 'cancel' && !payloadHash)) {
    return invalid('Name the action, the task and the fingerprint you read. Nothing was sent.');
  }
  // The phrase is built from the fingerprint the founder is deciding on, so it cannot be typed for another payload.
  if (raw.confirm !== decisionPhrase(decision, { payloadHash: payloadHash ?? '' })) {
    return invalid(`Type ${decisionPhrase(decision, { payloadHash: payloadHash ?? '' })} exactly. Nothing was sent.`);
  }

  const result = await decideTask(session, decision, taskId, payloadHash);
  console.warn(
    JSON.stringify({
      audit: 'admin.custody_task',
      at: new Date().toISOString(),
      founder: session.session.userId,
      action: decision,
      taskId,
      outcome: result.kind === 'ok' ? result.data.status : result.kind,
    }),
  );
  if (result.kind === 'ok') return Response.json({ ok: true, action: decision, task: result.data }, { headers: NO_STORE });
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
