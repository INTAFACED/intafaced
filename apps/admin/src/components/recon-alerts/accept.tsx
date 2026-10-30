'use client';

import { useRouter } from 'next/navigation';
import { ControlDesk } from '@/components/control-desk';

/**
 * Accept a discrepancy with two founders (OPS-reconciliation-04, J-ops-console-07 #9). The request binds the alert, the note and
 * the evidence hash shown above it; svc-ops refuses if the evidence has changed by the time it runs. The treasury credential's
 * holder asks and runs; a different founder approves on their own console. The approver's workbench stays open to everyone.
 */
export function AlertAccept({
  alertId,
  evidenceHash,
  founderId,
  askBlocked,
}: {
  alertId: string;
  evidenceHash: string;
  founderId: string;
  /** Why this founder cannot ask for an acceptance here (state, cause or treasury credential), or null. */
  askBlocked: string | null;
}) {
  const router = useRouter();
  return (
    <div data-testid="alert-accept">
      <ControlDesk
        key={`accept:${alertId}`}
        endpoint="/api/ledger-reconciliation/alerts/accept"
        userId={founderId}
        blockedReason={null}
        formHold={askBlocked}
        action={{
          heading: 'Accept the discrepancy',
          submitLabel: 'Ask a second founder to approve the acceptance',
          needsReason: true,
          reasonLabel: 'Acceptance note (recorded with the alert, 12 to 500 characters)',
          build: (why) => ({ kind: 'ops.reconciliation_alert.accept', alertId, evidenceHash, reason: why }),
        }}
        consequence={`Two different founders must agree: you ask here, a different founder pastes the packet on their own console and approves it, and then you run it. The alert closes as accepted and its evidence is frozen at hash ${evidenceHash}. No balance or freeze changes and nothing is posted to the ledger.`}
        blockedButtonLabel="Accept unavailable"
        onChanged={() => router.refresh()}
      />
    </div>
  );
}
