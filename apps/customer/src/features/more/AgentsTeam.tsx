import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  AGENTS_TEAM_ROLES,
  agentsTeamGrantResultSchema,
  agentsTeamHeldActionResultSchema,
  agentsTeamHeldActionSchema,
  agentsTeamPoolResultSchema,
  agentsTeamProjectResultSchema,
  agentsTeamRunClosedSchema,
  agentsTeamRunResultSchema,
  agentsTeamRunSessionSchema,
  agentsTeamUsageSchema,
  agentsTeamViewSchema,
  type AgentsTeamRole,
  type AgentsTeamView,
} from '@intafaced/contracts/agents-team';
import { ownAgentSchema } from '@intafaced/contracts/agents-own';
import type { ApiResult } from '../../shared/api';
import { businessListSchema } from '../money/business-schema';
import { Checkbox } from '@intafaced/ui';
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
/** Each refusal the room words itself, by its code (`agents.<key>`, a run's hold refusals as `agents.team.<key>`). */
const ERR_KEYS = {
  'agents.role_not_member': 'err_role_not_member',
  'agents.role_admin_only': 'err_role_admin_only',
  'agents.role_invalid': 'err_role_invalid',
  'agents.team_change_stale': 'err_team_change_stale',
  'agents.team_not_member': 'err_team_not_member',
  'agents.business_closed': 'err_business_closed',
  'agents.membership_unavailable': 'err_membership_unavailable',
  'agents.team_role_required': 'err_team_role_required',
  'agents.pool_limit_unset': 'err_pool_limit_unset',
  'agents.pool_limit_invalid': 'err_pool_limit_invalid',
  'agents.pool_allocation_invalid': 'err_pool_allocation_invalid',
  'agents.pool_over_limit': 'err_pool_over_limit',
  'agents.pool_unset': 'err_pool_unset',
  'agents.project_name_unset': 'err_project_name_unset',
  'agents.project_limit_unset': 'err_project_limit_unset',
  'agents.project_limit_invalid': 'err_project_limit_invalid',
  'agents.team_agent_not_found': 'err_team_agent_not_found',
  'agents.team_tool_not_declared': 'err_team_tool_not_declared',
  'agents.team_action_not_found': 'err_team_action_not_found',
  'agents.team_action_closed': 'err_team_action_closed',
  'agents.team_four_eyes': 'err_team_four_eyes',
  'agents.team_session_not_found': 'err_team_session_not_found',
  'agents.team.allocation_exceeded': 'err_allocation_exceeded',
  'agents.team.project_limit_exceeded': 'err_project_limit_exceeded',
  'agents.team.pool_exceeded': 'err_pool_exceeded',
  'agents.team.allocation_unset': 'err_allocation_unset',
  'agents.spend.cap_unset': 'err_cap_unset',
  'agents.spend.cap_exceeded': 'err_cap_exceeded',
  'agents.funds_insufficient': 'err_funds_insufficient',
  'agents.session_closed': 'err_session_closed',
  'agents.fee_asset_unset': 'err_fee_asset_unset',
  'agents.capability_unavailable': 'err_capability_unavailable',
} as const;

/**
 * The service's refusal code: its message when that is an `agents.` code (a run's guardrail and hold refusals arrive
 * that way, under the generic `agents.refused` cause), else the code the answer carried.
 */
const refusalCodeOf = (failed: Refusal): string =>
  /^agents\.[a-z_.]+$/.test(failed.message) ? failed.message : (failed.code ?? 'unknown');

