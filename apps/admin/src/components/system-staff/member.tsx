'use client';

import { useCallback, useState } from 'react';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import { formatWhen } from '@/lib/as-of';
import type { StepReply } from '@/lib/desk/approval-types';
import { fetchStaffMember } from '@/lib/system-staff/browser';
import {
  MAPPING_UNSET_WORDS,
  assignableRoles,
  partBlocker,
  roleName,
  type StaffAccess,
  type StaffGet,
  type StaffMemberView,
  type StaffRoleView,
} from '@/lib/system-staff/model';
import { PartRefusal, ReadBar, ReadFailed, RecoveryNote, SystemNav, useReread } from './parts';

/**
 * ONE STAFF MEMBER (`/system/users/:userId`, OPS-admin-access-03 step 3).
 *
 * The record svc-identity stores, the roles held with assign and unassign, disable and remove, and the access overview:
 * every permission this person has, with the role it comes from. Each change is a two-founder request; nobody changes their
 * own roles or status. Built-in roles show that the owner has not set their mapping and are never offered for assignment.
 */

const SELF_BLOCK = 'Nobody changes their own roles or status (identity.staff_self_grant). Another founder makes this change.';

type StatusChoice = 'disable' | 'remove';

function StatusControls(props: {
  record: StaffGet | null;
  blocked: string | null;
  userId: string;
  onChanged: () => void;
  onStepReply?: (reply: StepReply) => void;
}) {
  const { record } = props;
  const [choice, setChoice] = useState<StatusChoice>('disable');
  const staff = record?.staff ?? null;
  const disableBlocked = staff?.status === 'disabled' ? 'This staff member is already disabled.' : null;
  const blocked = props.blocked ?? (choice === 'disable' ? disableBlocked : null);
  const action: ControlAction | null = staff
    ? {
        heading: choice === 'disable' ? `Disable ${staff.displayName}` : `Remove ${staff.displayName}`,
        submitLabel: choice === 'disable' ? 'Ask a second founder to approve the disable' : 'Ask a second founder to approve the removal',
        needsReason: true,
        reasonLabel: 'Reason (kept in the audit entry)',
        build: (reason) => ({
          kind: choice === 'disable' ? 'identity.staff.disable' : 'identity.staff.remove',
          staffId: staff.staffId,
          reason,
          version: staff.version,
        }),
        danger: true,
      }
    : null;
  return (
    <section className="dk-step" data-testid="status-controls" aria-labelledby="status-heading">
      <h3 id="status-heading">Disable or remove</h3>
      <ControlDesk
        key={`${choice}:${staff?.version ?? ''}`}
        endpoint="/api/system/staff"
        userId={props.userId}
        blockedReason={blocked}
        action={action}
        consequence={
          choice === 'disable'
            ? 'Disable revokes their sign-in and keeps the record. Two different founders must agree. The last founder cannot be disabled.'
            : 'Remove deletes the staff record and revokes their sign-in. Their customer account, if any, is not touched. Two different founders must agree.'
        }
        blockedButtonLabel={choice === 'disable' ? 'Disable unavailable' : 'Remove unavailable'}
        onChanged={props.onChanged}
        {...(props.onStepReply ? { onStepReply: props.onStepReply } : {})}
      >
        <div className="dk-row" role="group" aria-label="Status change">
          <button type="button" className="adm-btn" aria-pressed={choice === 'disable'} onClick={() => setChoice('disable')}>
            Disable
          </button>
          <button type="button" className="adm-btn" aria-pressed={choice === 'remove'} onClick={() => setChoice('remove')}>
            Remove
          </button>
        </div>
      </ControlDesk>
    </section>
  );
}

