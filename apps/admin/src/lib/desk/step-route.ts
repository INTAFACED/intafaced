import 'server-only';
import { readAdminJson } from '@/lib/admin-json';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { auditLine, parseStepBody, runStep, type ExecuteFn, type StepBody, type StepReply } from './approval-steps';
import type { FounderCallContext } from './founder-call';
import { explainRefusal, type RefusalView } from './refusal-copy';

/**
 * The shared body of the two approval BFFs (`/api/kill-switch`, `/api/ledger-freeze`). Each route supplies the
 * checks and the executor that belong to its target; everything else (session, body limits, typed phrase, identity
 * steps, audit line, status mapping) is here once so the two cannot drift apart.
 */

const NO_STORE = { 'cache-control': 'no-store' } as const;

export function stepResponse(reply: StepReply): Response {
  const status = reply.ok ? 200 : reply.refusal.changed === 'unknown' ? 502 : 409;
  return Response.json(reply, { status, headers: NO_STORE });
}

export function refusalResponse(step: StepBody['step'], refusal: RefusalView, status: number): Response {
  return Response.json({ ok: false, step, refusal }, { status, headers: NO_STORE });
}

export interface StepRouteOptions {
  /** Request kinds this route accepts. */
  readonly kinds: readonly string[];
  /** Pre-dispatch refusal for a parsed step (unconfigured console, module that must not be armed), or null. */
  readonly check: (body: StepBody) => { refusal: RefusalView; status: number } | null;
  /**
   * Optional pre-dispatch refusal that needs a read of the target first (the staff desk asks svc-identity whether it serves
   * the roster before an approval is proposed). Runs after `check`, never for reject or withdraw.
   */
  readonly precheck?: (body: StepBody) => Promise<{ refusal: RefusalView; status: number } | null>;
  readonly execute: ExecuteFn;
}

export async function handleStep(request: Request, ctx: FounderCallContext, options: StepRouteOptions): Promise<Response> {
  let raw: Record<string, unknown>;
  try {
    raw = await readAdminJson(request);
  } catch (error) {
    return adminSessionErrorResponse(error instanceof AdminSessionError ? error : new AdminSessionError('admin.json_required', 400));
  }
  const parsed = parseStepBody(raw);
  if (!parsed.ok) {
    return Response.json(
      {
        ok: false,
        step: typeof raw.step === 'string' ? raw.step : null,
        refusal: {
          title: 'That request was not accepted',
          body: parsed.error,
          next: 'Nothing was sent. Check the fields and try again.',
          code: 'admin.request_invalid',
          changed: 'no',
        } satisfies RefusalView,
      },
      { status: 400, headers: NO_STORE },
    );
  }
  const body = parsed.body;
  if (body.request && !options.kinds.includes(body.request.kind)) {
    return refusalResponse(body.step, explainRefusal('admin.request_invalid', 400, false), 400);
  }
  // Reject and withdraw name an approval by id only, so without the packet's request any desk could cancel any other desk's
  // approval (a ledger freeze, say). They must carry the request, and it was checked against this route's kinds above.
  if ((body.step === 'reject' || body.step === 'revoke') && body.request === null) {
    return refusalResponse(body.step, explainRefusal('admin.request_invalid', 400, false), 400);
  }
  // Undoing (reject, withdraw) is never blocked by deployment state: it only ever removes a pending approval.
  if (body.step !== 'reject' && body.step !== 'revoke') {
    const blocked = options.check(body) ?? (options.precheck ? await options.precheck(body) : null);
    if (blocked) return refusalResponse(body.step, blocked.refusal, blocked.status);
  }
  const reply = await runStep(ctx, body, options.execute);
  console.warn(auditLine(ctx, body, reply));
  return stepResponse(reply);
}
