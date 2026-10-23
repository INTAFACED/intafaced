import { statusPageConfigureInputSchema, statusReadingInputSchema } from '@intafaced/contracts';
import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { configureStatusPage, loadStatusDesk, recordStatusReading } from '@/lib/notify/status-server';

/**
 * The status page desk.
 *
 *   GET                                    the definition, the page a visitor reads now, and the read time
 *   POST { op: 'configure', ...change }    replace the components and owner values from the revision read, with a reason
 *   POST { op: 'record', componentId, state, source }   one reading of one component, entered by hand; this server stamps
 *                                                       its time, never the founder's browser
 *
 * Founder-only. svc-notify records the founder from their own token; this console never names an actor. No money moves.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

const incomplete = (body: string) =>
  Response.json(
    { ok: false, title: 'That change is not complete', body, next: 'Nothing was changed. Correct it and try again.', changed: 'no' },
    { status: 400, headers: NO_STORE },
  );

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('notify');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json(await loadStatusDesk(session), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('notify');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const { op, ...rest } = await readAdminJson(request);
    if (op === 'configure') {
      const input = statusPageConfigureInputSchema.safeParse(rest);
      if (!input.success) return incomplete('The components, owner values, revision or reason are not in the shape svc-notify takes.');
      const { status, reply } = await configureStatusPage(session, input.data);
      return Response.json(reply, { status, headers: NO_STORE });
    }
    if (op === 'record') {
      const input = statusReadingInputSchema.safeParse({ ...rest, observedAt: new Date().toISOString() });
      if (!input.success) return incomplete('A reading needs a component, a state and a source.');
      const { status, reply } = await recordStatusReading(session, input.data);
      return Response.json(reply, { status, headers: NO_STORE });
    }
    return incomplete('Unknown action.');
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
