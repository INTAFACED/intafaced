import { adminBffSession } from '@/lib/admin-bff-gate';
import { loadConsoleMode, consoleModeExecute } from '@/lib/console-mode/server';
import { handleStep } from '@/lib/desk/step-route';

/**
 * Maintenance mode (OPS-admin-access-08). GET reads the mode in force from svc-ops. POST runs one step of the two-founder
 * change: identity issues the approval, a different founder approves it, and svc-ops spends it once when the mode changes.
 *
 * Always on (no module gate), like `/api/session`, and open while the mode is on (`READ_ONLY_EXEMPT_PATHS`): a console that
 * could not reach this door could never be made writable again.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json(await loadConsoleMode(session), { headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: Request) {
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, {
    kinds: ['ops.console_mode.on', 'ops.console_mode.off'],
    check: () => null,
    execute: consoleModeExecute(session),
  });
}
