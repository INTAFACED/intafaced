import { useEffect, useState, type FormEvent } from 'react';
import {
  AGENTS_TEAM_ROLES,
  agentsTeamGrantResultSchema,
  agentsTeamPoolResultSchema,
  agentsTeamProjectResultSchema,
  agentsTeamViewSchema,
  type AgentsTeamRole,
  type AgentsTeamView,
} from '@intafaced/contracts/agents-team';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, DataTable, EmptyState, Field, Loading, Panel } from '../../shared/ui';
import { useApi, useSession } from '../session/session';
import { Select } from './common';
import { StatRow } from './depth-kit';
import { agentsTeamCopy } from './agents-team-copy';

const ROLES = AGENTS_TEAM_ROLES;
type Role = AgentsTeamRole;
type Team = AgentsTeamView;

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
const ERR_KEYS = [
  'role_not_member',
  'role_admin_only',
  'role_invalid',
  'team_change_stale',
  'business_shut',
  'membership_unavailable',
  'pool_limit_unset',
  'pool_limit_invalid',
  'pool_allocation_invalid',
  'project_name_unset',
  'project_limit_unset',
  'project_limit_invalid',
  'fee_asset_unset',
  'capability_unavailable',
] as const;

/** One team action's outcome, said in the room's own words: a refusal by its code, never the service's text. */
function useRefusalText() {
  const { t } = agentsTeamCopy.useCopy();
  return (code: string | undefined): string => {
    const key = ERR_KEYS.find((k) => code === `agents.${k}`);
    return key ? t(`err_${key}`) : t('err_other', { code: code ?? 'unknown' });
  };
}

/** The agents Team room (/agents/team): roles per member, the business pool, project limits (AG-governance-01). */
export function AgentsTeam() {
  const api = useApi();
  const { userId } = useSession();
  const { Copy, t } = agentsTeamCopy.useCopy();
  const refusalText = useRefusalText();
  const team = useResource(
    (signal) => api.query('agents', 'team.view', undefined, agentsTeamViewSchema, { signal }),
    `agents-team:${userId}`,
  );
  // The last team read stays on screen while it is read again, so a form keeps what was typed.
  const [shown, setShown] = useState<Team | null>(null);
  useEffect(() => {
    if (team.resource.status === 'ready') setShown(team.resource.data);
    if (team.resource.status === 'failed') setShown(null);
  }, [team.resource]);

  if (team.resource.status === 'failed') {
    const code = team.resource.failure.code;
    return (
      <Panel title={t('membersTitle')}>
        <p role="alert">{code === 'agents.role_not_member' ? t('err_view_not_member') : refusalText(code)}</p>
        <p>
          <a href="/pay/team">
            <Copy k="manageMembers" />
          </a>
        </p>
        <Button variant="secondary" onClick={team.reload}>
          <Copy k="retry" />
        </Button>
      </Panel>
    );
  }
  if (!shown) return <Loading />;
  return <TeamRoom team={shown} reload={team.reload} />;
}

