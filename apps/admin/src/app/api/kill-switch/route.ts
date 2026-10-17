import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffGate, adminBffSession } from '@/lib/admin-bff-gate';
import { readKillSwitches, setKillSwitch } from '@/lib/control-plane-client';
import { readConsoleStatus } from '@/lib/console-status';
import { decodeKillExecute } from '@/lib/desk/execute-decode';
import { killRefusalFor, moduleKillBlockedReason } from '@/lib/desk/module-kill-model';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { handleStep } from '@/lib/desk/step-route';

/**
 * The console's own kill-switch endpoint (§14.6).
 *
 * GET reads the edge's module state. POST runs one step of a TWO-FOUNDER request (propose, approve, reject,
 * withdraw, execute); there is no single-call "flip". The edge refuses a module command without an
 * identity-issued approval that a different OPERATOR signed for exactly that command, and spends it once. This console
 * admits only founders, but identity treats `edge.kill` as an operator-level action, so an operator holding another
 * permission can approve it straight at identity. The console cannot tell (identity has no approval read): filed in
 * admin-BACKEND-NEEDS.md.
 *
 * A thin server-side hop, and the thinness is the point:
 *
 *   · The operator credential stays on the server. A board that called `svc-edge` from the browser would have to ship
 *     `ADMIN_OPERATOR_TOKEN` to the browser, and a token carrying `admin:write` in a bundle is a token in everybody's
 *     devtools.
 *   · The approval steps use the SIGNED-IN FOUNDER's own session, so identity records which two people agreed (two different operators; this console admits only founders).
 *     Only `execute` uses the console's deployment credential, because that is what the edge's `admin:write` door
 *     takes; the edge's audit line therefore names that credential's user, while identity's approval row names the
 *     two founders. Both are shown on the desk.
 *
 * `adminBffSession` refuses closed before either handler reaches the control plane.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('killswitches');
  if (disabled) return disabled;
  const gate = await adminBffGate(request);
  if (gate) return gate;
  const state = await readKillSwitches();
  return Response.json(state, {
    status: state.status === 'reachable' ? 200 : state.status === 'refused' && state.httpStatus ? state.httpStatus : 503,
  });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('killswitches');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;

  return handleStep(request, session, {
    kinds: ['edge.kill'],
    check(body) {
      if (body.request?.kind !== 'edge.kill') return null;
      const refused = killRefusalFor(body.request.module);
      if (refused) return { refusal: explainRefusal(refused.code, 400, false), status: 409 };
      const blocked = moduleKillBlockedReason(readConsoleStatus());
      if (blocked) return { refusal: { ...explainRefusal('admin.kill_unconfigured', 503, false), body: blocked }, status: 503 };
      return null;
    },
    async execute(req, ids) {
      if (req.kind !== 'edge.kill') return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
      return decodeKillExecute(await setKillSwitch({ module: req.module, disabled: req.disabled, reason: req.reason }, ids));
    },
  });
}
