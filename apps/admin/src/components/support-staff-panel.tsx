'use client';

import { useCallback, useRef, useState } from 'react';
import { Chip } from '@/components/chip';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { shortId } from '@/lib/desk/desk-model';
import { fetchStaff, postSupportAction, type ActionReply } from '@/lib/support/browser';
import { AVAILABILITIES, REASON_MAX, availabilityGate, heartbeatNote, type Availability, type StaffMemberView } from '@/lib/support/staff';
import { ROUTING_LEAD_ONLY, parseCapacity, parseSkills, staffRoutingGate, type StaffRoutingRow } from '@/lib/support/routing';
import type { SupportActionRequest } from '@/lib/support/model';
import type { SupportStaffView } from '@/lib/support/types';
import { ActionOutcome, ConfirmStep, Failed } from './support-action-parts';

/**
 * SUPPORT STAFF — who is on the desk and whether they are online, busy or offline.
 *
 * The roster is exactly what svc-support lists. A person sets their own availability; a lead can set anyone's. Automatic
 * offline (moving a quiet person to offline) is an owner value: while it is blank this says so and nobody is moved. A
 * refusal on the roster is shown as that part's refusal, never as "no staff".
 *
 * The roster also shows each person's desk groups (teams), and their routing: capacity (blank means never assigned
 * automatically) and skills, which a lead sets. Under it is svc-support's availability log, oldest first.
 */

export type StaffStep = 'availability' | 'routing';

export const CAPACITY_NOT_SET = 'Capacity not set: never assigned automatically';

const TONE: Record<Availability, 'live' | 'warn' | 'neutral'> = { online: 'live', busy: 'warn', offline: 'neutral' };

export interface StaffForm {
  /** The member being changed; empty means the signed-in person. */
  readonly target: string;
  readonly availability: Availability;
  readonly reason: string;
  /** Whose routing is being set; empty means nobody picked yet. */
  readonly routingTarget: string;
  /** Typed capacity; blank means not set. */
  readonly capacity: string;
  /** Comma-separated skills. */
  readonly skills: string;
}

export const emptyStaffForm: StaffForm = { target: '', availability: 'online', reason: '', routingTarget: '', capacity: '', skills: '' };

/** A person's routing as svc-support lists it. Someone it does not list has a blank capacity and no skills. */
export function routingOf(rows: readonly StaffRoutingRow[], userId: string): StaffRoutingRow {
  return rows.find((r) => r.userId === userId) ?? { userId, capacity: null, skills: [] };
}