/** A refusal said in the room's own words, never the service's text, with its code beside them. */
function RefusalText({ failed }: { failed: Refusal }) {
  const { t } = agentsTeamCopy.useCopy();
  const code = refusalCodeOf(failed);
  const key = Object.hasOwn(ERR_KEYS, code) ? ERR_KEYS[code as keyof typeof ERR_KEYS] : null;
  return (
    <>
      {key ? t(key) : t('err_other')} <code lang="zxx">{code}</code>
    </>
  );
}
type Note = { ok: true; text: string } | { ok: false; failed: Refusal } | { ok: false; text: string; code: string };
const NoteLine = ({ note }: { note: Note | null }) =>
  note === null ? null : note.ok ? (
    <p role="status">{note.text}</p>
  ) : (
    <p role="alert">
      {'failed' in note ? (
        <RefusalText failed={note.failed} />
      ) : (
        <>
          {note.text} <code lang="zxx">{note.code}</code>
        </>
      )}
    </p>
  );

/** The agents Team room (/agents/team): one business's agent roles, pool, project limits, runs, approvals and usage. */
export function AgentsTeam() {
  const api = useApi();
  const { userId } = useSession();
  const { Copy, t } = agentsTeamCopy.useCopy();
  // The businesses are the bank's own: the ones this person is a member of, closed ones included.
  const businesses = useResource(
    (signal) => api.query('bank', 'business.list', { limit: 50 }, businessListSchema, { signal }),
    `agents-team-businesses:${userId}`,
  );
  const [chosen, setChosen] = useState('');
  const list = businesses.resource.status === 'ready' ? businesses.resource.data : [];
  const businessId = list.some((b) => b.id === chosen) ? chosen : (list[0]?.id ?? '');

  if (businesses.resource.status === 'failed') {
    return (
      <Panel title={t('businessTitle')}>
        <p role="alert">
          <RefusalText failed={businesses.resource.failure} />
        </p>
        <Button variant="secondary" onClick={businesses.reload}>
          <Copy k="retry" />
        </Button>
      </Panel>
    );
  }
  if (businesses.resource.status !== 'ready') return <Loading />;
  if (!businessId) {
    return (
      <Panel title={t('businessTitle')}>
        <EmptyState title={<Copy k="noBusiness" />}>
          <a href="/bank/business">{t('manageMembers')}</a>
        </EmptyState>
      </Panel>
    );
  }
  return (
    <>
      <Panel title={t('businessTitle')}>
        <Select
          label={t('businessPick')}
          value={businessId}
          onChange={setChosen}
          options={list.map((b) => ({ value: b.id, label: b.status === 'closed' ? t('businessClosedName', { name: b.name }) : b.name }))}
        />
      </Panel>
      <TeamOf key={businessId} businessId={businessId} />
    </>
  );
}

