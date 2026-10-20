'use client';

import { useCallback, useRef, useState } from 'react';
import { Chip } from '@/components/chip';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { shortId } from '@/lib/desk/desk-model';
import { fetchStaff, postSupportAction, type ActionReply } from '@/lib/support/browser';
import { AVAILABILITIES, REASON_MAX, availabilityGate, heartbeatNote, type Availability, type StaffMemberView } from '@/lib/support/staff';
import type { SupportStaffView } from '@/lib/support/types';
import { ActionOutcome, ConfirmStep, Failed } from './support-action-parts';

/**
 * SUPPORT STAFF — who is on the desk and whether they are online, busy or offline.
 *
 * The roster is exactly what svc-support lists. A person sets their own availability; a lead can set anyone's. Automatic
 * offline (moving a quiet person to offline) is an owner value: while it is blank this says so and nobody is moved. A
 * refusal on the roster is shown as that part's refusal, never as "no staff".
 */

const TONE: Record<Availability, 'live' | 'warn' | 'neutral'> = { online: 'live', busy: 'warn', offline: 'neutral' };

export interface StaffForm {
  /** The member being changed; empty means the signed-in person. */
  readonly target: string;
  readonly availability: Availability;
  readonly reason: string;
}

export const emptyStaffForm: StaffForm = { target: '', availability: 'online', reason: '' };

export interface StaffPanelViewProps {
  readonly view: SupportStaffView | null;
  readonly loading: boolean;
  readonly form: StaffForm;
  readonly armed: boolean;
  readonly busy: boolean;
  readonly outcome: ActionReply | null;
  readonly onField: (patch: Partial<StaffForm>) => void;
  readonly onArm: (on: boolean) => void;
  readonly onSend: () => void;
  readonly onRefresh: () => void;
}

