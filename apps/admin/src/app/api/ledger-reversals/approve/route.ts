import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { handleStep } from '@/lib/desk/step-route';
import { reversalExecute, reversalWritesParked } from '@/lib/ledger-reversals';

/**
 * The two-founder steps of one reversal request (J-ops-console-05 #1, #2, OPS-ledger-desk-02).
 *
 * The founder who asked proposes at identity, bound to svc-ops' intent row, the original, the reason and the case reference
 * (governed type `ops.ledger.reverse`); a different founder approves exactly that; the founder who asked runs it on the treasury
 * transport, and svc-ops spends the approval once and asks the ledger. Identity refuses the requester approving their own request
 * (`action_approval.same_person`).
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, {
    kinds: ['ops.ledger.reverse'],
    // svc-ops runs a request only for the founder who asked for it, recorded as the treasury credential's holder, so only the
    // holder proposes or runs. Approving goes to identity as the second founder, who never holds it.
    check: (body) => {
      if (body.step !== 'propose' && body.step !== 'execute') return null;
      const parked = reversalWritesParked(session);
      return parked ? { refusal: parked, status: 409 } : null;
    },
    execute: reversalExecute(session),
  });
}