function TeamOf({ businessId }: { businessId: string }) {
  const api = useApi();
  const { userId } = useSession();
  const { Copy, t } = agentsTeamCopy.useCopy();
  const team = useResource(
    (signal) => api.query('agents', 'team.view', { businessId }, agentsTeamViewSchema, { signal }),
    `agents-team:${userId}:${businessId}`,
  );
  // The last team read stays on screen while it is read again, so a form keeps what was typed.
  const [shown, setShown] = useState<Team | null>(null);
  useEffect(() => {
    if (team.resource.status === 'ready') setShown(team.resource.data);
    if (team.resource.status === 'failed') setShown(null);
  }, [team.resource]);

  if (team.resource.status === 'failed') {
    return (
      <Panel title={t('membersTitle')}>
        <p role="alert">
          <RefusalText failed={team.resource.failure} />
        </p>
        <p>
          <a href="/bank/business">
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
  const businessId = team.businessId;
  // A member reads as their business role; the account ID beside it tells two apart.
  const memberName = (m: Team['members'][number]) => t(`business_${m.businessRole}`);
  const name = (userId: string) => {
    const m = team.members.find((x) => x.userId === userId);
    return m ? `${memberName(m)} (${userId})` : userId;
  };
  const roleName = (role: Role) => t(`role_${role}`);
  const asset = team.pool?.assetId ?? '';
  const [busy, setBusy] = useState(false);
  const [rolesNote, setRolesNote] = useState<Note | null>(null);
  const [override, setOverride] = useState<Record<string, boolean>>({});
  // A saved tick stays shown until the team is read again, so the box never flips back to the old value in between.
  useEffect(() => setOverride({}), [team]);

  /** Saves one member's allow and deny for one role as that grant's next change. */
  async function saveGrant(memberUserId: string, role: Role, allow: boolean, deny: boolean, version: number) {
    setBusy(true);
    const result = await api.mutate(
      'agents',
      'team.grants.set',
      { businessId, memberUserId, role, allow, deny, revision: version + 1 },
      agentsTeamGrantResultSchema,
    );
    setBusy(false);
    setRolesNote(result.ok ? { ok: true, text: t('saved') } : { ok: false, failed: result as Refusal });
    // A refused change shows the stored value again at once; a saved one keeps its tick until the reload lands.
    if (!result.ok) setOverride({});
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
  const [poolNote, setPoolNote] = useState<Note | null>(null);
  async function savePool(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await api.mutate(
      'agents',
      'team.pool.set',
      {
        businessId,
        limit: poolLimit,
        allocations: team.members.map((m) => ({ memberUserId: m.userId, amount: allocations[m.userId] ?? '' })),
        revision: (team.pool?.version ?? 0) + 1,
      },
      agentsTeamPoolResultSchema,
    );
    setBusy(false);
    if (!result.ok) setPoolNote({ ok: false, failed: result as Refusal });
    else if (!result.data.ok) {
      const members = result.data.memberUserIds.map((id) => t('allocationFor', { member: name(id) })).join(', ');
      setPoolNote({ ok: false, text: t('err_pool_allocation_unset', { members }), code: result.data.code });
    } else setPoolNote({ ok: true, text: t('saved') });
    reload();
  }

  const [projectName, setProjectName] = useState('');
  const [projectLimit, setProjectLimit] = useState('');
  const [projectMembers, setProjectMembers] = useState<string[]>([]);
  const [projectNote, setProjectNote] = useState<Note | null>(null);
  async function createProject(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await api.mutate(
      'agents',
      'team.projects.create',
      { businessId, name: projectName, limit: projectLimit, memberUserIds: projectMembers, seq: team.nextProjectSeq },
      agentsTeamProjectResultSchema,
    );
    setBusy(false);
    if (result.ok) {
      setProjectNote({ ok: true, text: t('saved') });
      setProjectName('');
      setProjectLimit('');
      setProjectMembers([]);
    } else setProjectNote({ ok: false, failed: result as Refusal });
    reload();
  }

  const locked = busy || !team.canManage;

  return (
    <>
      <Panel title={t('membersTitle')}>
        <p className="muted">
          <Copy k="membersNote" /> <a href="/bank/business">{t('manageMembers')}</a>
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
                      <Checkbox
                        checked={allow}
                        disabled={locked}
                        aria-label={t('allowRole', { role: roleName(g.role) })}
                        onCheckedChange={(on) => toggle('allow', on)}
                      />{' '}
                      <Copy k="allowed" />
                    </label>
                    <label>
                      <Checkbox
                        checked={deny}
                        disabled={locked}
                        aria-label={t('denyRole', { role: roleName(g.role) })}
                        onCheckedChange={(on) => toggle('deny', on)}
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
        <NoteLine note={rolesNote} />
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
              { label: t('poolLimitShown'), value: <span data-testid="pool-limit">{`${team.pool.limit} ${asset}`}</span> },
              { label: t('poolAllocated'), value: <span data-testid="pool-allocated">{`${team.pool.allocated} ${asset}`}</span> },
              { label: t('poolUsed'), value: <span data-testid="pool-used">{`${team.used} ${asset}`}</span> },
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
              label={t('allocationFor', { member: name(m.userId) })}
              inputMode="decimal"
              value={allocations[m.userId] ?? ''}
              disabled={locked}
              onChange={(e) => setAllocations((a) => ({ ...a, [m.userId]: e.target.value }))}
            />
          ))}
          <NoteLine note={poolNote} />
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
                <Checkbox
                  checked={projectMembers.includes(m.userId)}
                  disabled={locked}
                  onCheckedChange={(on) => setProjectMembers((list) => (on ? [...list, m.userId] : list.filter((id) => id !== m.userId)))}
                />{' '}
                {name(m.userId)}
              </label>
            ))}
          </fieldset>
          <NoteLine note={projectNote} />
          <Button type="submit" disabled={locked}>
            <Copy k="createProject" />
          </Button>
        </form>
      </Panel>

      <Panel title={t('limitsTitle')}>
        <DataTable
          label={t('limitsTitle')}
          headers={[t('colMember'), t('colAccount'), t('colAllocation'), t('colUsed'), t('colProjectLimits')]}
        >
          {team.members.map((m) => {
            const projects = team.projects.filter((p) => p.memberUserIds.includes(m.userId));
            return (
              <tr key={m.userId}>
                <th scope="row">{memberName(m)}</th>
                <td>
                  <code>{m.userId}</code>
                </td>
                <td>{m.allocation !== null && team.pool ? `${m.allocation} ${asset}` : t('noAllocation')}</td>
                <td data-testid="member-used">{`${m.used} ${asset}`.trim()}</td>
                <td>{projects.length ? projects.map((p) => `${p.name}: ${p.limit} ${p.assetId}`).join('; ') : t('noProjectLimit')}</td>
              </tr>
            );
          })}
        </DataTable>
      </Panel>

      <TeamRuns businessId={businessId} onRun={reload} />
      <HeldActions team={team} name={name} />
      <TeamUsage team={team} name={name} />
    </>
  );
}

