'use client';

import { useState } from 'react';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import { SELFIE_DECISIONS, UUID, type SelfieDecision } from '@/lib/desk/approval-packet';
import { rowText } from '@/lib/ops-desk/actions-model';
import type { Row } from '@/lib/ops-desk/types';
import './desk.css';

const SELFIE_COPY: Record<SelfieDecision, { label: string; consequence: string; danger: boolean }> = {
  accepted: { label: 'Accept', consequence: 'Identity records the selfie as accepted: it matches the ID photo.', danger: false },
  rejected: {
    label: 'Reject',
    consequence: 'Identity records the selfie as rejected; the person can take a new one.',
    danger: true,
  },
};

/** Why no new decision can be asked for on this row, or null when the selfie waits and has an id identity can be asked about. */
export function selfieDecideHold(selfieId: string | null, status: string): string | null {
  if (selfieId === null || !UUID.test(selfieId))
    return 'This row has no selfie id the console can ask identity about, so no decision can be asked for here.';
  if (status !== 'provided')
    return `Only a selfie that still waits for comparison can be decided. This one is ${status === '' ? 'in a status this console does not act on' : status}.`;
  return null;
}

/**
 * Decide one selfie from a list row (I-kyc-compliance-09). Compare it first: its photo is the document named in the row, opened
 * from the identity documents list. Only a selfie still waiting ("provided") can be asked for; you ask, a different founder
 * approves that selfie and that decision, and you run it. Identity refuses if either of you is the person. The workbench stays
 * on every row, so a pending approval can still be approved, rejected, withdrawn or run whatever the row now says.
 */
export function KycSelfieDecide({ row, userId, onChanged }: { row: Row; userId: string; onChanged: () => void }) {
  const selfieId = rowText(row, 'id');
  const status = rowText(row, 'status') ?? '';
  const [choice, setChoice] = useState<SelfieDecision>('accepted');
  const hold = selfieDecideHold(selfieId, status);
  const copy = SELFIE_COPY[choice];
  const action: ControlAction = {
    heading: `${copy.label} this selfie`,
    submitLabel: `Ask a second founder to approve: ${copy.label.toLowerCase()} the selfie`,
    needsReason: false,
    reasonLabel: '',
    build: () => ({ kind: 'identity.kyc_selfie.decide', selfieId: selfieId ?? '', decision: choice }),
    danger: copy.danger,
  };
  return (
    <div className="dk-stack" data-testid="kyc-selfie-decide">
      {hold === null && (
        <div className="dk-row" role="group" aria-label="Decision">
          {SELFIE_DECISIONS.map((o) => (
            <button key={o} type="button" className="adm-btn" aria-pressed={choice === o} onClick={() => setChoice(o)}>
              {SELFIE_COPY[o].label}
            </button>
          ))}
        </div>
      )}
      <ControlDesk
        key={selfieId ?? ''}
        endpoint="/api/accounts/selfies"
        userId={userId}
        blockedReason={null}
        formHold={hold}
        action={action}
        consequence={`${copy.consequence} A different founder has to approve this selfie and this decision first; the approval names you both, and identity refuses if either of you is the person. Identity needs the compliance permission on your session and a verified second factor, and refuses in words if either is missing.`}
        blockedButtonLabel="Decision unavailable"
        onChanged={onChanged}
      />
    </div>
  );
}