function RoleControls(props: {
  record: StaffGet | null;
  roles: readonly StaffRoleView[];
  blocked: string | null;
  userId: string;
  onChanged: () => void;
  onStepReply?: (reply: StepReply) => void;
}) {
  const staff = props.record?.staff ?? null;
  const held = staff?.roleIds ?? [];
  const offer = assignableRoles(props.roles, held);
  const unsetBuiltins = props.roles.filter((r) => r.state === 'mapping_unset');
  const [assignPick, setAssignPick] = useState('');
  const [unassignPick, setUnassignPick] = useState('');
  const assignId = offer.some((r) => r.roleId === assignPick) ? assignPick : (offer[0]?.roleId ?? null);
  const unassignId = held.includes(unassignPick) ? unassignPick : (held[0] ?? null);
  const assign: ControlAction | null =
    staff && assignId
      ? {
          heading: `Assign ${roleName(props.roles, assignId)} to ${staff.displayName}`,
          submitLabel: 'Ask a second founder to approve the assignment',
          needsReason: false,
          reasonLabel: '',
          build: () => ({ kind: 'identity.roles.assign', staffId: staff.staffId, roleId: assignId, version: staff.version }),
        }
      : null;
  const unassign: ControlAction | null =
    staff && unassignId
      ? {
          heading: `Take ${roleName(props.roles, unassignId)} away from ${staff.displayName}`,
          submitLabel: 'Ask a second founder to approve taking the role away',
          needsReason: false,
          reasonLabel: '',
          build: () => ({ kind: 'identity.roles.unassign', staffId: staff.staffId, roleId: unassignId, version: staff.version }),
          danger: true,
        }
      : null;
  const pass = props.onStepReply ? { onStepReply: props.onStepReply } : {};
  return (
    <section className="dk-step" data-testid="role-controls" aria-labelledby="roles-heading">
      <h3 id="roles-heading">Roles</h3>
      {staff && (
        <ul data-testid="roles-held">
          {held.length === 0 ? <li>No roles: every permission is denied.</li> : null}
          {held.map((id) => {
            const role = props.roles.find((r) => r.roleId === id);
            return (
              <li key={id}>
                {role?.name ?? id} {role ? `(${role.kind})` : '(not in the role list read)'}
                {role?.state === 'mapping_unset' ? ` · ${MAPPING_UNSET_WORDS}` : ''}
              </li>
            );
          })}
        </ul>
      )}
      {unsetBuiltins.length > 0 && (
        <p className="dk-muted" data-testid="builtin-unset">
          Not offered for assignment: {unsetBuiltins.map((r) => r.name).join(', ')}, {MAPPING_UNSET_WORDS}.
        </p>
      )}
      <ControlDesk
        key={`assign:${assignId ?? ''}:${staff?.version ?? ''}`}
        endpoint="/api/system/staff"
        userId={props.userId}
        blockedReason={props.blocked ?? (assign ? null : 'No defined role is left to assign. Built-in roles wait for the owner’s mapping.')}
        action={assign}
        consequence="The person gets every permission the role allows; a deny on any of their roles still wins. Two different founders must agree, and svc-identity refuses a role you do not hold in full."
        blockedButtonLabel="Assign unavailable"
        onChanged={props.onChanged}
        {...pass}
      >
        <div className="adm-field">
          <label htmlFor="staff-assign-role">Role to assign</label>
          <select
            id="staff-assign-role"
            className="adm-select"
            value={assignId ?? ''}
            disabled={props.blocked !== null || offer.length === 0}
            onChange={(e) => setAssignPick(e.target.value)}
          >
            {offer.map((r) => (
              <option key={r.roleId} value={r.roleId}>
                {r.name} ({r.kind})
              </option>
            ))}
          </select>
        </div>
      </ControlDesk>
      <ControlDesk
        key={`unassign:${unassignId ?? ''}:${staff?.version ?? ''}`}
        endpoint="/api/system/staff"
        userId={props.userId}
        blockedReason={props.blocked ?? (unassign ? null : 'This person holds no role to take away.')}
        action={unassign}
        consequence="The person loses every permission only that role gave them. Two different founders must agree; the founder role cannot be taken from the last founder."
        blockedButtonLabel="Unassign unavailable"
        onChanged={props.onChanged}
        {...pass}
      >
        <div className="adm-field">
          <label htmlFor="staff-unassign-role">Role to take away</label>
          <select
            id="staff-unassign-role"
            className="adm-select"
            value={unassignId ?? ''}
            disabled={props.blocked !== null || held.length === 0}
            onChange={(e) => setUnassignPick(e.target.value)}
          >
            {held.map((id) => (
              <option key={id} value={id}>
                {roleName(props.roles, id)}
              </option>
            ))}
          </select>
        </div>
      </ControlDesk>
    </section>
  );
}