const ownAgentsSchema = z.array(ownAgentSchema);

/** Runs of the person's own agent on the business pool: each checked against their allocation, projects and the pool. */
function TeamRuns({ businessId, onRun }: { businessId: string; onRun: () => void }) {
  const api = useApi();
  const { Copy, t } = agentsTeamCopy.useCopy();
  const mine = useResource((signal) => api.query('agents', 'own.list', { limit: 50 }, ownAgentsSchema, { signal }), 'agents-team-own');
  const agents = mine.resource.status === 'ready' ? mine.resource.data : [];
  const [agentId, setAgentId] = useState('');
  const chosen = agents.some((a) => a.id === agentId) ? agentId : (agents[0]?.id ?? '');
  const [session, setSession] = useState<string | null>(null);
  const [ask, setAsk] = useState('');
  const [reply, setReply] = useState<z.infer<typeof agentsTeamRunResultSchema> | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per run asked on this page: a retried press after a lost answer is the same run, never a second one.
  const runKey = useRef<string | null>(null);

  async function open() {
    setBusy(true);
    const result = await api.mutate('agents', 'team.runs.open', { businessId, agentId: chosen }, agentsTeamRunSessionSchema);
    setBusy(false);
    setReply(null);
    if (result.ok) {
      setSession(result.data.sessionId);
      setNote(null);
    } else setNote({ ok: false, failed: result as Refusal });
  }
  async function run(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    runKey.current ??= crypto.randomUUID();
    setBusy(true);
    const result = await api.mutate(
      'agents',
      'team.runs.run',
      { businessId, sessionId: session, requestId: runKey.current, ask },
      agentsTeamRunResultSchema,
    );
    setBusy(false);
    runKey.current = null;
    if (result.ok) {
      setReply(result.data);
      setNote(null);
    } else {
      setReply(null);
      setNote({ ok: false, failed: result as Refusal });
    }
    onRun();
  }
  async function close() {
    if (!session) return;
    setBusy(true);
    const result = await api.mutate('agents', 'team.runs.close', { businessId, sessionId: session }, agentsTeamRunClosedSchema);
    setBusy(false);
    if (result.ok) {
      setSession(null);
      setNote({ ok: true, text: t('runClosed') });
    } else setNote({ ok: false, failed: result as Refusal });
    onRun();
  }

  return (
    <Panel title={t('runsTitle')} aria-label={t('runsTitle')}>
      <p className="muted">
        <Copy k="runsNote" />
      </p>
      {mine.resource.status === 'failed' ? (
        <p role="alert">
          <RefusalText failed={mine.resource.failure} />
        </p>
      ) : agents.length === 0 ? (
        <EmptyState title={<Copy k="runsNoAgent" />}>
          <a href="/agents/new">{t('runsMakeAgent')}</a>
        </EmptyState>
      ) : (
        <>
          <Select
            label={t('runsAgent')}
            value={chosen}
            onChange={setAgentId}
            options={agents.map((a) => ({ value: a.id, label: a.name || t('runsUntitled') }))}
          />
          {session ? (
            <form aria-label={t('runsTitle')} onSubmit={run}>
              <p data-testid="run-session">{t('runSession', { session })}</p>
              <Field label={t('runAsk')} value={ask} disabled={busy} onChange={(e) => setAsk(e.target.value)} />
              <div className="actions">
                <Button type="submit" disabled={busy || !ask.trim()}>
                  <Copy k="run" />
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => void close()}>
                  <Copy k="runClose" />
                </Button>
              </div>
            </form>
          ) : (
            <Button disabled={busy || !chosen} onClick={() => void open()}>
              <Copy k="runOpen" />
            </Button>
          )}
        </>
      )}
      {reply ? (
        <section aria-label={t('runReply')}>
          <p>{reply.text}</p>
          <p data-testid="run-cost">{`${reply.cost} ${reply.assetId}`}</p>
        </section>
      ) : null}
      <NoteLine note={note} />
    </Panel>
  );
}

