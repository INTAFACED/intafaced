import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { handleStep } from '@/lib/desk/step-route';
import { decodeLifecycleExecute } from '@/lib/ledger/reconciliation-run';
import { sendTreasuryControl, treasuryParked } from '@/lib/ledger/reconciliation-server';

/**
 * Pause, resume or retire one reconciliation control (J-ops-console-07 step 5, OPS-reconciliation-02).
 *
 * A TWO-FOUNDER request like a run: one founder proposes the move bound to the control's version and the reason; a different
 * founder approves exactly that; the move step goes to svc-edge on the treasury transport as an update carrying the approval,
 * and svc-ledger spends it once under the control's row lock.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;

  return handleStep(request, session, {
    kinds: ['ledger.reconciliation_control.lifecycle'],
    check() {
      const parked = treasuryParked();
      if (!parked) return null;
      return { refusal: { ...explainRefusal('admin.ledger_unconfigured', 503, false), body: parked }, status: 503 };
    },
    async execute(req, ids) {
      if (req.kind !== 'ledger.reconciliation_control.lifecycle')
        return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
      const answer = await sendTreasuryControl('update', {
        controlId: req.controlId,
        reason: req.reason,
        lifecycle: req.lifecycle,
        approvalId: ids.approvalId,
        operationId: ids.operationId,
      });
      return decodeLifecycleExecute(answer, req.controlId, req.lifecycle);
    },
  });
}
