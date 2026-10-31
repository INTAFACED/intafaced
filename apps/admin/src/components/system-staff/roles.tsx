'use client';

import { useState } from 'react';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import { isBuiltinRoleName } from '@/lib/desk/approval-staff';
import type { StepReply } from '@/lib/desk/approval-types';
import type { Part } from '@/lib/desk/part';
import { fetchRoles } from '@/lib/system-staff/browser';
import {
  MAPPING_UNSET_WORDS,
  STAFF_AREAS,
  STAFF_ENVS,
  STAFF_VERBS,
  gridToLists,
  listsToGrid,
  partBlocker,
  permissionOf,
  type Grant,
  type RolesView,
  type StaffRoleView,
  type StaffRolesList,
} from '@/lib/system-staff/model';
import { PartRefusal, ReadBar, ReadFailed, RecoveryNote, SystemNav, useReread } from './parts';

/**
 * ROLES (`/system/roles`, OPS-admin-access-03 step 3).
 *
 * The roles svc-identity stores, and the custom-role editor: a proposal a second founder approves before svc-identity stores
 * it. Built-in roles (founder, compliance, support, finance, developer) carry no permissions until the owner sets their
 * mapping; the page says so and offers no editor for them. Every permission is one verb on one area in one environment, and
 * nothing implies anything: a cell left unset is denied.
 */