const heldListSchema = z.array(agentsTeamHeldActionSchema);

/** Tool actions of members' agents that wait for an approver who is not the agent's creator (four eyes). */
function HeldActions({ team, name }: { team: Team; name: (userId: string) => string }) {
  const api = useApi();
  const { Copy, t } = agentsTeamCopy.useCopy();
  const businessId = team.businessId;
  const held = useResource(
    (signal) => api.query('agents', 'team.actions.list', { businessId, limit: 50 }, heldListSchema, { signal }),
    `agents-team-held:${businessId}`,
  );
  const mine = useResource((signal) => api.query('agents', 'own.list', { limit: 50 }, ownAgentsSchema, { signal }), 'agents-team-own');
  const agents = mine.resource.status === 'ready' ? mine.resource.data : [];
  const [agentId, setAgentId] = useState('');
  const agent = agents.find((a) => a.id === agentId) ?? agents[0];
  const [tool, setTool] = useState('');
  const chosenTool = agent?.tools.includes(tool) ? tool : (agent?.tools[0] ?? '');
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = held.resource.status === 'ready' ? held.resource.data : [];
  const nextSeq = rows.length + 1;

  async function propose(event: FormEvent) {
    event.preventDefault();
    if (!agent) return;
    setBusy(true);
    const result = await api.mutate(
      'agents',
      'team.actions.hold',
      { businessId, agentId: agent.id, tool: chosenTool, seq: nextSeq },
      agentsTeamHeldActionResultSchema,
    );
    setBusy(false);
    setNote(result.ok ? { ok: true, text: t('heldSaved') } : { ok: false, failed: result as Refusal });
    held.reload();
  }
  async function approve(actionId: string) {
    setBusy(true);
    const result = await api.mutate('agents', 'team.actions.approve', { businessId, actionId }, agentsTeamHeldActionResultSchema);
    setBusy(false);
    setNote(result.ok ? { ok: true, text: t('approvedSaved') } : { ok: false, failed: result as Refusal });
    held.reload();
  }

  return (
    <Panel title={t('approvalsTitle')} aria-label={t('approvalsTitle')}>
      <p className="muted">
        <Copy k="approvalsNote" />
      </p>
      {held.resource.status === 'failed' ? (
        <p role="alert">
          <RefusalText failed={held.resource.failure} />
        </p>
      ) : rows.length ? (
        <DataTable label={t('heldTitle')} headers={[t('colAction'), t('colCreator'), t('colTool'), t('colStatus'), t('colApprover')]}>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">
                <code>{row.id}</code>
              </th>
              <td>{name(row.creatorUserId)}</td>
              <td>
                <code>{row.tool}</code>
              </td>
              <td data-testid="held-status">{row.status === 'held' ? t('statusHeld') : t('statusApproved')}</td>
              <td>
                {row.approvedBy ? (
                  name(row.approvedBy)
                ) : (
                  <Button variant="secondary" disabled={busy} onClick={() => void approve(row.id)}>
                    <Copy k="approve" />
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      ) : (
        <EmptyState title={<Copy k="heldEmpty" />} />
      )}
      {agent ? (
        <form aria-label={t('proposeTitle')} onSubmit={propose}>
          <h3>
            <Copy k="proposeTitle" />
          </h3>
          <div className="depth-filters">
            <Select
              label={t('runsAgent')}
              value={agent.id}
              onChange={setAgentId}
              options={agents.map((a) => ({ value: a.id, label: a.name || t('runsUntitled') }))}
            />
            <Select label={t('proposeTool')} value={chosenTool} onChange={setTool} options={agent.tools} />
          </div>
          <Button type="submit" disabled={busy || !chosenTool}>
            <Copy k="propose" />
          </Button>
        </form>
      ) : null}
      <NoteLine note={note} />
    </Panel>
  );
}

/** Usage by member and task, from sealed windows of the business's team runs, for current members only. */
function TeamUsage({ team, name }: { team: Team; name: (userId: string) => string }) {
  const api = useApi();
  const { Copy, t } = agentsTeamCopy.useCopy();
  const usage = useResource(
    (signal) => api.query('agents', 'team.usage', { businessId: team.businessId }, agentsTeamUsageSchema, { signal }),
    `agents-team-usage:${team.businessId}:${team.used}`,
  );
  return (
    <Panel title={t('usageTitle')} aria-label={t('usageTitle')}>
      <p className="muted">
        <Copy k="usageNote" />
      </p>
      {usage.resource.status === 'failed' ? (
        <p role="alert">
          <RefusalText failed={usage.resource.failure} />
        </p>
      ) : usage.resource.status !== 'ready' ? (
        <Loading />
      ) : (
        <UsageTable data={usage.resource.data} name={name} />
      )}
    </Panel>
  );
}

function UsageTable({ data, name }: { data: z.infer<typeof agentsTeamUsageSchema>; name: (userId: string) => string }) {
  const { Copy, t } = agentsTeamCopy.useCopy();
  return (
    <>
      <DataTable
        label={t('usageTitle')}
        headers={[t('colMember'), t('colWindows'), t('colTask'), t('colTokens'), t('colTaskCost'), t('colSealedTotal')]}
      >
        {data.members.map((m) => (
          <tr key={m.userId}>
            <th scope="row">{name(m.userId)}</th>
            <td>{m.windows}</td>
            <td>{m.tasks.length ? m.tasks.map((x) => x.task).join(', ') : t('usageNoTask')}</td>
            <td>{m.tasks.map((x) => t('usageTokens', { input: String(x.inputTokens), output: String(x.outputTokens) })).join('; ')}</td>
            <td>{m.tasks.map((x) => `${x.cost} ${data.assetId}`).join('; ')}</td>
            <td data-testid="usage-member-total">{`${m.sealedTotal} ${data.assetId}`}</td>
          </tr>
        ))}
      </DataTable>
      <p>
        <Copy k="usageTotal" /> <span data-testid="usage-total">{`${data.sealedTotal} ${data.assetId}`}</span>
      </p>
    </>
  );
}
