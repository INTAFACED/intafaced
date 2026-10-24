import { isModuleId } from '@intafaced/config/modules';
import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { saveServiceRecord } from '@/lib/service-page/server';

/**
 * Service records per module (OPS-service-health-01).
 *
 *   POST { module, expectedRevision, ownerTeam, dependencies, runbook }   replace that module's record from the revision read
 *
 * Founder-only. svc-ops checks each value and names a bad one, refuses a save from an old read, and records the founder in
 * the token as the actor. Blank owner or runbook is unset. The page re-reads after every outcome, never repeats a save.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 400) : null);

export async function POST(request: Request) {
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    const { module, expectedRevision, dependencies } = body;
    if (
      typeof module !== 'string' ||
      !isModuleId(module) ||
      !Number.isSafeInteger(expectedRevision) ||
      (expectedRevision as number) < 0 ||
      !Array.isArray(dependencies) ||
      dependencies.some((d) => typeof d !== 'string')
    )
      return Response.json(
        {
          ok: false,
          title: 'That request is not complete',
          body: 'Which module, which revision you read, and its owner, dependencies and runbook?',
          next: 'Nothing was changed.',
          code: null,
          changed: 'no',
        },
        { status: 400, headers: NO_STORE },
      );
    const { status, reply } = await saveServiceRecord(session, {
      module,
      expectedRevision: expectedRevision as number,
      ownerTeam: text(body.ownerTeam),
      dependencies: (dependencies as string[]).slice(0, 64).map((d) => d.slice(0, 100)),
      runbook: text(body.runbook),
    });
    return Response.json(reply, { status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