function RolesTable({ roles }: { roles: readonly StaffRoleView[] }) {
  if (roles.length === 0)
    return (
      <p className="adm-empty" data-testid="roles-empty">
        svc-identity holds no roles.
      </p>
    );
  return (
    <div className="dk-table-wrap">
      <table className="adm-table" data-testid="roles-table">
        <caption className="adm-sr-only">Roles as svc-identity stores them</caption>
        <thead>
          <tr>
            <th scope="col">Role</th>
            <th scope="col">Kind</th>
            <th scope="col">Allows</th>
            <th scope="col">Denies</th>
            <th scope="col">Version</th>
          </tr>
        </thead>
        <tbody>
          {roles.map((role) => (
            <tr key={role.roleId}>
              <td>{role.name}</td>
              <td>{role.kind}</td>
              {role.state === 'mapping_unset' ? (
                <td colSpan={2} data-testid="role-mapping-unset">
                  {MAPPING_UNSET_WORDS}
                </td>
              ) : (
                <>
                  <td>{role.allow.length === 0 ? 'nothing' : role.allow.join(', ')}</td>
                  <td>{role.deny.length === 0 ? 'nothing' : role.deny.join(', ')}</td>
                </>
              )}
              <td>{role.version}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RoleEditor(props: {
  roles: Part<StaffRolesList>;
  userId: string;
  onChanged: () => void;
  onStepReply?: (reply: StepReply) => void;
}) {
  const custom = props.roles.kind === 'ok' ? props.roles.data.roles.filter((r) => r.kind === 'custom' && r.state === 'defined') : [];
  const [target, setTarget] = useState('');
  const [name, setName] = useState('');
  const [grid, setGrid] = useState<Record<string, Grant>>({});
  const blocked = partBlocker(props.roles, 'The role list');
  const editing = custom.find((r) => r.roleId === target) ?? null;
  const cleanName = name.trim();
  const { allow, deny } = gridToLists(grid);
  const hold =
    cleanName === '' || cleanName.length > 120
      ? 'Name the role first.'
      : isBuiltinRoleName(cleanName)
        ? 'A built-in role name cannot be a custom role. Built-in roles wait for the owner’s mapping.'
        : allow.length + deny.length === 0
          ? 'Allow or deny at least one permission.'
          : null;
  const action: ControlAction = {
    heading: editing ? `Redefine ${editing.name}` : cleanName ? `Define the role ${cleanName}` : 'Define a custom role',
    submitLabel: 'Ask a second founder to approve the role',
    needsReason: false,
    reasonLabel: '',
    build: () => ({
      kind: 'identity.roles.define',
      roleId: editing?.roleId ?? null,
      version: editing?.version ?? null,
      name: cleanName,
      allow,
      deny,
    }),
  };
  const pick = (roleId: string) => {
    const role = custom.find((r) => r.roleId === roleId) ?? null;
    setTarget(roleId);
    setName(role?.name ?? '');
    setGrid(listsToGrid(role));
  };
  return (
    <section className="dk-step" data-testid="role-editor" aria-labelledby="editor-heading">
      <h3 id="editor-heading">Custom role editor (a proposal)</h3>
      <ControlDesk
        endpoint="/api/system/staff"
        userId={props.userId}
        blockedReason={blocked}
        action={action}
        consequence="The role is stored only when a second founder approves it. Every holder of a redefined role gets the new set at once. A deny wins over any allow from another role, and svc-identity refuses a permission you do not hold yourself."
        blockedButtonLabel="Define role unavailable"
        formHold={hold}
        onChanged={props.onChanged}
        {...(props.onStepReply ? { onStepReply: props.onStepReply } : {})}
      >
        <fieldset className="dk-stack" disabled={blocked !== null}>
          <legend className="adm-sr-only">Role to define</legend>
          <div className="adm-field">
            <label htmlFor="role-target">Role</label>
            <select id="role-target" className="adm-select" value={target} onChange={(e) => pick(e.target.value)}>
              <option value="">A new custom role</option>
              {custom.map((r) => (
                <option key={r.roleId} value={r.roleId}>
                  Redefine {r.name} (version {r.version})
                </option>
              ))}
            </select>
          </div>
          <div className="adm-field">
            <label htmlFor="role-name">Name</label>
            <input id="role-name" className="adm-input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </div>
          <p className="dk-muted" data-testid="role-editor-count">
            Allows {allow.length}, denies {deny.length}. Every other permission is unset, which is denied.
          </p>
          {STAFF_AREAS.map((area) => (
            <div key={area} className="dk-table-wrap">
              <table className="adm-table" data-testid={`role-grid-${area}`}>
                <caption>{area}</caption>
                <thead>
                  <tr>
                    <th scope="col">Verb</th>
                    {STAFF_ENVS.map((env) => (
                      <th key={env} scope="col">
                        {env}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {STAFF_VERBS.map((verb) => (
                    <tr key={verb}>
                      <th scope="row">{verb}</th>
                      {STAFF_ENVS.map((env) => {
                        const p = permissionOf(area, verb, env);
                        return (
                          <td key={env}>
                            <select
                              className="adm-select"
                              aria-label={`${area} ${verb} in ${env}`}
                              value={grid[p] ?? 'unset'}
                              onChange={(e) => setGrid((g) => ({ ...g, [p]: e.target.value as Grant }))}
                            >
                              <option value="unset">unset</option>
                              <option value="allow">allow</option>
                              <option value="deny">deny</option>
                            </select>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </fieldset>
      </ControlDesk>
    </section>
  );
}

export interface StaffRolesViewProps {
  readonly view: RolesView | null;
  readonly loading: boolean;
  readonly lostReply: boolean;
  readonly userId: string;
  readonly onRefresh: () => void;
  readonly onStepReply?: (reply: StepReply) => void;
}

export function StaffRolesPageView({ view, loading, lostReply, userId, onRefresh, onStepReply }: StaffRolesViewProps) {
  return (
    <div className="dk" data-testid="staff-roles">
      <SystemNav current="/system/roles" />
      <div className="adm-pagehead">
        <div>
          <h1>Roles</h1>
          <p>
            What each staff role allows and denies, as svc-identity stores it, and the editor for custom roles. Several roles merge: an
            allow from any counts, a deny from any wins.
          </p>
        </div>
      </div>
      <ReadBar asOf={view?.asOf ?? null} loading={loading} onRefresh={onRefresh} />
      {lostReply && <RecoveryNote asOf={view?.asOf ?? null} />}
      {view === null ? (
        <ReadFailed />
      ) : (
        <>
          <section className="dk-step" aria-labelledby="roles-list-heading">
            <h3 id="roles-list-heading">Roles</h3>
            {view.roles.kind === 'ok' ? (
              <RolesTable roles={view.roles.data.roles} />
            ) : (
              <PartRefusal part={view.roles} what="The role list" />
            )}
          </section>
          <RoleEditor roles={view.roles} userId={userId} onChanged={onRefresh} {...(onStepReply ? { onStepReply } : {})} />
        </>
      )}
    </div>
  );
}

export function StaffRolesDesk({ initial, userId }: { initial: RolesView; userId: string }) {
  const { view, loading, lostReply, reload, onStepReply } = useReread(initial, fetchRoles);
  return (
    <StaffRolesPageView view={view} loading={loading} lostReply={lostReply} userId={userId} onRefresh={reload} onStepReply={onStepReply} />
  );
}
