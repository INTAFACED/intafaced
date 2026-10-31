'use client';

import { useCallback, useState } from 'react';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import { formatWhen } from '@/lib/as-of';
import type { StepReply } from '@/lib/desk/approval-types';
import type { Part } from '@/lib/desk/part';
import { fetchRoster } from '@/lib/system-staff/browser';
import {
  MAPPING_UNSET_WORDS,
  isAssignable,
  partBlocker,
  roleName,
  type RosterView,
  type StaffList,
  type StaffRolesList,
} from '@/lib/system-staff/model';
import { PartRefusal, ReadBar, ReadFailed, RecoveryNote, SystemNav, useReread } from './parts';

/**
 * STAFF AND FOUNDERS (`/system/users`, OPS-admin-access-03 step 3).
 *
 * The signed-in founder and the founder enrolment door (what this page showed before), the staff roster svc-identity stores,
 * and the invite of one named person as a two-founder request. Every row comes from svc-identity; when it does not answer,
 * the page says so with the code and draws every control switched off with that reason.
 */

const INVITE_NOTE =
  'An invite names one person by email and display name; no link anyone could use is ever made. They set their own password at first connection. Two different founders must agree, and svc-identity refuses a role you do not hold in full.';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function InviteControls({
  roster,
  roles,
  userId,
  onChanged,
  onStepReply,
}: {
  roster: Part<StaffList>;
  roles: Part<StaffRolesList>;
  userId: string;
  onChanged: () => void;
  onStepReply?: (reply: StepReply) => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<readonly string[]>([]);
  const blocked = partBlocker(roster, 'The staff roster') ?? partBlocker(roles, 'The role list');
  const roleList = roles.kind === 'ok' ? roles.data.roles : [];
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = name.trim();
  const roleIds = [...picked].filter((id) => roleList.some((r) => r.roleId === id && isAssignable(r))).sort();
  const hold =
    !EMAIL.test(cleanEmail) || cleanName === '' || cleanName.length > 120
      ? 'Write the person’s email and display name first. An invite always names one person.'
      : null;
  const action: ControlAction = {
    heading: cleanEmail ? `Invite ${cleanEmail}` : 'Invite one staff member',
    submitLabel: 'Ask a second founder to approve the invite',
    needsReason: false,
    reasonLabel: '',
    build: () => ({ kind: 'identity.staff.invite', email: cleanEmail, displayName: cleanName, roleIds }),
  };
  return (
    <section className="dk-step" data-testid="invite-controls" aria-labelledby="invite-heading">
      <h3 id="invite-heading">Invite a staff member</h3>
      <ControlDesk
        endpoint="/api/system/staff"
        userId={userId}
        blockedReason={blocked}
        action={action}
        consequence={INVITE_NOTE}
        blockedButtonLabel="Invite unavailable"
        formHold={hold}
        onChanged={onChanged}
        {...(onStepReply ? { onStepReply } : {})}
      >
        <div className="adm-field">
          <label htmlFor="staff-invite-email">Email</label>
          <input
            id="staff-invite-email"
            className="adm-input"
            type="email"
            autoComplete="off"
            value={email}
            maxLength={254}
            disabled={blocked !== null}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="adm-field">
          <label htmlFor="staff-invite-name">Display name</label>
          <input
            id="staff-invite-name"
            className="adm-input"
            autoComplete="off"
            value={name}
            maxLength={120}
            disabled={blocked !== null}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <fieldset className="adm-field" disabled={blocked !== null}>
          <legend>Roles granted when they accept</legend>
          {roleList.length === 0 ? (
            <p className="dk-muted">
              {roles.kind === 'ok'
                ? 'svc-identity holds no roles yet. Define a custom role on the Roles page.'
                : 'The role list is not read.'}
            </p>
          ) : (
            roleList.map((role) => (
              <label key={role.roleId} className="adm-check">
                <input
                  type="checkbox"
                  disabled={!isAssignable(role)}
                  checked={picked.includes(role.roleId)}
                  onChange={(e) => setPicked((now) => (e.target.checked ? [...now, role.roleId] : now.filter((id) => id !== role.roleId)))}
                />{' '}
                {role.name} ({role.kind}){role.state === 'mapping_unset' ? ` · ${MAPPING_UNSET_WORDS}` : ''}
              </label>
            ))
          )}
        </fieldset>
      </ControlDesk>
    </section>
  );
}

function RosterTable({ list, roles }: { list: StaffList; roles: Part<StaffRolesList> }) {
  const roleList = roles.kind === 'ok' ? roles.data.roles : [];
  if (list.staff.length === 0)
    return (
      <p className="adm-empty" data-testid="roster-empty">
        svc-identity holds no staff members. Founders enrol through the founder invite door; a staff member exists only once invited by name
        and approved by a second founder.
      </p>
    );
  return (
    <div className="dk-table-wrap">
      <table className="adm-table" data-testid="roster-table">
        <caption className="adm-sr-only">Staff members as svc-identity stores them</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Email</th>
            <th scope="col">Status</th>
            <th scope="col">Roles</th>
            <th scope="col">Last sign-in</th>
            <th scope="col">Invited</th>
          </tr>
        </thead>
        <tbody>
          {list.staff.map((s) => (
            <tr key={s.staffId}>
              <td>
                <a className="adm-link" href={`/system/users/${encodeURIComponent(s.staffId)}`}>
                  {s.displayName}
                </a>
              </td>
              <td>{s.email}</td>
              <td>{s.status}</td>
              <td>{s.roleIds.length === 0 ? 'none' : s.roleIds.map((id) => roleName(roleList, id)).join(', ')}</td>
              <td>{s.lastSignInAt ? formatWhen(s.lastSignInAt) : 'never signed in'}</td>
              <td>{formatWhen(s.invitedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.nextCursor ? (
        <p>
          <a className="adm-link" href={`/system/users?cursor=${encodeURIComponent(list.nextCursor)}`}>
            Next page of staff members
          </a>
        </p>
      ) : null}
    </div>
  );
}

export interface StaffRosterViewProps {
  readonly view: RosterView | null;
  readonly loading: boolean;
  readonly lostReply: boolean;
  readonly userId: string;
  readonly expiresAt: string;
  readonly onRefresh: () => void;
  readonly onStepReply?: (reply: StepReply) => void;
}

export function StaffRosterView({ view, loading, lostReply, userId, expiresAt, onRefresh, onStepReply }: StaffRosterViewProps) {
  return (
    <div className="dk" data-testid="staff-roster">
      <SystemNav current="/system/users" />
      <div className="adm-pagehead">
        <div>
          <h1>Staff and founders</h1>
          <p>
            Who works in this console, as svc-identity stores them, and the invite of one named person. Every change needs a second founder.
          </p>
        </div>
      </div>
      <ReadBar asOf={view?.asOf ?? null} loading={loading} onRefresh={onRefresh} />
      {lostReply && <RecoveryNote asOf={view?.asOf ?? null} />}
      <section className="dk-step" aria-labelledby="founder-heading">
        <h3 id="founder-heading">Current founder</h3>
        <dl className="dk-kv">
          <dt>Founder</dt>
          <dd className="dk-packet">{userId}</dd>
          <dt>Entitlement</dt>
          <dd>Accepted by the live founder entitlement check for this request</dd>
          <dt>Session expiry</dt>
          <dd>{formatWhen(expiresAt)}</dd>
          <dt>Enrolment</dt>
          <dd data-testid="founder-enrolment">
            {view === null
              ? 'Not read'
              : view.enrolment.kind === 'ok'
                ? view.enrolment.data.open
                  ? 'Enrolment door open · invite required'
                  : 'Enrolment door closed'
                : `Not read: ${view.enrolment.message}${view.enrolment.code ? ` (code ${view.enrolment.code})` : ''}`}
          </dd>
        </dl>
      </section>
      {view === null ? (
        <ReadFailed />
      ) : (
        <>
          <section className="dk-step" aria-labelledby="roster-heading">
            <h3 id="roster-heading">Staff roster</h3>
            {view.roster.kind === 'ok' ? (
              <RosterTable list={view.roster.data} roles={view.roles} />
            ) : (
              <PartRefusal part={view.roster} what="The staff roster" />
            )}
            {view.roles.kind === 'failed' && view.roster.kind === 'ok' ? <PartRefusal part={view.roles} what="The role list" /> : null}
          </section>
          <InviteControls
            roster={view.roster}
            roles={view.roles}
            userId={userId}
            onChanged={onRefresh}
            {...(onStepReply ? { onStepReply } : {})}
          />
        </>
      )}
    </div>
  );
}

export function StaffRosterDesk({
  initial,
  cursor,
  userId,
  expiresAt,
}: {
  initial: RosterView;
  cursor: string | null;
  userId: string;
  expiresAt: string;
}) {
  const fetcher = useCallback(() => fetchRoster(cursor ?? undefined), [cursor]);
  const { view, loading, lostReply, reload, onStepReply } = useReread(initial, fetcher);
  return (
    <StaffRosterView
      view={view}
      loading={loading}
      lostReply={lostReply}
      userId={userId}
      expiresAt={expiresAt}
      onRefresh={reload}
      onStepReply={onStepReply}
    />
  );
}
