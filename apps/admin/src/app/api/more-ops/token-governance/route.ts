import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { handleStep } from '@/lib/desk/step-route';
import { governanceExecute } from '@/lib/token-governance/server';

/**
 * Token governance (J-more-catalogue-10). POST runs one step of a two-founder request: the voting delay and period, or one
 * account's governance role. svc-token refuses what it would refuse before spending the approval, spends it once, and
 * refuses the approver as the one who runs it.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('more-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, {
    kinds: ['token.governance.settings.set', 'token.governance.role.set'],
    check: () => null,
    execute: governanceExecute(session),
  });
}