export function StaffPanelView(p: StaffPanelViewProps) {
  const roster = p.view?.roster.kind === 'ok' ? p.view.roster.data : null;
  const meId = p.view?.meId ?? '';
  const me = roster?.find((m) => m.userId === meId) ?? null;
  const targetId = p.form.target || meId;
  const target = roster?.find((m) => m.userId === targetId) ?? null;
  const gate = target
    ? availabilityGate(me, target, p.form.availability, p.form.reason, p.busy)
    : ({ ok: false, why: roster ? 'Pick a person on the list.' : 'The roster could not be read.' } as const);
  const disabled = p.busy || p.armed;
  return (
    <section className="dk-stack" aria-label="Support staff" data-testid="staff-panel">
      <h3>Support staff</h3>
      {!p.view ? (
        <p className="dk-muted">{p.loading ? 'Reading…' : 'svc-support could not be read. Nothing is shown rather than a guess.'}</p>
      ) : (
        <>
          {p.view.policy.kind === 'failed' ? (
            <Failed name="Automatic offline setting" part={p.view.policy} />
          ) : (
            <p className="dk-muted" data-testid="staff-policy">
              {heartbeatNote(p.view.policy.data)}
            </p>
          )}
          {p.view.roster.kind === 'failed' ? (
            <Failed name="Staff list" part={p.view.roster} />
          ) : roster && roster.length === 0 ? (
            <p className="dk-muted" data-testid="staff-none">
              svc-support lists nobody on the support staff yet.
            </p>
          ) : (
            roster && (
              <div className="dk-table-wrap" role="region" aria-label="Staff list" tabIndex={0}>
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th>Person</th>
                      <th>Role</th>
                      <th>Availability</th>
                      <th>Set</th>
                      <th>Last heartbeat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roster.map((m) => (
                      <tr key={m.userId} data-testid={`staff-${m.userId}`}>
                        <td className="dk-packet">
                          {shortId(m.userId)}
                          {m.userId === meId ? ' (you)' : ''}
                        </td>
                        <td>{m.role}</td>
                        <td>
                          <Chip tone={TONE[m.availability]}>{m.availability}</Chip>
                        </td>
                        <td>{m.availabilitySetAt ? formatWhen(m.availabilitySetAt) : 'Never'}</td>
                        <td>{m.lastHeartbeatAt ? formatWhen(m.lastHeartbeatAt) : 'None yet'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
          {!me && roster && (
            <p className="dk-muted" data-testid="staff-not-me">
              You are not on this list, so you can read it but not set availability. A lead appoints staff.
            </p>
          )}
        </>
      )}

      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="sd-staff-target">Person</label>
          <select
            id="sd-staff-target"
            className="adm-input"
            value={targetId}
            disabled={disabled || !roster}
            onChange={(e) => p.onField({ target: e.target.value })}
          >
            {(roster ?? []).map((m: StaffMemberView) => (
              <option key={m.userId} value={m.userId}>
                {shortId(m.userId)}
                {m.userId === meId ? ' (you)' : ''} · {m.role}
              </option>
            ))}
          </select>
        </div>
        <div className="adm-field">
          <label htmlFor="sd-staff-avail">Availability</label>
          <select
            id="sd-staff-avail"
            className="adm-input"
            value={p.form.availability}
            disabled={disabled}
            onChange={(e) => p.onField({ availability: e.target.value as Availability })}
          >
            {AVAILABILITIES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="adm-field">
        <label htmlFor="sd-staff-reason">Reason (optional, kept in the log)</label>
        <input
          id="sd-staff-reason"
          className="adm-input"
          value={p.form.reason}
          maxLength={REASON_MAX}
          autoComplete="off"
          disabled={disabled}
          onChange={(e) => p.onField({ reason: e.target.value })}
        />
      </div>
      {p.armed ? (
        <ConfirmStep
          title={`Set ${target ? shortId(target.userId) : 'this person'} to ${p.form.availability}?`}
          consequence="It is logged with your name. Setting the value they already have changes nothing."
          confirmLabel={`Yes, set ${p.form.availability}`}
          busy={p.busy}
          onConfirm={p.onSend}
          onCancel={() => p.onArm(false)}
        />
      ) : (
        <div className="dk-row">
          <button type="button" className="adm-btn" data-tone="primary" disabled={!gate.ok} onClick={() => p.onArm(true)}>
            Review availability
          </button>
          {!gate.ok && <span className="dk-why">{gate.why}</span>}
        </div>
      )}
      <ActionOutcome reply={p.outcome} testId="staff-outcome" />
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={p.onRefresh} disabled={p.loading || p.busy}>
          {p.loading ? 'Reading…' : 'Refresh staff'}
        </button>
        {p.view && <span className="dk-asof">As of {formatAsOf(p.view.asOf)}</span>}
      </div>
    </section>
  );
}

export function StaffPanel({ initial }: { initial: SupportStaffView | null }) {
  const [view, setView] = useState<SupportStaffView | null>(initial);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<StaffForm>(emptyStaffForm);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionReply | null>(null);
  const lock = useRef(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    const next = await fetchStaff();
    if (mine === seq.current) {
      setView(next);
      setLoading(false);
    }
  }, []);

  async function send() {
    if (lock.current || !armed || !view) return;
    const roster = view.roster.kind === 'ok' ? view.roster.data : null;
    const me = roster?.find((m) => m.userId === view.meId) ?? null;
    const target = roster?.find((m) => m.userId === (form.target || view.meId)) ?? null;
    if (!target || !availabilityGate(me, target, form.availability, form.reason, false).ok) return;
    lock.current = true;
    setBusy(true);
    try {
      const reason = form.reason.trim();
      const reply = await postSupportAction({
        action: 'staff_availability',
        availability: form.availability,
        ...(target.userId !== view.meId ? { userId: target.userId } : {}),
        ...(reason ? { reason } : {}),
      });
      setOutcome(reply);
      setArmed(false);
      if (reply.ok) setForm((f) => ({ ...f, reason: '' }));
      // Whatever the answer, read again: after "outcome not known" the page must show what is true.
      await load();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <StaffPanelView
      view={view}
      loading={loading}
      form={form}
      armed={armed}
      busy={busy}
      outcome={outcome}
      onField={(patch) => setForm((f) => ({ ...f, ...patch }))}
      onArm={(on) => {
        if (!busy) setArmed(on);
      }}
      onSend={() => void send()}
      onRefresh={() => void load()}
    />
  );
}
