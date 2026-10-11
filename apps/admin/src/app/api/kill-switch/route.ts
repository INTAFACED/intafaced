import { isModuleId } from '@intafaced/config';
import { adminBffGate } from '@/lib/admin-bff-gate';
import { readKillSwitches, setKillSwitch } from '@/lib/control-plane-client';

/**
 * The console's own kill-switch endpoint (§14.6).
 *
 * A thin server-side hop, and the thinness is the point:
 *
 *   · The operator credential stays on the server. A board that called
 *     `svc-edge` from the browser would have to ship `ADMIN_OPERATOR_TOKEN` to
 *     the browser, and a token carrying `admin:write` in a bundle is a token in
 *     everybody's devtools.
 *   · It gives §14.6's "reachable from `apps/admin`" something concrete to mean.
 *     A test that called `svc-edge` directly would prove the edge works while
 *     proving nothing about this app.
 *
 * `adminBffGate` refuses closed before either handler reaches the control plane.
 * The required deployment credential is not a substitute for per-operator SSO;
 * `apps/admin/README.md` retains that honest residual.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const gate = await adminBffGate(request);
  if (gate) return gate;
  const state = await readKillSwitches();
  return Response.json(state, { status: state.status === 'reachable' ? 200 : 503 });
}

export async function POST(request: Request) {
  const gate = await adminBffGate(request);
  if (gate) return gate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'a JSON body is required' }, { status: 400 });
  }

  const input = body as { module?: unknown; disabled?: unknown; reason?: unknown };

  // Validated here as well as at the edge. The edge is authoritative — it is the
  // thing that enforces the switch — but an operator mis-typing a module id
  // deserves the answer from the surface they are looking at.
  if (typeof input.module !== 'string' || !isModuleId(input.module)) {
    return Response.json({ error: 'module must be a known module id' }, { status: 400 });
  }
  if (typeof input.disabled !== 'boolean') {
    return Response.json({ error: 'disabled must be a boolean' }, { status: 400 });
  }
  if (typeof input.reason !== 'string' || input.reason.trim().length < 12) {
    return Response.json({ error: 'reason must be at least 12 characters — an outage nobody can explain is worse' }, { status: 400 });
  }

  const result = await setKillSwitch({ module: input.module, disabled: input.disabled, reason: input.reason.trim() });
  return Response.json(result, { status: result.ok ? 200 : result.status });
}
