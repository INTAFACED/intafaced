import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { handleStep } from '@/lib/desk/step-route';
import { decodeRunExecute } from '@/lib/ledger/reconciliation-run';
import { sendTreasuryControl, treasuryParked } from '@/lib/ledger/reconciliation-server';

/**
 * Run one reconciliation control now or at a past instant (J-ops-console-07 steps 3-4, OPS-reconciliation-01).
 *
 * A TWO-FOUNDER request like the posting freeze: one founder proposes a run bound to the control's version, its instant, its
 * margin and the reason; a different founder approves exactly that; the run step goes to svc-edge on the treasury transport
 * and svc-ledger spends the approval once. svc-ledger stores the result row before it reads, so a reply lost on the way back
 * is not a lost run: the same approval returns the stored run.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;

  return handleStep(request, session, {
    kinds: ['ledger.reconciliation_control.run'],
    check() {
      const parked = treasuryParked();
      if (!parked) return null;
      return { refusal: { ...explainRefusal('admin.ledger_unconfigured', 503, false), body: parked }, status: 503 };
    },
    async execute(req, ids) {
      if (req.kind !== 'ledger.reconciliation_control.run')
        return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
      const answer = await sendTreasuryControl('run', {
        controlId: req.controlId,
        ...(req.asOf === 'now' ? {} : { asOf: req.asOf, margin: req.margin }),
        reason: req.reason,
        approvalId: ids.approvalId,
        operationId: ids.operationId,
      });
      return decodeRunExecute(answer, req.controlId);
    },
  });
}
