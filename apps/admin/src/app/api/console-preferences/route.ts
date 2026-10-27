import { PREFERENCE_KEYS } from '@intafaced/contracts/ops-console-preferences';
import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { loadPreferences, setPreferences } from '@/lib/console-preferences/server';
import { adminSessionErrorResponse } from '@/lib/founder-session';

/**
 * Console preferences (OPS-admin-access-08).
 *
 *   GET                                                         the four levels for the signed-in founder and what is in force
 *   POST { level, expectedRevision, values }   replace that level's values from the revision read; blank leaves a key to the level above
 *
 * Founder-only and always on. A founder sets the organisation's values or their own, never another founder's: svc-ops
 * takes the person from the founder's token, refuses the team level by name, and refuses a save from an old read.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(request: Request) {
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json({ view: await loadPreferences(session) }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    const level = (['organisation', 'team', 'person'] as const).find((l) => l === body.level);
    const raw = body.values;
    const expectedRevision = body.expectedRevision;
    if (
      !level ||
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      !Number.isSafeInteger(expectedRevision) ||
      (expectedRevision as number) < 0
    )
      return Response.json(
        {
          ok: false,
          title: 'That request is not complete',
          body: 'Which level, which revision you read, and which values?',
          next: 'Nothing was changed.',
          code: null,
          changed: 'no',
        },
        { status: 400, headers: NO_STORE },
      );
    const given = raw as Record<string, unknown>;
    // Every key is sent: a blank or missing one leaves it to the level above. svc-ops checks each value and names a bad one.
    const values = Object.fromEntries(
      PREFERENCE_KEYS.map((k) => [k, typeof given[k] === 'string' && given[k] !== '' ? (given[k] as string).slice(0, 200) : null]),
    ) as Record<(typeof PREFERENCE_KEYS)[number], string | null>;
    const { status, reply } = await setPreferences(session, { level, expectedRevision: expectedRevision as number, values });
    return Response.json(reply, { status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
