import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { handleStep } from '@/lib/desk/step-route';
import { acceptExecute, alertWritesParked } from '@/lib/recon-alerts/treasury';

/**
 * Accept one reconciliation discrepancy with two founders (svc-ops `alerts.accept`, OPS-reconciliation-04, J-ops-console-07 #9).
 *
 * The first founder proposes at identity with a note and the evidence hash they read; a different founder approves that exact
 * alert, note and hash; the run goes to svc-ops on the treasury transport, which recomputes the hash from the stored evidence,
 * spends the approval once and freezes the evidence. A blank note is refused here before identity is asked, so no approval is
 * made for it.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, {
    kinds: ['ops.reconciliation_alert.accept'],
    // svc-ops spends an approval only for the founder who proposed it, and records the treasury credential's holder as that
    // founder, so only the holder may propose or run. Approving goes to identity as the second founder, who never holds it.
    check: (body) => {
      if (body.step !== 'propose' && body.step !== 'execute') return null;
      if (body.request?.kind === 'ops.reconciliation_alert.accept' && body.request.reason === '')
        return { refusal: explainRefusal('ops.resolve_note_required', 400, false), status: 400 };
      const parked = alertWritesParked(session);
      return parked ? { refusal: parked, status: 409 } : null;
    },
    execute: acceptExecute(session),
  });
}
