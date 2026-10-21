'use client';

import { useCallback, useRef, useState } from 'react';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { shortId } from '@/lib/desk/desk-model';
import { fetchGroups, postSupportAction, type ActionReply } from '@/lib/support/browser';
import { GROUP_NAME_MAX, memberGate, saveGate, scopeSentence, type DeskGroupView } from '@/lib/support/groups';
import type { SupportActionRequest } from '@/lib/support/model';
import type { SupportGroupsView } from '@/lib/support/types';
import { ActionOutcome, ConfirmStep, Failed } from './support-action-parts';

/**
 * DESK GROUPS — which tickets a group of staff can see.
 *
 * A lead makes and renames groups and puts staff in them; everyone on the staff list can read them. The line at the top is
 * svc-support's own account of what the signed-in person sees. A refusal on any read is shown as that part's refusal, never as
 * "no groups". Each change needs a second click, and its key is made once when the change is armed, so a retry cannot repeat it.
 */

export type GroupStep = 'save' | 'member';

export interface GroupsForm {
  /** Empty means a new group. */
  readonly editing: string;
  readonly name: string;
  readonly memberGroup: string;
  readonly memberUser: string;
  readonly op: 'add' | 'remove';
}

export const emptyGroupsForm: GroupsForm = { editing: '', name: '', memberGroup: '', memberUser: '', op: 'add' };

export interface GroupsPanelViewProps {
  readonly view: SupportGroupsView | null;
  readonly loading: boolean;
  readonly form: GroupsForm;
  readonly armed: GroupStep | null;
  readonly busy: boolean;
  readonly outcome: ActionReply | null;
  readonly onField: (patch: Partial<GroupsForm>) => void;
  readonly onArm: (step: GroupStep | null) => void;
  readonly onSend: () => void;
  readonly onRefresh: () => void;
}