export function AccessOverview({ access, roles }: { access: StaffAccess; roles: readonly StaffRoleView[] }) {
  const names = (ids: readonly string[]) => (ids.length === 0 ? 'none' : ids.map((id) => roleName(roles, id)).join(', '));
  return (
    <>
      <p className="dk-muted">
        Every permission one of their roles names, with where it comes from. A permission no role names is unset, and unset is denied.
        Approve, apply and skip are separate grants.
      </p>
      {access.permissions.length === 0 ? (
        <p className="adm-empty" data-testid="access-empty">
          No role gives this person any permission, so everything is denied.
        </p>
      ) : (
        <div className="dk-table-wrap">
          <table className="adm-table" data-testid="access-table">
            <caption className="adm-sr-only">Access overview</caption>
            <thead>
              <tr>
                <th scope="col">Permission</th>
                <th scope="col">State</th>
                <th scope="col">From roles</th>
                <th scope="col">Denied by</th>
              </tr>
            </thead>
            <tbody>
              {access.permissions.map((p) => (
                <tr key={p.permission}>
                  <td className="dk-packet">{p.permission}</td>
                  <td>{p.state === 'allowed' ? 'allowed' : 'denied (explicit deny wins)'}</td>
                  <td>{names(p.sourceRoleIds)}</td>
                  <td>{p.state === 'denied_explicit' ? names(p.deniedByRoleIds) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export interface StaffMemberViewProps {
  readonly view: StaffMemberView | null;
  readonly loading: boolean;
  readonly lostReply: boolean;
  readonly userId: string;
  readonly onRefresh: () => void;
  readonly onStepReply?: (reply: StepReply) => void;
}

export function StaffMemberPageView({ view, loading, lostReply, userId, onRefresh, onStepReply }: StaffMemberViewProps) {
  const record = view?.record.kind === 'ok' ? view.record.data : null;
  const roles = view?.roles.kind === 'ok' ? view.roles.data.roles : record ? record.roles : [];
  const staff = record?.staff ?? null;
  const blocked =
    view === null
      ? 'svc-identity could not be read, so no change can be asked for.'
      : (partBlocker(view.record, 'This staff record') ??
        partBlocker(view.roles, 'The role list') ??
        (staff && staff.userId.toLowerCase() === userId.toLowerCase() ? SELF_BLOCK : null));
  const pass = onStepReply ? { onStepReply } : {};
  return (
    <div className="dk" data-testid="staff-member">
      <SystemNav current="/system/users" />
      <div className="adm-pagehead">
        <div>
          <h1>{staff ? staff.displayName : 'Staff member'}</h1>
          <p>
            <a className="adm-link" href="/system/users">
              Back to staff and founders
            </a>
          </p>
        </div>
      </div>
      <ReadBar asOf={view?.asOf ?? null} loading={loading} onRefresh={onRefresh} />
      {lostReply && <RecoveryNote asOf={view?.asOf ?? null} />}
      {view === null ? <ReadFailed /> : null}
      <section className="dk-step" aria-labelledby="record-heading">
        <h3 id="record-heading">Record</h3>
        {view && view.record.kind === 'failed' ? <PartRefusal part={view.record} what="This staff record" /> : null}
        {staff && (
          <dl className="dk-kv" data-testid="staff-record">
            <dt>Staff id</dt>
            <dd className="dk-packet">{staff.staffId}</dd>
            <dt>Account</dt>
            <dd className="dk-packet">{staff.userId}</dd>
            <dt>Email</dt>
            <dd>{staff.email}</dd>
            <dt>Status</dt>
            <dd>{staff.status}</dd>
            <dt>Last sign-in</dt>
            <dd>{staff.lastSignInAt ? formatWhen(staff.lastSignInAt) : 'never signed in'}</dd>
            <dt>Invited</dt>
            <dd>
              {formatWhen(staff.invitedAt)} by <span className="dk-packet">{staff.invitedBy}</span>
            </dd>
            <dt>Activated</dt>
            <dd>{staff.activatedAt ? formatWhen(staff.activatedAt) : 'not yet: the invite is not accepted'}</dd>
            <dt>Disabled</dt>
            <dd>{staff.disabledAt ? formatWhen(staff.disabledAt) : 'no'}</dd>
            <dt>Record version</dt>
            <dd>{staff.version}</dd>
          </dl>
        )}
      </section>
      {view && view.roles.kind === 'failed' && view.record.kind === 'ok' ? <PartRefusal part={view.roles} what="The role list" /> : null}
      <RoleControls record={record} roles={roles} blocked={blocked} userId={userId} onChanged={onRefresh} {...pass} />
      <StatusControls record={record} blocked={blocked} userId={userId} onChanged={onRefresh} {...pass} />
      <section className="dk-step" aria-labelledby="access-heading" data-testid="access-overview">
        <h3 id="access-heading">Access overview</h3>
        {view === null ? null : view.access.kind === 'ok' ? (
          <AccessOverview access={view.access.data} roles={roles} />
        ) : (
          <PartRefusal part={view.access} what="The access overview" />
        )}
      </section>
    </div>
  );
}

export function StaffMemberDesk({ initial, userId }: { initial: StaffMemberView; userId: string }) {
  const staffId = initial.staffId;
  const fetcher = useCallback(() => fetchStaffMember(staffId), [staffId]);
  const { view, loading, lostReply, reload, onStepReply } = useReread(initial, fetcher);
  return (
    <StaffMemberPageView view={view} loading={loading} lostReply={lostReply} userId={userId} onRefresh={reload} onStepReply={onStepReply} />
  );
}
