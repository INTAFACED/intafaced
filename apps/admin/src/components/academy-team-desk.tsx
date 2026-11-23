'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchTeam, postTeamChange } from '@/lib/academy/team-browser';
import type { TeamDeskReply, TeamView } from '@/lib/academy/team-model';
import { AcademyNav, Failed, Outcome } from '@/components/academy-courses-desk';

/** A time the desk read: an ISO string on the wire (the contract types it as a Date once parsed). */
const when = (d: Date | string) => formatWhen(typeof d === 'string' ? d : d.toISOString());

const newRequestId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now()));

/**
 * COURSE TEAM DESK (AC-roles-01, J-academy-18).
 *
 * Who holds which role on a course (or across the Academy), every role change with who proposed and who confirmed it, and
 * the roles: the built-in ones and the custom ones, each with its permissions. A role change waits until a founder other
 * than the one who proposed it confirms it. Nobody may give a role that permits more than they hold on the course. A
 * custom role is built from the permission list inside the owner's limit, and can be switched off without removing its
 * holders. The service checks all of it on every call; the desk hiding a button is never the control.
 */
export function AcademyTeamDesk({ initial }: { initial: TeamView | null }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<TeamDeskReply | null>(null);
  const [account, setAccount] = useState('');
  const [role, setRole] = useState('moderator');
  const [kind, setKind] = useState<'assign' | 'revoke'>('assign');
  const [why, setWhy] = useState('');
  // One request id per proposal draft, so a retry after a lost answer is the same change.
  const [requestId, setRequestId] = useState(newRequestId);
  const [roleName, setRoleName] = useState('');
  const [rolePerms, setRolePerms] = useState<string[]>([]);
  const [roleWhy, setRoleWhy] = useState('');
  const [roleRequest, setRoleRequest] = useState(newRequestId);
  const [switchWhy, setSwitchWhy] = useState<Record<string, string>>({});
  const courseId = view?.courseId ?? null;

  const reload = useCallback(async () => {
    const next = await fetchTeam(courseId);
    if (next) setView(next);
  }, [courseId]);

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    const answer = await postTeamChange('/api/academy-team', body);
    setReply(answer);
    setBusy(false);
    if (answer.ok && body.op === 'propose') {
      setAccount('');
      setWhy('');
      setRequestId(newRequestId());
    }
    if (answer.ok && body.op === 'saveRole') {
      setRoleName('');
      setRolePerms([]);
      setRoleWhy('');
      setRoleRequest(newRequestId());
    }
    await reload();
  };

  const team = view?.team;
  const roles = view?.roles;
  const courses = view?.courses.kind === 'ok' ? view.courses.data.courses : [];
  const allRoles = roles?.kind === 'ok' ? roles.data.roles : [];
  const custom = allRoles.filter((r) => r.kind === 'custom');
  return (
    <div className="dk" data-testid="academy-team">
      <div className="adm-pagehead">
        <div>
          <h1>Academy: course team roles</h1>
          <p>
            <Link href="/academy-ops/ambassadors">Back to ambassadors</Link>
          </p>
        </div>
      </div>
      <AcademyNav />
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="team-course">Course</label>
          <select
            id="team-course"
            value={courseId ?? ''}
            onChange={(e) => router.push(`/academy-ops/ambassadors/roles${e.target.value ? `?courseId=${e.target.value}` : ''}`)}
          >
            <option value="">The whole Academy</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="adm-btn" onClick={() => void reload()}>
          Refresh
        </button>
        <span className="dk-asof">{view ? `Read ${formatAsOf(view.asOf)}` : 'No read yet'}</span>
      </div>
      <Outcome reply={reply} />
      {!view && <p className="dk-why">The console could not reach its own server for this desk. Nothing is shown rather than a guess.</p>}
      {team?.kind === 'failed' && <Failed title="Could not read the team" message={team.message} code={team.code} />}
      {team?.kind === 'ok' && (
        <>
          <p className="dk-muted" data-testid="team-your-permissions">
            {team.data.narrowed
              ? `Your roles here permit: ${team.data.yourPermissions.join(', ') || 'nothing'}.`
              : 'You hold no role here, so your founder reach applies.'}
          </p>
          <section className="dk-stack" aria-labelledby="h-team-holders">
            <h2 id="h-team-holders">Who holds a role here</h2>
            {team.data.holders.length === 0 ? (
              <p className="dk-muted" data-testid="team-holders">
                Nobody holds a role here yet.
              </p>
            ) : (
              <ul className="dk-stack" data-testid="team-holders">
                {team.data.holders.map((h) => (
                  <li key={`${h.accountId}:${h.role}`} data-holder={h.accountId} data-role={h.role}>
                    <code>{h.accountId}</code>: {h.roleName}
                    {h.active ? '' : ' (switched off: it permits nothing)'}, since {when(h.since)}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="dk-stack" aria-labelledby="h-team-changes">
            <h2 id="h-team-changes">Role changes</h2>
            {team.data.changes.length === 0 ? (
              <p className="dk-muted" data-testid="team-changes">
                No role change yet.
              </p>
            ) : (
              <ul className="dk-stack" data-testid="team-changes">
                {team.data.changes.map((c) => (
                  <li key={c.id} data-change={c.id} data-state={c.state} data-holder={c.accountId} data-role={c.role}>
                    {c.kind === 'assign' ? 'Give' : 'Take'} {c.roleName} {c.kind === 'assign' ? 'to' : 'from'} <code>{c.accountId}</code>:{' '}
                    {c.reason}. Proposed by <code>{c.proposedBy}</code> {when(c.proposedAt)};{' '}
                    {c.state === 'confirmed' && c.confirmedBy && c.confirmedAt ? (
                      <>
                        confirmed by <code>{c.confirmedBy}</code> {when(c.confirmedAt)}.
                      </>
                    ) : (
                      <>
                        waiting for a second founder.{' '}
                        <button
                          type="button"
                          className="adm-btn"
                          disabled={busy}
                          onClick={() => void send({ op: 'confirm', changeId: c.id })}
                        >
                          Confirm
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <form
              className="dk-row"
              onSubmit={(e) => {
                e.preventDefault();
                void send({ op: 'propose', courseId, accountId: account.trim(), role, kind, reason: why, requestId });
              }}
            >
              <div className="adm-field">
                <label htmlFor="team-account">Account id</label>
                <input id="team-account" value={account} maxLength={36} onChange={(e) => setAccount(e.target.value)} />
              </div>
              <div className="adm-field">
                <label htmlFor="team-kind">Change</label>
                <select id="team-kind" value={kind} onChange={(e) => setKind(e.target.value === 'revoke' ? 'revoke' : 'assign')}>
                  <option value="assign">Give the role</option>
                  <option value="revoke">Take the role</option>
                </select>
              </div>
              <div className="adm-field">
                <label htmlFor="team-role">Role</label>
                <select id="team-role" value={role} onChange={(e) => setRole(e.target.value)}>
                  {allRoles.map((r) => (
                    <option key={r.ref} value={r.ref}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="adm-field">
                <label htmlFor="team-reason">Why</label>
                <input id="team-reason" value={why} maxLength={500} onChange={(e) => setWhy(e.target.value)} />
              </div>
              <button type="submit" className="adm-btn" disabled={busy}>
                Propose the change
              </button>
            </form>
          </section>
        </>
      )}
      {roles?.kind === 'failed' && <Failed title="Could not read the roles" message={roles.message} code={roles.code} />}
      {roles?.kind === 'ok' && (
        <section className="dk-stack" aria-labelledby="h-team-roles">
          <h2 id="h-team-roles">Roles</h2>
          <ul className="dk-stack" data-testid="team-roles">
            {roles.data.roles.map((r) => (
              <li key={r.ref} data-role={r.ref} data-role-name={r.name} data-active={String(r.active)}>
                <strong>{r.name}</strong> ({r.kind === 'builtin' ? 'built in' : r.active ? 'custom, on' : 'custom, switched off'}):{' '}
                {r.permissions.join(', ')}. Held {r.holders === 1 ? 'once' : `${r.holders} times`}.
                {r.kind === 'custom' && (
                  <span className="dk-row">
                    <span className="adm-field">
                      <label htmlFor={`switch-${r.ref}`}>
                        Why switch {r.name} {r.active ? 'off' : 'on'}
                      </label>
                      <input
                        id={`switch-${r.ref}`}
                        value={switchWhy[r.ref] ?? ''}
                        maxLength={500}
                        onChange={(e) => setSwitchWhy((w) => ({ ...w, [r.ref]: e.target.value }))}
                      />
                    </span>
                    <button
                      type="button"
                      className="adm-btn"
                      disabled={busy}
                      onClick={() =>
                        void send({
                          op: 'setRoleActive',
                          roleId: r.ref.slice('custom:'.length),
                          active: !r.active,
                          reason: switchWhy[r.ref] ?? '',
                        })
                      }
                    >
                      Switch {r.name} {r.active ? 'off' : 'on'}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          <h3>New custom role</h3>
          <p className="dk-muted" data-testid="team-role-limit">
            {roles.data.customRoleLimit === null
              ? `Custom role limit: not set. The owner has not set how many custom roles there may be (${custom.length} exist).`
              : `Custom role limit: ${roles.data.customRoles} of ${roles.data.customRoleLimit} used.`}
          </p>
          <form
            className="dk-stack"
            onSubmit={(e) => {
              e.preventDefault();
              void send({ op: 'saveRole', name: roleName.trim(), permissions: rolePerms, reason: roleWhy, requestId: roleRequest });
            }}
          >
            <div className="adm-field">
              <label htmlFor="team-role-name">Role name</label>
              <input id="team-role-name" value={roleName} maxLength={48} onChange={(e) => setRoleName(e.target.value)} />
            </div>
            <fieldset className="dk-row">
              <legend>Permissions</legend>
              {roles.data.permissions.map((p) => (
                <label key={p}>
                  <input
                    type="checkbox"
                    checked={rolePerms.includes(p)}
                    onChange={(e) => setRolePerms((now) => (e.target.checked ? [...now, p] : now.filter((x) => x !== p)))}
                  />{' '}
                  {p}
                </label>
              ))}
            </fieldset>
            <div className="adm-field">
              <label htmlFor="team-role-reason">Why this role</label>
              <input id="team-role-reason" value={roleWhy} maxLength={500} onChange={(e) => setRoleWhy(e.target.value)} />
            </div>
            <button type="submit" className="adm-btn" disabled={busy}>
              Save role
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
