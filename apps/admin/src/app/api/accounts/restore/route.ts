import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { restoreExecute } from '@/lib/accounts/restore';
import { handleStep } from '@/lib/desk/step-route';

/**
 * Lifting a staff freeze on one account (J-ops-console-04 #6). POST runs one step of a two-founder request: the first
 * founder proposes at identity, a different person approves the same account, version and reason, and identity's
 * restore spends the approval once. A founder alone, or approving their own request, is refused by identity.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, { kinds: ['identity.account.unfreeze'], check: () => null, execute: restoreExecute(session) });
}
