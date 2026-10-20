import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { OUT_OF_APP_CHANNELS, checkReleaseReason, isRecipientState, type RecipientChannel } from '@/lib/notify/recipients-model';
import { loadRecipients, releaseRecipient } from '@/lib/notify/recipients-server';

/**
 * Notify recipient health.
 *
 *   GET  ?state=quarantined|unconfirmed|active   one page of addresses in that state (masked by svc-notify)
 *   POST { userId, channel, quarantinedAt, reason }   lift one quarantine
 *
 * Founder-only. A release is one founder's action with a written reason: svc-notify records the founder from their own token,
 * keeps the reason in an immutable audit table and replays the same release as a no-op. It sends nothing itself; it only lets the
 * next notification try that address again. No money moves.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const isoRe = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('notify');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const state = new URL(request.url).searchParams.get('state');
  if (!isRecipientState(state)) return Response.json({ error: 'state_invalid' }, { status: 400, headers: NO_STORE });
  return Response.json(await loadRecipients(session, state), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('notify');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
    const channel = body.channel;
    const quarantinedAt = typeof body.quarantinedAt === 'string' ? body.quarantinedAt : '';
    const reason = checkReleaseReason(typeof body.reason === 'string' ? body.reason : '');
    if (
      userId === '' ||
      userId.length > 64 ||
      typeof channel !== 'string' ||
      !(OUT_OF_APP_CHANNELS as readonly string[]).includes(channel) ||
      !isoRe.test(quarantinedAt) ||
      !reason.ok
    )
      return Response.json(
        {
          ok: false,
          title: 'That release request is not complete',
          body: reason.ok ? 'The person, channel or quarantine time is missing.' : reason.message,
          next: 'Nothing was changed. Fill in the reason and try again.',
          changed: 'no',
        },
        { status: 400, headers: NO_STORE },
      );
    const { status, reply } = await releaseRecipient(session, {
      userId,
      channel: channel as RecipientChannel,
      quarantinedAt,
      reason: reason.reason,
    });
    return Response.json(reply, { status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
