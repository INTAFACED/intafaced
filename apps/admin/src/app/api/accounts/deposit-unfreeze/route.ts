import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { depositUnfreezeExecute } from '@/lib/deposit-freezes/server';
import { handleStep } from '@/lib/desk/step-route';

/**
 * Lifting a compliance freeze on one deposit address (J-wallet-03 #4). POST runs one step of a two-founder request: the first
 * founder proposes at identity, a different founder approves the same freeze, address and reason, and svc-pay's unfreeze spends
 * the approval once, refuses its approver as the one who runs it, and credits each held deposit once.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, {
    kinds: ['pay.deposit_address.unfreeze'],
    check: () => null,
    execute: depositUnfreezeExecute(session),
  });
}