function TeamRoom({ team, reload }: { team: Team; reload: () => void }) {
  const api = useApi();
  const { Copy, t } = agentsTeamCopy.useCopy();
  const refusalText = useRefusalText();
  // A member with no name on file reads as their business role; the account ID beside it tells two apart.
  const memberName = (m: Team['members'][number]) => m.label ?? t(`business_${m.businessRole}`);
  const name = (userId: string) => {
    const m = team.members.find((x) => x.userId === userId);
    return m ? memberName(m) : userId;
  };
  const roleName = (role: Role) => t(`role_${role}`);
  const [busy, setBusy] = useState(false);
  const [rolesNote, setRolesNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [override, setOverride] = useState<Record<string, boolean>>({});

  /** Saves one member's allow and deny for one role as that grant's next change. */
  async function saveGrant(memberUserId: string, role: Role, allow: boolean, deny: boolean, version: number) {
    setBusy(true);
    const result = await api.mutate(
      'agents',
      'team.grants.set',
      { memberUserId, role, allow, deny, revision: version + 1 },
      agentsTeamGrantResultSchema,
    );
    setBusy(false);
    setRolesNote(result.ok ? { ok: true, text: t('saved') } : { ok: false, text: refusalText((result as Refusal).code) });
    setOverride({});
    reload();
    return result.ok;
  }

  const [grantTo, setGrantTo] = useState('');
  const [grantRole, setGrantRole] = useState<Role>('runner');
  async function grantToAccount(event: FormEvent) {
    event.preventDefault();
    const target = grantTo.trim();
    const current = team.members.find((m) => m.userId === target)?.grants.find((g) => g.role === grantRole);
    await saveGrant(target, grantRole, true, current?.deny ?? false, current?.version ?? 0);
  }

  const [poolLimit, setPoolLimit] = useState(team.pool?.limit ?? '');
  const [allocations, setAllocations] = useState<Record<string, string>>(() =>
    Object.fromEntries(team.members.map((m) => [m.userId, m.allocation ?? ''])),
  );
  const [poolNote, setPoolNote] = useState<{ ok: boolean; text: string } | null>(null);
  async function savePool(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await api.mutate(
      'agents',
      'team.pool.set',
      {
        limit: poolLimit,
        allocations: team.members.map((m) => ({ memberUserId: m.userId, amount: allocations[m.userId] ?? '' })),
        revision: (team.pool?.version ?? 0) + 1,
      },
      agentsTeamPoolResultSchema,
    );
    setBusy(false);
    if (!result.ok) setPoolNote({ ok: false, text: refusalText((result as Refusal).code) });
    else if (!result.data.ok) {
      const members = result.data.memberUserIds.map((id) => t('allocationFor', { member: name(id), account: id })).join(', ');
      setPoolNote({ ok: false, text: t('err_pool_allocation_unset', { members }) });
    } else setPoolNote({ ok: true, text: t('saved') });
    reload();
  }

  const [projectName, setProjectName] = useState('');
  const [projectLimit, setProjectLimit] = useState('');
  const [projectMembers, setProjectMembers] = useState<string[]>([]);
  const [projectNote, setProjectNote] = useState<{ ok: boolean; text: string } | null>(null);
  async function createProject(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await api.mutate(
      'agents',
      'team.projects.create',
      { name: projectName, limit: projectLimit, memberUserIds: projectMembers, seq: team.nextProjectSeq },
      agentsTeamProjectResultSchema,
    );
    setBusy(false);
    if (result.ok) {
      setProjectNote({ ok: true, text: t('saved') });
      setProjectName('');
      setProjectLimit('');
      setProjectMembers([]);
    } else setProjectNote({ ok: false, text: refusalText((result as Refusal).code) });
    reload();
  }

  const locked = busy || !team.canManage;
  const note = (n: { ok: boolean; text: string } | null) => (n ? <p role={n.ok ? 'status' : 'alert'}>{n.text}</p> : null);

  return (
    <>
      <Panel title={t('membersTitle')}>
        <p className="muted">
          <Copy k="membersNote" /> <a href="/pay/team">{t('manageMembers')}</a>
        </p>
        {team.canManage ? null : (
          <p className="muted">
            <Copy k="readOnly" />
          </p>
        )}
        <DataTable
          label={t('membersTitle')}
          headers={[t('colMember'), t('colAccount'), t('colBusinessRole'), ...ROLES.map(roleName), t('colEffective')]}
        >
          {team.members.map((m) => (
            <tr key={m.userId}>
              <th scope="row">{memberName(m)}</th>
              <td>
                <code>{m.userId}</code>
              </td>
              <td>{t(`business_${m.businessRole}`)}</td>
              {m.grants.map((g) => {
                const allow = override[`${m.userId}:${g.role}:allow`] ?? g.allow;
                const deny = override[`${m.userId}:${g.role}:deny`] ?? g.deny;
                const toggle = (effect: 'allow' | 'deny', value: boolean) => {
                  setOverride((o) => ({ ...o, [`${m.userId}:${g.role}:${effect}`]: value }));
                  void saveGrant(m.userId, g.role, effect === 'allow' ? value : allow, effect === 'deny' ? value : deny, g.version);
                };
                return (
                  <td key={g.role}>
                    <label>
                      <input
                        type="checkbox"
                        checked={allow}
                        disabled={locked}
                        aria-label={t('allowRole', { role: roleName(g.role) })}
                        onChange={(e) => toggle('allow', e.target.checked)}
                      />{' '}
                      <Copy k="allowed" />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={deny}
                        disabled={locked}
                        aria-label={t('denyRole', { role: roleName(g.role) })}
                        onChange={(e) => toggle('deny', e.target.checked)}
                      />{' '}
                      <Copy k="denied" />
                    </label>
                    <span className="muted" data-testid={`effective-${g.role}`}>
                      {g.deny ? t('denied') : g.allow ? t('allowed') : t('notGranted')}
                    </span>
                  </td>
                );
              })}
              <td data-testid="effective-roles">{m.effective.length ? m.effective.map(roleName).join(', ') : t('noRoles')}</td>
            </tr>
          ))}
        </DataTable>
        {note(rolesNote)}
        <form aria-label={t('grantTitle')} onSubmit={grantToAccount}>
          <h3>
            <Copy k="grantTitle" />
          </h3>
          <div className="depth-filters">
            <Field label={t('grantAccount')} value={grantTo} disabled={locked} onChange={(e) => setGrantTo(e.target.value)} />
            <Select
              label={t('grantRole')}
              value={grantRole}
              onChange={(value) => setGrantRole(value as Role)}
              options={ROLES.map((role) => ({ value: role, label: roleName(role) }))}
            />
          </div>
          <Button type="submit" disabled={locked || !grantTo.trim()}>
            <Copy k="grant" />
          </Button>
        </form>
      </Panel>

      <Panel title={t('poolTitle')}>
        <p className="muted">
          <Copy k="poolNote" />
        </p>
        {team.pool ? (
          <StatRow
            items={[
              { label: t('poolLimitShown'), value: <span data-testid="pool-limit">{`${team.pool.limit} ${team.pool.assetId}`}</span> },
              {
                label: t('poolAllocated'),
                value: <span data-testid="pool-allocated">{`${team.pool.allocated} ${team.pool.assetId}`}</span>,
              },
            ]}
          />
        ) : (
          <EmptyState title={<Copy k="poolNone" />} />
        )}
        <form aria-label={t('poolTitle')} onSubmit={savePool}>
          <Field
            label={t('poolLimit')}
            inputMode="decimal"
            value={poolLimit}
            disabled={locked}
            onChange={(e) => setPoolLimit(e.target.value)}
          />
          {team.members.map((m) => (
            <Field
              key={m.userId}
              label={t('allocationFor', { member: memberName(m), account: m.userId })}
              inputMode="decimal"
              value={allocations[m.userId] ?? ''}
              disabled={locked}
              onChange={(e) => setAllocations((a) => ({ ...a, [m.userId]: e.target.value }))}
            />
          ))}
          {note(poolNote)}
          <Button type="submit" disabled={locked}>
            <Copy k="savePool" />
          </Button>
        </form>
      </Panel>

      <Panel title={t('projectsTitle')}>
        {team.projects.length ? (
          <DataTable label={t('projectsTitle')} headers={[t('colProject'), t('colLimit'), t('colMembers')]}>
            {team.projects.map((p) => (
              <tr key={p.id}>
                <th scope="row">{p.name}</th>
                <td>{`${p.limit} ${p.assetId}`}</td>
                <td>{p.memberUserIds.map(name).join(', ')}</td>
              </tr>
            ))}
          </DataTable>
        ) : (
          <EmptyState title={<Copy k="projectsEmpty" />} />
        )}
        <form aria-label={t('newProject')} onSubmit={createProject}>
          <h3>
            <Copy k="newProject" />
          </h3>
          <Field label={t('projectName')} value={projectName} disabled={locked} onChange={(e) => setProjectName(e.target.value)} />
          <Field
            label={t('projectLimit')}
            inputMode="decimal"
            value={projectLimit}
            disabled={locked}
            onChange={(e) => setProjectLimit(e.target.value)}
          />
          <fieldset>
            <legend>
              <Copy k="projectMembers" />
            </legend>
            {team.members.map((m) => (
              <label key={m.userId}>
                <input
                  type="checkbox"
                  checked={projectMembers.includes(m.userId)}
                  disabled={locked}
                  onChange={(e) =>
                    setProjectMembers((list) => (e.target.checked ? [...list, m.userId] : list.filter((id) => id !== m.userId)))
                  }
                />{' '}
                {t('memberChoice', { member: memberName(m), account: m.userId })}
              </label>
            ))}
          </fieldset>
          {note(projectNote)}
          <Button type="submit" disabled={locked}>
            <Copy k="createProject" />
          </Button>
        </form>
      </Panel>

      <Panel title={t('limitsTitle')}>
        <DataTable label={t('limitsTitle')} headers={[t('colMember'), t('colAccount'), t('colAllocation'), t('colProjectLimits')]}>
          {team.members.map((m) => {
            const projects = team.projects.filter((p) => p.memberUserIds.includes(m.userId));
            return (
              <tr key={m.userId}>
                <th scope="row">{memberName(m)}</th>
                <td>
                  <code>{m.userId}</code>
                </td>
                <td>{m.allocation !== null && team.pool ? `${m.allocation} ${team.pool.assetId}` : t('noAllocation')}</td>
                <td>{projects.length ? projects.map((p) => `${p.name}: ${p.limit} ${p.assetId}`).join('; ') : t('noProjectLimit')}</td>
              </tr>
            );
          })}
        </DataTable>
      </Panel>

      <Panel title={t('usageTitle')}>
        <EmptyState title={<Copy k="usageTitle" />}>
          <Copy k="usageRefused" />
        </EmptyState>
      </Panel>

      <Panel title={t('approvalsTitle')}>
        <EmptyState title={<Copy k="approvalsTitle" />}>
          <Copy k="approvalsRefused" />
        </EmptyState>
      </Panel>
    </>
  );
}
