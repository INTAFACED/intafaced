import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { IMPORT_MAX, IMPORT_SOURCE_PATTERN, SUBSCRIBER_STATES, type SubscriberState } from '@/lib/notify/subscribers-model';
import { importSubscribers, loadSubscriberDesk, resendNotice, setSafeguards } from '@/lib/notify/subscribers-server';

/**
 * The subscriber desk.
 *
 *   GET ?state=<unconfirmed|active|unsubscribed>&notice=<id>   channels, subscribers, published notices, safeguards,
 *                                                              and the delivery rows of the chosen notice
 *   POST { op: 'resend', noticeId }                           run that notice's fan-out again (no row is doubled)
 *   POST { op: 'import', source, emails }                     add addresses from another list, keyed by address
 *   POST { op: 'safeguards', challengeBits, subscribeRatePerHour, expectedRevision, reason }
 *
 * Founder-only. svc-notify records the founder from their own token. No money moves.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const incomplete = (body: string) =>
  Response.json(
    {
      ok: false,
      title: 'That request is not complete',
      body,
      next: 'Nothing was changed. Correct it and try again.',
      code: null,
      changed: 'no',
    },
    { status: 400, headers: NO_STORE },
  );

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const intOrNull = (v: unknown, min: number, max: number): number | null | undefined =>
  v === null ? null : Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : undefined;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('notify');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const url = new URL(request.url);
  const stateParam = url.searchParams.get('state');
  const notice = url.searchParams.get('notice');
  const state = (SUBSCRIBER_STATES as readonly string[]).includes(stateParam ?? '') ? (stateParam as SubscriberState) : null;
  const noticeId = notice && UUID.test(notice) ? notice : null;
  return Response.json(await loadSubscriberDesk(session, { state, noticeId }), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('notify');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    const send = ({ status, reply }: { status: number; reply: unknown }) => Response.json(reply, { status, headers: NO_STORE });
    switch (body.op) {
      case 'resend':
        if (!UUID.test(str(body.noticeId))) return incomplete('Which notice?');
        return send(await resendNotice(session, str(body.noticeId)));
      case 'import': {
        const source = str(body.source).trim();
        const emails = Array.isArray(body.emails) && body.emails.every((e) => typeof e === 'string') ? (body.emails as string[]) : null;
        if (!IMPORT_SOURCE_PATTERN.test(source)) return incomplete('Name the source in lowercase letters, digits and dashes (up to 40).');
        if (!emails || emails.length === 0 || emails.length > IMPORT_MAX) return incomplete(`An import is 1 to ${IMPORT_MAX} addresses.`);
        return send(await importSubscribers(session, source, emails));
      }
      case 'safeguards': {
        const challengeBits = intOrNull(body.challengeBits, 1, 32);
        const subscribeRatePerHour = intOrNull(body.subscribeRatePerHour, 1, 1000);
        const reason = str(body.reason).trim();
        if (challengeBits === undefined || subscribeRatePerHour === undefined)
          return incomplete('The challenge strength is 1 to 32 bits and the rate limit 1 to 1000 a hour, or blank.');
        if (!Number.isInteger(body.expectedRevision) || reason === '' || reason.length > 500)
          return incomplete('Say why, and save from the revision you read.');
        return send(
          await setSafeguards(session, { challengeBits, subscribeRatePerHour, expectedRevision: body.expectedRevision as number, reason }),
        );
      }
      default:
        return incomplete('Unknown action.');
    }
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