export interface StaffPanelViewProps {
  readonly view: SupportStaffView | null;
  readonly loading: boolean;
  readonly form: StaffForm;
  readonly armed: StaffStep | null;
  readonly busy: boolean;
  readonly outcome: ActionReply | null;
  readonly onField: (patch: Partial<StaffForm>) => void;
  readonly onArm: (step: StaffStep | null) => void;
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
  const disabled = p.busy || p.armed !== null;
  const routingRows = p.view?.routing.kind === 'ok' ? p.view.routing.data.staff : null;
  const routingTarget = roster?.find((m) => m.userId === p.form.routingTarget) ?? null;
  const routingGate = !roster
    ? ({ ok: false, why: 'The roster could not be read.' } as const)
    : !routingRows
      ? ({ ok: false, why: 'Routing could not be read.' } as const)
      : staffRoutingGate(
          me,
          routingTarget?.userId ?? '',
          p.form.capacity,
          p.form.skills,
          routingTarget ? routingOf(routingRows, routingTarget.userId) : null,
          p.busy,
        );
  const capacity = parseCapacity(p.form.capacity);
  const skills = parseSkills(p.form.skills);
  const log = p.view?.log;
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
          {p.view.routing.kind === 'failed' && <Failed name="Routing (capacity and skills)" part={p.view.routing} />}
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
                      <th>Groups (teams)</th>
                      <th>Availability</th>
                      <th>Set</th>
                      <th>Last heartbeat</th>
                      <th>Capacity</th>
                      <th>Skills</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roster.map((m) => {
                      const r = routingRows ? routingOf(routingRows, m.userId) : null;
                      return (
                        <tr key={m.userId} data-testid={`staff-${m.userId}`}>
                          <td className="dk-packet">
                            {shortId(m.userId)}
                            {m.userId === meId ? ' (you)' : ''}
                          </td>
                          <td>{m.role}</td>
                          <td data-testid={`staff-groups-${m.userId}`}>
                            {m.groups.length === 0 ? 'None' : m.groups.map((g) => g.name).join(', ')}
                          </td>
                          <td>
                            <Chip tone={TONE[m.availability]}>{m.availability}</Chip>
                          </td>
                          <td>{m.availabilitySetAt ? formatWhen(m.availabilitySetAt) : 'Never'}</td>
                          <td>{m.lastHeartbeatAt ? formatWhen(m.lastHeartbeatAt) : 'None yet'}</td>
                          <td data-testid={`staff-capacity-${m.userId}`}>
                            {!r ? 'Not read' : r.capacity === null ? CAPACITY_NOT_SET : String(r.capacity)}
                          </td>
                          <td data-testid={`staff-skills-${m.userId}`}>
                            {!r ? 'Not read' : r.skills.length === 0 ? 'None' : r.skills.join(', ')}
                          </td>
                        </tr>
                      );
                    })}
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
      {p.armed === 'availability' ? (
        <ConfirmStep
          title={`Set ${target ? shortId(target.userId) : 'this person'} to ${p.form.availability}?`}
          consequence="It is logged with your name. Setting the value they already have changes nothing."
          confirmLabel={`Yes, set ${p.form.availability}`}
          busy={p.busy}
          onConfirm={p.onSend}
          onCancel={() => p.onArm(null)}
        />
      ) : (
        <div className="dk-row">
          <button
            type="button"
            className="adm-btn"
            data-tone="primary"
            disabled={!gate.ok || disabled}
            onClick={() => p.onArm('availability')}
          >
            Review availability
          </button>
          {!gate.ok && <span className="dk-why">{gate.why}</span>}
        </div>
      )}

      <h4>Routing: capacity and skills</h4>
      <p className="dk-muted">
        Capacity is how many open requests svc-support may give a person automatically. Blank means not set, and they are never assigned
        automatically. A request that needs a skill goes only to someone with it.
      </p>
      {me && me.role !== 'lead' && (
        <p className="dk-muted" data-testid="staff-routing-not-lead">
          {ROUTING_LEAD_ONLY}
        </p>
      )}
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="sd-routing-target">Person</label>
          <select
            id="sd-routing-target"
            className="adm-input"
            value={p.form.routingTarget}
            disabled={disabled || !roster || !routingRows}
            onChange={(e) => {
              const r = routingRows && e.target.value ? routingOf(routingRows, e.target.value) : null;
              p.onField({
                routingTarget: e.target.value,
                capacity: r && r.capacity !== null ? String(r.capacity) : '',
                skills: r ? r.skills.join(', ') : '',
              });
            }}
          >
            <option value="">Pick a person</option>
            {(roster ?? []).map((m: StaffMemberView) => (
              <option key={m.userId} value={m.userId}>
                {shortId(m.userId)}
                {m.userId === meId ? ' (you)' : ''} · {m.role}
              </option>
            ))}
          </select>
        </div>
        <div className="adm-field">
          <label htmlFor="sd-routing-capacity">Capacity (blank for not set)</label>
          <input
            id="sd-routing-capacity"
            className="adm-input"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={p.form.capacity}
            autoComplete="off"
            disabled={disabled || !routingTarget}
            onChange={(e) => p.onField({ capacity: e.target.value })}
          />
        </div>
        <div className="adm-field">
          <label htmlFor="sd-routing-skills">Skills (comma-separated)</label>
          <input
            id="sd-routing-skills"
            className="adm-input"
            value={p.form.skills}
            autoComplete="off"
            disabled={disabled || !routingTarget}
            onChange={(e) => p.onField({ skills: e.target.value })}
          />
        </div>
      </div>
      {p.armed === 'routing' ? (
        <ConfirmStep
          title={`Save routing for ${routingTarget ? shortId(routingTarget.userId) : 'this person'}?`}
          consequence={`Capacity: ${capacity.ok ? (capacity.value === null ? CAPACITY_NOT_SET : capacity.value) : 'not valid'}. Skills: ${skills.ok ? (skills.value.length === 0 ? 'none' : skills.value.join(', ')) : 'not valid'}. It is logged with your name and changes who svc-support gives requests to from now on.`}
          confirmLabel="Yes, save routing"
          busy={p.busy}
          onConfirm={p.onSend}
          onCancel={() => p.onArm(null)}
        />
      ) : (
        <div className="dk-row">
          <button
            type="button"
            className="adm-btn"
            data-tone="primary"
            disabled={!routingGate.ok || disabled}
            onClick={() => p.onArm('routing')}
          >
            Review routing
          </button>
          {!routingGate.ok && <span className="dk-why">{routingGate.why}</span>}
        </div>
      )}
      <ActionOutcome reply={p.outcome} testId="staff-outcome" />

      <h4>Availability log</h4>
      {!log ? null : log.kind === 'failed' ? (
        <Failed name="Availability log" part={log} />
      ) : log.data.length === 0 ? (
        <p className="dk-muted" data-testid="staff-log-none">
          svc-support has no availability changes logged yet.
        </p>
      ) : (
        <div className="dk-table-wrap" role="region" aria-label="Availability log" tabIndex={0}>
          <table className="adm-table" data-testid="staff-log">
            <thead>
              <tr>
                <th>Person</th>
                <th>Availability</th>
                <th>Set by</th>
                <th>Reason</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {log.data.map((row, i) => (
                <tr key={`${row.userId}:${row.at}:${i}`}>
                  <td className="dk-packet">{row.userId}</td>
                  <td>{row.availability}</td>
                  <td className="dk-packet">{row.by}</td>
                  <td>{row.reason ?? 'No reason given'}</td>
                  <td>{formatWhen(row.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
  const [armed, setArmed] = useState<StaffStep | null>(null);
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
    let request: SupportActionRequest;
    if (armed === 'availability') {
      const target = roster?.find((m) => m.userId === (form.target || view.meId)) ?? null;
      if (!target || !availabilityGate(me, target, form.availability, form.reason, false).ok) return;
      const reason = form.reason.trim();
      request = {
        action: 'staff_availability',
        availability: form.availability,
        ...(target.userId !== view.meId ? { userId: target.userId } : {}),
        ...(reason ? { reason } : {}),
      };
    } else {
      const rows = view.routing.kind === 'ok' ? view.routing.data.staff : null;
      const target = roster?.find((m) => m.userId === form.routingTarget) ?? null;
      if (!target || !rows) return;
      if (!staffRoutingGate(me, target.userId, form.capacity, form.skills, routingOf(rows, target.userId), false).ok) return;
      const capacity = parseCapacity(form.capacity);
      const skills = parseSkills(form.skills);
      if (!capacity.ok || !skills.ok) return;
      request = { action: 'staff_routing', userId: target.userId, capacity: capacity.value, skills: skills.value };
    }
    lock.current = true;
    setBusy(true);
    try {
      const reply = await postSupportAction(request);
      setOutcome(reply);
      const step = armed;
      setArmed(null);
      if (reply.ok && step === 'availability') setForm((f) => ({ ...f, reason: '' }));
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
      onArm={(step) => {
        if (!busy) setArmed(step);
      }}
      onSend={() => void send()}
      onRefresh={() => void load()}
    />
  );
}
