import { adminBffSession } from '@/lib/admin-bff-gate';
import { handleStep } from '@/lib/desk/step-route';
import { identityKeysExecute, loadKeys } from '@/lib/identity-ops/keys-server';
import { moduleDisabledResponse } from '@/lib/modules';

/**
 * Founder signing-key rotation (I-signin-sessions-31). GET reads the key ids svc-identity holds (never key material).
 * POST runs one step of a two-founder request, exactly as `/api/kill-switch` does: identity issues the approval, a different
 * founder signs it, and svc-identity spends it once when the change runs.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('identity-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json(await loadKeys(session), { headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('identity-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, {
    kinds: ['identity.auth_key.rotate', 'identity.auth_key.remove_old'],
    check: () => null,
    execute: identityKeysExecute(session),
  });
}
