import 'server-only';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { handleStep } from '@/lib/desk/step-route';
import { moduleDisabledResponse } from '@/lib/modules';
import { DESKS } from './catalog';
import { opsExecute } from './execute';
import { loadDesk } from './server';
import type { OpsDeskId } from './types';

/**
 * The shared body of the four module-desk BFFs. Each route file only names its desk (and, if it has actions, the
 * request kinds it accepts), so the gate, the session, the read and the two-founder steps are written once.
 *
 * GET reads the desk as the signed-in founder. POST (only where a desk has actions) runs one step of a two-founder
 * request, exactly as `/api/kill-switch` does. A desk with no actions has no POST at all: it cannot change anything.
 */

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function deskGet(request: Request, deskId: OpsDeskId): Promise<Response> {
  const disabled = moduleDisabledResponse(DESKS[deskId].module);
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json(await loadDesk(session, deskId), { headers: NO_STORE });
}

export async function deskPost(request: Request, deskId: OpsDeskId, kinds: readonly string[]): Promise<Response> {
  const disabled = moduleDisabledResponse(DESKS[deskId].module);
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, { kinds, check: () => null, execute: opsExecute(session) });
}
