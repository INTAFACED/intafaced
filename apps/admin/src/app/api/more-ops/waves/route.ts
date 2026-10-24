import { adminBffSession } from '@/lib/admin-bff-gate';
import { handleStep } from '@/lib/desk/step-route';
import { loadWaves, wavesExecute } from '@/lib/campaigns-ops/waves-server';
import { moduleDisabledResponse } from '@/lib/modules';

/**
 * Waitlist waves (RC-campaigns-03). GET reads the owner's wave size, the next wave and the waves already released from
 * svc-identity. POST runs one step of a two-person release, exactly as `/api/identity-ops/keys` does: identity issues the
 * approval, a different person approves it, and svc-identity spends it once when the wave is released.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('more-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json(await loadWaves(session), { headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('more-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, {
    kinds: ['campaigns.waitlist.wave_release'],
    check: () => null,
    execute: wavesExecute(session),
  });
}