export function GroupsPanelView(p: GroupsPanelViewProps) {
  const groups = p.view?.groups.kind === 'ok' ? p.view.groups.data : null;
  const roster = p.view?.roster.kind === 'ok' ? p.view.roster.data : null;
  const me = roster?.find((m) => m.userId === p.view?.meId) ?? null;
  const memberGroup = groups?.find((g) => g.id === p.form.memberGroup) ?? null;
  const save = saveGate(me, p.form.name, groups ?? [], p.form.editing || null, p.busy);
  const member = memberGate(me, memberGroup, p.form.memberUser, p.form.op, roster ?? [], p.busy);
  const unread = !groups || !roster;
  const disabled = p.busy || p.armed !== null;
  const editingName = groups?.find((g) => g.id === p.form.editing)?.name;
  return (
    <section className="dk-stack" aria-label="Desk groups" data-testid="groups-panel">
      <h3>Desk groups</h3>
      {!p.view ? (
        <p className="dk-muted">{p.loading ? 'Reading…' : 'svc-support could not be read. Nothing is shown rather than a guess.'}</p>
      ) : (
        <>
          {p.view.scope.kind === 'failed' ? (
            <Failed name="Your desk scope" part={p.view.scope} />
          ) : (
            <p className="dk-muted" data-testid="groups-scope">
              {scopeSentence(p.view.scope.data)}
            </p>
          )}
          {p.view.groups.kind === 'failed' ? (
            <Failed name="Groups" part={p.view.groups} />
          ) : groups && groups.length === 0 ? (
            <p className="dk-muted" data-testid="groups-none">
              svc-support has no groups yet, so every staff member sees every ticket. Making the first group starts restricting what people
              see.
            </p>
          ) : (
            groups && (
              <div className="dk-table-wrap" role="region" aria-label="Groups" tabIndex={0}>
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th>Group</th>
                      <th>Members</th>
                      <th>Made</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g: DeskGroupView) => (
                      <tr key={g.id} data-testid={`group-${g.id}`}>
                        <td>{g.name}</td>
                        <td className="dk-packet">{g.memberIds.length === 0 ? 'None' : g.memberIds.map(shortId).join(', ')}</td>
                        <td>{formatWhen(g.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
          {p.view.roster.kind === 'failed' && <Failed name="Staff list" part={p.view.roster} />}
          {roster && !me && (
            <p className="dk-muted" data-testid="groups-not-me">
              You are not on the staff list, so you can read groups but not change them.
            </p>
          )}
          {me && me.role !== 'lead' && (
            <p className="dk-muted" data-testid="groups-not-lead">
              Only a lead can make or change groups.
            </p>
          )}
        </>
      )}

      <h4>Make or rename a group</h4>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="sd-group-edit">Group</label>
          <select
            id="sd-group-edit"
            className="adm-input"
            value={p.form.editing}
            disabled={disabled || unread}
            onChange={(e) => p.onField({ editing: e.target.value, name: groups?.find((g) => g.id === e.target.value)?.name ?? '' })}
          >
            <option value="">A new group</option>
            {(groups ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                Rename {g.name}
              </option>
            ))}
          </select>
        </div>
        <div className="adm-field">
          <label htmlFor="sd-group-name">Name</label>
          <input
            id="sd-group-name"
            className="adm-input"
            value={p.form.name}
            maxLength={GROUP_NAME_MAX}
            autoComplete="off"
            disabled={disabled || unread}
            onChange={(e) => p.onField({ name: e.target.value })}
          />
        </div>
      </div>
      {p.armed === 'save' ? (
        <ConfirmStep
          title={editingName ? `Rename ${editingName} to ${p.form.name.trim()}?` : `Make the group ${p.form.name.trim()}?`}
          consequence="Once any group exists, agents see only the tickets of their own groups and the ones assigned to them."
          confirmLabel={editingName ? 'Yes, rename it' : 'Yes, make it'}
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
            disabled={!save.ok || disabled || unread}
            onClick={() => p.onArm('save')}
          >
            Review group
          </button>
          {(!save.ok || unread) && (
            <span className="dk-why">{unread ? 'The groups or staff list could not be read.' : save.ok ? '' : save.why}</span>
          )}
        </div>
      )}

      <h4>Members</h4>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="sd-group-pick">Group</label>
          <select
            id="sd-group-pick"
            className="adm-input"
            value={p.form.memberGroup}
            disabled={disabled || unread}
            onChange={(e) => p.onField({ memberGroup: e.target.value })}
          >
            <option value="">Pick a group</option>
            {(groups ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
        <div className="adm-field">
          <label htmlFor="sd-group-user">Person</label>
          <select
            id="sd-group-user"
            className="adm-input"
            value={p.form.memberUser}
            disabled={disabled || unread}
            onChange={(e) => p.onField({ memberUser: e.target.value })}
          >
            <option value="">Pick a person</option>
            {(roster ?? []).map((m) => (
              <option key={m.userId} value={m.userId}>
                {shortId(m.userId)} · {m.role}
              </option>
            ))}
          </select>
        </div>
        <div className="adm-field">
          <label htmlFor="sd-group-op">Do</label>
          <select
            id="sd-group-op"
            className="adm-input"
            value={p.form.op}
            disabled={disabled || unread}
            onChange={(e) => p.onField({ op: e.target.value as 'add' | 'remove' })}
          >
            <option value="add">Add to the group</option>
            <option value="remove">Remove from the group</option>
          </select>
        </div>
      </div>
      {p.armed === 'member' ? (
        <ConfirmStep
          title={`${p.form.op === 'add' ? 'Add' : 'Remove'} ${shortId(p.form.memberUser)} ${p.form.op === 'add' ? 'to' : 'from'} ${memberGroup?.name ?? 'the group'}?`}
          consequence="It changes which tickets that person can see straight away."
          confirmLabel={p.form.op === 'add' ? 'Yes, add them' : 'Yes, remove them'}
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
            disabled={!member.ok || disabled || unread}
            onClick={() => p.onArm('member')}
          >
            Review membership
          </button>
          {(!member.ok || unread) && (
            <span className="dk-why">{unread ? 'The groups or staff list could not be read.' : member.ok ? '' : member.why}</span>
          )}
        </div>
      )}
      <ActionOutcome reply={p.outcome} testId="groups-outcome" />
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={p.onRefresh} disabled={p.loading || p.busy}>
          {p.loading ? 'Reading…' : 'Refresh groups'}
        </button>
        {p.view && <span className="dk-asof">As of {formatAsOf(p.view.asOf)}</span>}
      </div>
    </section>
  );
}

export function GroupsPanel({ initial }: { initial: SupportGroupsView | null }) {
  const [view, setView] = useState<SupportGroupsView | null>(initial);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<GroupsForm>(emptyGroupsForm);
  const [armed, setArmed] = useState<GroupStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionReply | null>(null);
  const lock = useRef(false);
  const key = useRef('');
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    const next = await fetchGroups();
    if (mine === seq.current) {
      setView(next);
      setLoading(false);
    }
  }, []);

  async function send() {
    if (lock.current || !armed || !view) return;
    const groups = view.groups.kind === 'ok' ? view.groups.data : null;
    const roster = view.roster.kind === 'ok' ? view.roster.data : null;
    if (!groups || !roster) return;
    const me = roster.find((m) => m.userId === view.meId) ?? null;
    let request: SupportActionRequest;
    if (armed === 'save') {
      if (!saveGate(me, form.name, groups, form.editing || null, false).ok) return;
      request = {
        action: 'group_save',
        name: form.name.trim(),
        idempotencyKey: key.current,
        ...(form.editing ? { groupId: form.editing } : {}),
      };
    } else {
      const group = groups.find((g) => g.id === form.memberGroup) ?? null;
      if (!memberGate(me, group, form.memberUser, form.op, roster, false).ok) return;
      request = { action: 'group_member', op: form.op, groupId: form.memberGroup, userId: form.memberUser };
    }
    lock.current = true;
    setBusy(true);
    try {
      const reply = await postSupportAction(request);
      setOutcome(reply);
      setArmed(null);
      if (reply.ok && armed === 'save') setForm((f) => ({ ...f, editing: '', name: '' }));
      // Whatever the answer, read again: after "outcome not known" the page must show what is true.
      await load();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <GroupsPanelView
      view={view}
      loading={loading}
      form={form}
      armed={armed}
      busy={busy}
      outcome={outcome}
      onField={(patch) => setForm((f) => ({ ...f, ...patch }))}
      onArm={(step) => {
        if (busy) return;
        // One key per armed decision: a retry of the same confirm reuses it, a new decision gets a new one.
        if (step === 'save') key.current = `group:${crypto.randomUUID()}`;
        setArmed(step);
      }}
      onSend={() => void send()}
      onRefresh={() => void load()}
    />
  );
}
