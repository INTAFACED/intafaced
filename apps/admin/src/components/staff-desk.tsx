'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { StaffEntry } from '@intafaced/contracts/identity-staff';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import type { Part } from '@/lib/desk/part';
import './desk.css';

/**
 * STAFF (OPS-admin-access-03, J-ops-console-09 #2).
 *
 * Who is staff in the console, and the two-founder invite. An invite names one person by email and name; identity
 * judges it by the invite's approval policy row, a different founder approves the exact person, and the person then
 * gets a one-time link by email to set their own password. Nobody's password, link or factor appears here.
 */

export interface StaffDeskView {
  readonly asOf: string;
  readonly staff: Part<readonly StaffEntry[]>;
}

async function fetchStaff(): Promise<StaffDeskView | null> {
  try {
    const res = await fetch('/api/identity-ops/staff', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const body = (await res.json()) as StaffDeskView;
    return body && typeof body.asOf === 'string' && body.staff ? body : null;
  } catch {
    return null;
  }
}

const STATUS_WORDS: Record<StaffEntry['status'], string> = {
  invited: 'Invited: has not set a password yet',
  active: 'Active',
  disabled: 'Disabled',
};

function StaffTable({ staff }: { staff: readonly StaffEntry[] }) {
  if (staff.length === 0) return <p data-testid="staff-empty">No staff yet. Founders are not listed here.</p>;
  return (
    <div className="dk-table-wrap" role="region" aria-label="Staff" tabIndex={0}>
      <table className="adm-table" data-testid="staff-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Email</th>
            <th scope="col">Status</th>
            <th scope="col">Invited</th>
            <th scope="col">Joined</th>
          </tr>
        </thead>
        <tbody>
          {staff.map((s) => (
            <tr key={s.staffId} data-testid="staff-row" data-email={s.email} data-status={s.status}>
              <th scope="row">{s.displayName}</th>
              <td>{s.email}</td>
              <td>{STATUS_WORDS[s.status]}</td>
              <td>{formatWhen(s.invitedAt)}</td>
              <td>{s.activatedAt ? formatWhen(s.activatedAt) : 'not yet'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InviteControls({ userId, onChanged }: { userId: string; onChanged: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  // One business key per invite form, so a lost reply is read again, never invited twice.
  const requestId = useMemo(() => `staff-invite-${crypto.randomUUID()}`, []);
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = name.trim();
  const hold = cleanEmail === '' || cleanName === '' ? 'Type the person’s email and name first.' : null;
  const action: ControlAction = {
    heading: cleanEmail ? `Invite ${cleanName || 'this person'} (${cleanEmail})` : 'Invite a staff member',
    submitLabel: 'Ask a second founder to approve the invite',
    needsReason: false,
    reasonLabel: '',
    build: () => ({ kind: 'identity.staff.invite', requestId, email: cleanEmail, displayName: cleanName }),
  };
  return (
    <ControlDesk
      endpoint="/api/identity-ops/staff"
      userId={userId}
      blockedReason={null}
      formHold={hold}
      action={action}
      consequence="They get a one-time link by email and set their own password at first connection. They hold no role, and so can do nothing in the console, until roles are given to them. A different founder must approve."
      blockedButtonLabel="Invite unavailable"
      onChanged={onChanged}
    >
      <div className="adm-field">
        <label htmlFor="sd-email">Their email</label>
        <input
          id="sd-email"
          className="adm-input"
          type="email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="adm-field">
        <label htmlFor="sd-name">Their name</label>
        <input id="sd-name" className="adm-input" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
    </ControlDesk>
  );
}

export function StaffDesk({ initial, userId }: { initial: StaffDeskView | null; userId: string }) {
  const [view, setView] = useState<StaffDeskView | null>(initial);
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++sequence.current;
    setLoading(true);
    const next = await fetchStaff();
    if (mine === sequence.current) {
      setView(next);
      setLoading(false);
    }
  }, []);
  return (
    <div className="dk" data-testid="staff-desk">
      <div className="adm-pagehead">
        <div>
          <h1>Staff</h1>
          <p>Who works in the console besides the founders, and the two-founder invite.</p>
        </div>
      </div>
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={() => void reload()} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
        <span className="dk-asof">{view ? `As of ${formatAsOf(view.asOf)} (when this console read svc-identity)` : 'No read yet'}</span>
      </div>
      {!view && <p className="dk-why">svc-identity could not be read. Nothing is shown rather than a guess.</p>}
      {view && view.staff.kind === 'failed' && (
        <div className="adm-callout" data-tone="danger" role="status" data-testid="staff-failed">
          <strong>Staff unavailable</strong>
          <p>{view.staff.message}</p>
          {view.staff.code && <p className="dk-muted">Code: {view.staff.code}</p>}
        </div>
      )}
      {view && view.staff.kind === 'ok' && <StaffTable staff={view.staff.data} />}
      <InviteControls userId={userId} onChanged={() => void reload()} />
    </div>
  );
}
