import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { INCIDENT_ACTIONS, changeIncident, type IncidentAction } from '@/lib/incidents/server';

/**
 * Staff incidents (OPS-oncall-02).
 *
 *   POST { action: 'declare', requestKey, title, module?, severity?, private? }
 *   POST { action: 'note' | 'invite' | 'task' | 'resolve', incidentId, requestKey, ... }
 *
 * The body goes to svc-ops as it is (less `action`); svc-ops checks every field and names what it refuses, and records the
 * person in the token as the actor. Each change carries the page's request key, so a lost reply is read back, never repeated.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function POST(request: Request) {
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const { action, ...input } = await readAdminJson(request);
    if (typeof action !== 'string' || !(INCIDENT_ACTIONS as readonly string[]).includes(action))
      return Response.json(
        {
          ok: false,
          title: 'That request is not complete',
          body: `Which change: ${INCIDENT_ACTIONS.join(', ')}?`,
          next: 'Nothing was changed.',
          code: null,
          changed: 'no',
        },
        { status: 400, headers: NO_STORE },
      );
    const { status, reply } = await changeIncident(session, action as IncidentAction, input);
    return Response.json(reply, { status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
