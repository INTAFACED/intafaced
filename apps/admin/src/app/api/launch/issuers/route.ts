import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { handleStep } from '@/lib/desk/step-route';
import { launchLensExecute } from '@/lib/launch-issuers/server';

/**
 * The launch issuer lens (J-more-catalogue-14). POST runs one step of a two-founder request: an issuer review step, a new
 * launch draft, or a launch move. svc-token refuses anything it would refuse before spending the approval, spends it once,
 * and refuses the approver as the one who runs it.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('launch');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, {
    kinds: ['token.launch.issuer.set', 'token.launch.event.create', 'token.launch.event.move'],
    check: () => null,
    execute: launchLensExecute(session),
  });
}
