'use client';

import { ControlDesk, type ControlAction } from '@/components/control-desk';
import { UUID } from '@/lib/approval-fields';
import { rowText } from '@/lib/ops-desk/actions-model';
import type { Row } from '@/lib/ops-desk/types';
import './desk.css';

/** Why no approval can be asked for on this case, or null when it waits and names a verification identity can be asked about. */
export function kycApproveHold(recordId: string | null, state: string): string | null {
  if (recordId === null || !UUID.test(recordId))
    return 'This case names no verification id the console can ask identity about, so no approval can be asked for here.';
  if (state !== 'submitted')
    return `Only a verification that waits for review can be approved. This one is ${state === '' ? 'in a state this console does not act on' : state}.`;
  return null;
}

/**
 * Approve one verification from its case row (I-kyc-compliance-07). Only a case that waits for review ("submitted") can be asked
 * for; you ask, a different founder approves that verification, and you run it. Identity refuses if either of you is the person.
 * The workbench stays on every row, so a pending approval can still be approved, rejected, withdrawn or run whatever the row says.
 */
export function KycApprove({ row, userId, onChanged }: { row: Row; userId: string; onChanged: () => void }) {
  const recordId = rowText(row, 'recordId');
  const state = rowText(row, 'state') ?? '';
  const tier = rowText(row, 'tier') ?? '';
  const hold = kycApproveHold(recordId, state);
  const action: ControlAction = {
    heading: 'Approve this verification',
    submitLabel: 'Ask a second founder to approve this verification',
    needsReason: false,
    reasonLabel: '',
    build: () => ({ kind: 'identity.kyc.approve', recordId: recordId ?? '' }),
    danger: false,
  };
  return (
    <div className="dk-stack" data-testid="kyc-approve">
      <ControlDesk
        key={recordId ?? ''}
        endpoint="/api/accounts/kyc-approve"
        userId={userId}
        blockedReason={null}
        formHold={hold}
        action={action}
        consequence={`Identity marks this verification approved${tier === '' ? '' : ` at level ${tier}`}, and the capabilities the owner maps to that level go active at once; with no mapping set it grants none. A different founder has to approve this verification first; the approval names you both, and identity refuses if either of you is the person. Identity needs the compliance permission on your session and a verified second factor, and refuses in words if either is missing.`}
        blockedButtonLabel="Approval unavailable"
        onChanged={onChanged}
      />
    </div>
  );
}
