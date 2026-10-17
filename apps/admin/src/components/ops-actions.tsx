'use client';

import { useRef, useState } from 'react';
import { StepReplyView } from '@/components/approval-workbench';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import {
  REASON_MAX,
  REASON_MIN,
  validReason,
  type CardStatus,
  type ResidencyDecision,
  type VendorDecision,
} from '@/lib/desk/approval-packet';
import type { StepReply } from '@/lib/desk/approval-types';
import { ambassadorVerb, disputeEscalationOffered, listingTakedownOffered, rowText, vendorDecisions } from '@/lib/ops-desk/actions-model';
import { postDirect } from '@/lib/ops-desk/direct-browser';
import { describeDirect, newRequestKey } from '@/lib/ops-desk/direct-model';
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

const RESIDENCY_COPY: Record<ResidencyDecision, { label: string; consequence: string; danger: boolean }> = {
  accepted: { label: 'Accept', consequence: 'The application is recorded as accepted.', danger: false },
  rejected: { label: 'Reject', consequence: 'The application is recorded as rejected.', danger: true },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Decide an open residency application. Only an application still waiting ("applied") offers a decision; the two-founder
 * request carries the application and the decision only, because that is all the service binds to the approval.
 */
export function ResidencyActions({ row, userId, onChanged }: { row: Row; userId: string; onChanged: () => void }) {
  const applicationId = rowText(row, 'id');
  const status = rowText(row, 'status') ?? '';
  const [choice, setChoice] = useState<ResidencyDecision>('accepted');
  if (applicationId === null || status !== 'applied') {
    return (
      <p className="dk-muted" data-testid="residency-no-action">
        Only an application that is still waiting can be decided here. This one is{' '}
        {status === '' ? 'in a status this console does not act on' : status}.
      </p>
    );
  }
  const copy = RESIDENCY_COPY[choice];
  const action: ControlAction = {
    heading: `${copy.label} this residency application`,
    submitLabel: `Ask a second operator to approve: ${copy.label.toLowerCase()} the application (this console admits only founders)`,
    needsReason: false,
    reasonLabel: '',
    build: () => ({ kind: 'academy.residency.decide', id: applicationId, decision: choice }),
    danger: copy.danger,
  };
  return (
    <div className="dk-stack" data-testid="residency-actions">
      <div className="dk-row" role="group" aria-label="Decision">
        {(Object.keys(RESIDENCY_COPY) as ResidencyDecision[]).map((o) => (
          <button key={o} type="button" className="adm-btn" aria-pressed={choice === o} onClick={() => setChoice(o)}>
            {RESIDENCY_COPY[o].label}
          </button>
        ))}
      </div>
      <ControlDesk
        key={`${applicationId}:${choice}`}
        endpoint="/api/academy-ops"
        userId={userId}
        blockedReason={null}
        action={action}
        consequence={`${copy.consequence} No note is sent: the approval covers the application and the decision only. ${TWO_PEOPLE}`}
        blockedButtonLabel="Decision unavailable"
        onChanged={onChanged}
      />
    </div>
  );
}

/**
 * Appoint an ambassador. The person is not in any list yet, so the founder types their user id. The control is always on the
 * page; it asks for the id first, then runs the same two-founder flow as every other Academy control.
 */
export function AppointAmbassadorAction({ userId, onChanged }: { userId: string; onChanged: () => void }) {
  const [target, setTarget] = useState('');
  const person = target.trim().toLowerCase();
  const valid = UUID.test(person);
  const action: ControlAction = {
    heading: 'Appoint this person as an ambassador',
    submitLabel: 'Ask a second operator to approve the appointment (this console admits only founders)',
    needsReason: false,
    reasonLabel: '',
    build: () => ({ kind: 'academy.ambassador.appoint', userId: person }),
  };
  return (
    <div className="dk-stack" data-testid="appoint-ambassador">
      <h3>Appoint an ambassador</h3>
      <div className="adm-field">
        <label htmlFor="appoint-user">User id of the person to appoint</label>
        <input
          id="appoint-user"
          className="adm-input"
          value={target}
          autoComplete="off"
          spellCheck={false}
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          onChange={(e) => setTarget(e.target.value)}
        />
      </div>
      <ControlDesk
        key={valid ? person : 'no-person'}
        endpoint="/api/academy-ops"
        userId={userId}
        blockedReason={null}
        formHold={valid ? null : 'Enter the person’s user id above first (it looks like 9f8e7d6c-1111-4222-8333-444455556666).'}
        action={action}
        consequence={`The person holds the ambassador role and badge. It is a status only and pays nothing. A person who is already an ambassador, active or frozen, is refused by the service. ${TWO_PEOPLE}`}
        blockedButtonLabel="Appoint unavailable"
        onChanged={onChanged}
      />
    </div>
  );
}

/**
 * Take a listing off the market. svc-market makes it permanent: nobody can set it active again, and the vendor cannot restore
 * it. Purchases already settled keep their access and nothing is refunded. The approval covers the listing AND the reason,
 * so the second founder signs exactly the words typed here.
 */
export function ListingActions({ row, userId, onChanged }: { row: Row; userId: string; onChanged: () => void }) {
  const listingId = rowText(row, 'id');
  const status = rowText(row, 'status') ?? '';
  if (listingId === null || !listingTakedownOffered(status)) {
    return (
      <p className="dk-muted" data-testid="listing-no-action">
        Only a listing that is on sale can be taken down. This one is {status === '' ? 'in a status this console does not act on' : status}.
      </p>
    );
  }
  const action: ControlAction = {
    heading: 'Take down this listing',
    submitLabel: 'Ask a second operator to approve the takedown (this console admits only founders)',
    needsReason: true,
    reasonLabel: 'Why (kept in the listing’s record and signed by the approver, 12 to 500 characters)',
    build: (reason) => ({ kind: 'market.listing.takedown', listingId, reason }),
    danger: true,
  };
  return (
    <div className="dk-stack" data-testid="listing-actions">
      <ControlDesk
        key={listingId}
        endpoint="/api/more-ops"
        userId={userId}
        blockedReason={null}
        action={action}
        consequence={`The listing leaves the market for good: nobody can set it active again and the vendor cannot restore it. Purchases already settled keep their access, and nothing is refunded. ${TWO_PEOPLE}`}
        blockedButtonLabel="Takedown unavailable"
        onChanged={onChanged}
      />
    </div>
  );
}

export const CARD_COPY: Record<CardStatus, { label: string; consequence: string; danger: boolean }> = {
  frozen: {
    label: 'Freeze',
    consequence: 'The card is frozen and its owner cannot unfreeze it; only an operator can lift it. The owner can still close it.',
    danger: true,
  },
  active: {
    label: 'Lift the freeze on',
    consequence:
      'This lifts ANY freeze on the card, including one the owner set themselves (for example after reporting the card lost). The card can be spent again at once. svc-bank does not show this console who froze it, so check with the owner first.',
    danger: true,
  },
};

/**
 * Freeze or unfreeze one card as an operator. svc-bank has no list of cards an operator can pick from, so the founder types the
 * card id (support has it from the owner's report). It is a founder-level request: identity wants both founders live. The service
 * binds the card and the status to the approval; the reason rides in the packet and is recorded with the freeze.
 */
export function CardStatusAction({ userId, onChanged }: { userId: string; onChanged: () => void }) {
  const [target, setTarget] = useState('');
  const [status, setStatus] = useState<CardStatus>('frozen');
  const card = target.trim().toLowerCase();
  const valid = UUID.test(card);
  const copy = CARD_COPY[status];
  const action: ControlAction = {
    heading: `${copy.label} this card`,
    submitLabel: `Ask the other founder to approve: ${status === 'frozen' ? 'freeze' : 'lift the freeze on'} the card`,
    needsReason: true,
    reasonLabel: `Why (kept with the card’s record, ${REASON_MIN} to ${REASON_MAX} characters)`,
    build: (reason) => ({ kind: 'bank.card.status', cardId: card, status, reason }),
    danger: copy.danger,
  };
  return (
    <div className="dk-stack" data-testid="card-status-action">
      <h3>Freeze or unfreeze a card</h3>
      <div className="adm-field">
        <label htmlFor="card-status-id">Card id</label>
        <input
          id="card-status-id"
          className="adm-input"
          value={target}
          autoComplete="off"
          spellCheck={false}
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          onChange={(e) => setTarget(e.target.value)}
        />
      </div>
      <div className="dk-row" role="group" aria-label="What to do with the card">
        {(Object.keys(CARD_COPY) as CardStatus[]).map((o) => (
          <button key={o} type="button" className="adm-btn" aria-pressed={status === o} onClick={() => setStatus(o)}>
            {o === 'frozen' ? 'Freeze' : 'Lift the freeze'}
          </button>
        ))}
      </div>
      <ControlDesk
        key={`${valid ? card : 'no-card'}:${status}`}
        endpoint="/api/bank-ops"
        userId={userId}
        blockedReason={null}
        formHold={valid ? null : 'Enter the card id above first (it looks like 9f8e7d6c-1111-4222-8333-444455556666).'}
        action={action}
        consequence={`${copy.consequence} Two different founders must agree, and identity checks both are current founders. The bank service needs the treasury permission on your session and a verified second factor, and refuses in words if it is missing. The approver signs the card and the status; the reason is recorded with the freeze but is not part of what they sign.`}
        blockedButtonLabel="Card freeze unavailable"
        onChanged={onChanged}
      />
    </div>
  );
}

/**
 * Escalate an open dispute. One moderator does this and svc-p2p asks for no second person: it marks the dispute escalated and
 * re-arms the trade deadline, moving no money. The key is kept while the reason is unchanged, so repeating a request whose reply
 * was lost cannot escalate twice.
 */
export function DisputeActions({ row, onChanged }: { row: Row; userId: string; onChanged: () => void }) {
  const disputeId = rowText(row, 'id');
  const status = rowText(row, 'status') ?? '';
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<StepReply | null>(null);
  const attempt = useRef<{ reason: string; key: string } | null>(null);
  const lock = useRef(false);
  if (disputeId === null || !disputeEscalationOffered(status)) {
    return (
      <p className="dk-muted" data-testid="dispute-no-action">
        Only an open dispute can be escalated. This one is {status === '' ? 'in a status this console does not act on' : status}.
      </p>
    );
  }
  const trimmed = reason.trim();
  const ready = validReason(trimmed) && !busy;
  async function submit() {
    if (lock.current || disputeId === null || !validReason(trimmed)) return;
    lock.current = true;
    setBusy(true);
    setReply(null);
    try {
      if (attempt.current?.reason !== trimmed) attempt.current = { reason: trimmed, key: newRequestKey() };
      const result = await postDirect('/api/p2p-ops', {
        action: 'p2p.dispute.escalate',
        disputeId,
        reason: trimmed,
        clientRequestId: attempt.current.key,
      });
      setReply(result);
      if (result.ok) {
        attempt.current = null;
        setReason('');
        onChanged();
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      className="dk-stack"
      data-testid="dispute-actions"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h4>Escalate this dispute</h4>
      <p className="dk-muted">
        {describeDirect({ action: 'p2p.dispute.escalate', disputeId, reason: '', clientRequestId: '' })} svc-p2p asks for no second person
        on an escalation. Your account must be a moderator (on the moderator list, or holding the compliance permission, and the P2P read
        permission); svc-p2p refuses in words if it is not. Ruling on the dispute is not offered here.
      </p>
      <div className="adm-field">
        <label htmlFor={`escalate-reason-${disputeId}`}>
          Why (kept with the escalation, {REASON_MIN} to {REASON_MAX} characters)
        </label>
        <textarea
          id={`escalate-reason-${disputeId}`}
          className="adm-textarea"
          rows={3}
          value={reason}
          maxLength={REASON_MAX}
          disabled={busy}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="dk-row">
        <button type="submit" className="adm-btn" data-tone="primary" disabled={!ready}>
          {busy ? 'Sending…' : 'Escalate this dispute'}
        </button>
        {!ready && !busy && <span className="dk-why">Give a reason of at least {REASON_MIN} characters first.</span>}
      </div>
      {reply && <StepReplyView reply={reply} />}
    </form>
  );
}
