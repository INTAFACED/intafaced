import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { loadNotifyConfig } from '@/lib/notify/config-server';

/**
 * Notify channel and template settings (read-only). svc-notify's owner settings as the signed-in founder. There is no
 * POST: a change needs a second person's approval and this console does not carry that request for these settings.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('notify');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json(await loadNotifyConfig(session), { headers: { 'cache-control': 'no-store' } });
}
