import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { loadNotify } from '@/lib/notify/server';

/**
 * Notification delivery health (read-only). svc-notify's operator delivery outcomes and its health, as the signed-in
 * founder. There is no POST: this desk cannot resend, retry or mute anything, and says so.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('notify');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json(await loadNotify(session), { headers: { 'cache-control': 'no-store' } });
}
