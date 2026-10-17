'use client';

import { useState } from 'react';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import type { VendorDecision } from '@/lib/desk/approval-packet';
import { ambassadorVerb, rowText, vendorDecisions } from '@/lib/ops-desk/actions-model';
import type { Row } from '@/lib/ops-desk/types';
import './desk.css';

/**
 * The two-founder actions a desk row can carry. Each is the same flow as a module kill or a ledger freeze: a reason and
 * a typed phrase, a request packet for a DIFFERENT founder, their approval at identity, and a run that the owning
 * service checks and spends once. The row's status is read again afterwards; this page never changes it by itself.
 */

const DECISION_COPY: Record<VendorDecision, { label: string; consequence: string; danger: boolean }> = {
  approved: {
    label: 'Approve',
    consequence: 'The vendor can be listed and sell in the market.',
    danger: false,
  },
  rejected: {
    label: 'Reject',
    consequence: 'The application is closed and the vendor is not listed.',
    danger: true,
  },
  suspended: {
    label: 'Suspend',
    consequence: 'The vendor is taken out of the market. They can be approved again later.',
    danger: true,
  },
};

const TWO_PEOPLE =
  'Two different operators must agree; this console admits only founders, but identity also accepts other operators on the approval, so check who approved below. The owning service needs the operator permission on your session and a verified second factor, and refuses in words if it is missing.';

export function VendorActions({ row, userId, onChanged }: { row: Row; userId: string; onChanged: () => void }) {
  const vendorId = rowText(row, 'id');
  const status = rowText(row, 'status') ?? '';
  const options = vendorDecisions(status);
  const [choice, setChoice] = useState<VendorDecision | null>(null);
  const decision = choice !== null && options.includes(choice) ? choice : (options[0] ?? null);
  if (vendorId === null || decision === null) {
    return (
      <p className="dk-muted" data-testid="vendor-no-action">
        A vendor whose application was rejected has no decision to take here.
      </p>
    );
  }
  const copy = DECISION_COPY[decision];
  const action: ControlAction = {
    heading: `${copy.label} this vendor`,
    submitLabel: `Ask a second operator to approve: ${copy.label.toLowerCase()} (this console admits only founders)`,
    needsReason: true,
    reasonLabel: 'Why (kept in the vendor’s audit trail, 12 to 500 characters)',
    build: (reason) => ({ kind: 'market.vendor.vet', vendorId, decision, reason }),
    danger: copy.danger,
  };
  return (
    <div className="dk-stack" data-testid="vendor-actions">
      {options.length > 1 && (
        <div className="dk-row" role="group" aria-label="Decision">
          {options.map((o) => (
            <button key={o} type="button" className="adm-btn" aria-pressed={decision === o} onClick={() => setChoice(o)}>
              {DECISION_COPY[o].label}
            </button>
          ))}
        </div>
      )}
      <ControlDesk
        key={`${vendorId}:${decision}`}
        endpoint="/api/more-ops"
        userId={userId}
        blockedReason={null}
        action={action}
        consequence={`${copy.consequence} ${TWO_PEOPLE}`}
        blockedButtonLabel="Decision unavailable"
        onChanged={onChanged}
      />
    </div>
  );
}

export function AmbassadorActions({ row, userId, onChanged }: { row: Row; userId: string; onChanged: () => void }) {
  const ambassadorId = rowText(row, 'userId');
  const verb = ambassadorVerb(rowText(row, 'status') ?? '');
  if (ambassadorId === null || verb === null) {
    return (
      <p className="dk-muted" data-testid="ambassador-no-action">
        The service gave this ambassador a status this console does not act on.
      </p>
    );
  }
  const action: ControlAction =
    verb === 'freeze'
      ? {
          heading: 'Freeze this ambassador',
          submitLabel: 'Ask a second operator to approve the freeze (this console admits only founders)',
          needsReason: true,
          reasonLabel: 'Why (kept with the freeze, 12 to 500 characters)',
          build: (reason) => ({ kind: 'academy.ambassador.freeze', userId: ambassadorId, reason }),
          danger: true,
        }
      : {
          heading: 'Lift this ambassador’s freeze',
          submitLabel: 'Ask a second operator to approve lifting the freeze (this console admits only founders)',
          needsReason: false,
          reasonLabel: '',
          build: () => ({ kind: 'academy.ambassador.unfreeze', userId: ambassadorId }),
        };
  return (
    <div className="dk-stack" data-testid="ambassador-actions">
      <ControlDesk
        key={`${ambassadorId}:${verb}`}
        endpoint="/api/academy-ops"
        userId={userId}
        blockedReason={null}
        action={action}
        consequence={`${verb === 'freeze' ? 'The ambassador stops holding the role until the freeze is lifted.' : 'The ambassador holds the role again.'} ${TWO_PEOPLE}`}
        blockedButtonLabel="Freeze unavailable"
        onChanged={onChanged}
      />
    </div>
  );
}
