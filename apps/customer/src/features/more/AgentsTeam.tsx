// volt-room: /agents/team
import { BANK_BUSINESS_LIST } from '@intafaced/contracts/bank-business-procedures';
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { AGENTS_TEAM_ROLES, type AgentsTeamRole, type AgentsTeamView } from '@intafaced/contracts/agents-team';
import { AGENTS_OWN_LIST } from '@intafaced/contracts/agents-own-procedures';
import {
  AGENTS_TEAM_VIEW,
  AGENTS_TEAM_GRANTS_SET,
  AGENTS_TEAM_POOL_SET,
  AGENTS_TEAM_PROJECTS_CREATE,
  AGENTS_TEAM_RUNS_OPEN,
  AGENTS_TEAM_RUNS_RUN,
  AGENTS_TEAM_RUNS_CLOSE,
  AGENTS_TEAM_ACTIONS_LIST,
  AGENTS_TEAM_ACTIONS_HOLD,
  AGENTS_TEAM_ACTIONS_APPROVE,
  AGENTS_TEAM_USAGE,
} from '@intafaced/contracts/agents-team-procedures';
import { type ProcedureOutput } from '@intafaced/contracts/procedure';
import type { ApiResult, RefusalReason } from '../../shared/api';
import { Button, Checkbox, EmptyState, Field, Select } from '@intafaced/ui/lit';
import { KeyValue, SettingsTemplate, Skeleton, type RoomState } from '@intafaced/ui/lit/templates';
import { useResource } from '../../shared/resource';
import { useApi, useSession } from '../session';
import { agentsTeamCopy } from './agents-team-copy';

const ROLES = AGENTS_TEAM_ROLES;
type Role = AgentsTeamRole;
type Team = AgentsTeamView;

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
/** A grant change sent and not yet seen in a team read. */
type PendingGrant = { memberUserId: string; role: Role; allow: boolean; deny: boolean; version: number };
/** The stored version of one member's grant for one role in a team read; 0 when the read holds none. */
const grantVersion = (team: Team, memberUserId: string, role: Role) =>
  team.members.find((m) => m.userId === memberUserId)?.grants.find((g) => g.role === role)?.version ?? 0;
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

/** A refusal that may hide an answer the service already gave: the next press resends the same run. */
const ANSWER_UNKNOWN = new Set<RefusalReason>(['unreachable', 'aborted', 'uncertain', 'invalid_response']);
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

/** A table in the kit's look, named as a region so a reader (and a test) finds it by its name. */
function Grid({ headers, children, label }: { headers: readonly string[]; children: ReactNode; label: string }) {
  return (
    <div tabIndex={0} role="region" aria-label={label}>
      <table className="lt-table">
        <thead>
          <tr>
            {headers.map((head, index) => (
              <th key={index} scope="col">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{Children.map(children, (row) => labelled(row, headers))}</tbody>
      </table>
    </div>
  );
}

type Cell = ReactElement<{ children?: ReactNode; 'data-label'?: string }>;

/**
 * A phone stacks each row and names each value by its column (the kit's lt-table reads `data-label`), so each cell of
 * a row takes its column's words; a row header (`th`) keeps its own.
 */
function labelled(row: ReactNode, headers: readonly string[]): ReactNode {
  if (!isValidElement<{ children?: ReactNode }>(row)) return row;
  const cells = Children.toArray(row.props.children).map((cell, i) =>
    isValidElement(cell) && cell.type === 'td' ? cloneElement(cell as Cell, { 'data-label': headers[i] }) : cell,
  );
  return cloneElement(row, undefined, ...cells);
}

/** The room's sections, each a link to its part of the page. */
const SECTIONS = [
  ['members', 'membersTitle'],
  ['pool', 'poolTitle'],
  ['projects', 'projectsTitle'],
  ['limits', 'limitsTitle'],
  ['runs', 'runsTitle'],
  ['approvals', 'approvalsTitle'],
  ['usage', 'usageTitle'],
] as const;

/** The agents Team room (/agents/team): one business's agent roles, pool, project limits, runs, approvals and usage. */
export function AgentsTeam() {
  const api = useApi();
  const { userId } = useSession();
  const { t } = agentsTeamCopy.useCopy();
  // The businesses are the bank's own: the ones this person is a member of, closed ones included.
  const businesses = useResource((signal) => api.call(BANK_BUSINESS_LIST, { limit: 50 }, { signal }), `agents-team-businesses:${userId}`);
  const [chosen, setChosen] = useState('');
  const list = businesses.resource.status === 'ready' ? businesses.resource.data : [];
  const businessId = list.some((b) => b.id === chosen) ? chosen : (list[0]?.id ?? '');

  if (businesses.resource.status === 'ready' && businessId) {
    const picker = (
      <section>
        <h2>{t('businessTitle')}</h2>
        <Select
          label={t('businessPick')}
          value={businessId}
          onChange={setChosen}
          options={list.map((b) => ({ value: b.id, label: b.status === 'closed' ? t('businessClosedName', { name: b.name }) : b.name }))}
        />
      </section>
    );
    return <TeamOf key={businessId} businessId={businessId} picker={picker} />;
  }
  let state: RoomState;
  if (businesses.resource.status === 'failed') state = refusedState(t, businesses.resource.failure, t('businessTitle'));
  else if (businesses.resource.status !== 'ready') state = { kind: 'loading' };
  else state = { kind: 'empty', title: t('noBusiness'), action: { label: t('manageMembers'), href: '/bank/business' } };
  return <TeamShell state={state} retry={businesses.resource.status === 'failed' ? businesses.reload : undefined} />;
}

type T = ReturnType<typeof agentsTeamCopy.useCopy>['t'];

/** A read the room could not make: its title, the room's own words for the code, and the code. */
function refusedState(t: T, failed: Refusal, title: string, action?: { label: string; href: string }): RoomState {
  const code = refusalCodeOf(failed);
  const key = Object.hasOwn(ERR_KEYS, code) ? ERR_KEYS[code as keyof typeof ERR_KEYS] : null;
  return {
    kind: 'refused',
    refusal: {
      variant: ANSWER_UNKNOWN.has(failed.reason) ? 'unreachable' : 'refused',
      title,
      body: key ? t(key) : t('err_other'),
      reference: code,
      action,
    },
  };
}

/** The room on its template. A read that failed offers to read again (`retry`), in place. */
function TeamShell({ state, sections, retry }: { state: RoomState; sections?: ReactNode; retry?: () => void }) {
  const { t } = agentsTeamCopy.useCopy();
  return (
    <SettingsTemplate
      title={t('title')}
      description={t('description')}
      state={state}
      roomAction={
        retry ? (
          <Button tone="secondary" onClick={retry}>
            {t('retry')}
          </Button>
        ) : undefined
      }
      index={
        <nav aria-label={t('sectionsLabel')}>
          <ul>
            {SECTIONS.map(([id, key]) => (
              <li key={id}>
                <a className="lt-link" href={`#agents-team-${id}`}>
                  {t(key)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      }
      sections={sections ?? null}
      explain={<p>{t('explain')}</p>}
    />
  );
}

function TeamOf({ businessId, picker }: { businessId: string; picker: ReactNode }) {
  const api = useApi();
  const { userId } = useSession();
  const { t } = agentsTeamCopy.useCopy();
  const team = useResource((signal) => api.call(AGENTS_TEAM_VIEW, { businessId }, { signal }), `agents-team:${userId}:${businessId}`);
  // The last team read stays on screen while it is read again, so a form keeps what was typed.
  const [shown, setShown] = useState<Team | null>(null);
  useEffect(() => {
    if (team.resource.status === 'ready') setShown(team.resource.data);
    if (team.resource.status === 'failed') setShown(null);
  }, [team.resource]);

  if (team.resource.status === 'failed')
    return (
      <TeamShell
        state={refusedState(t, team.resource.failure, t('membersTitle'), { label: t('manageMembers'), href: '/bank/business' })}
        retry={team.reload}
      />
    );
  if (!shown) return <TeamShell state={{ kind: 'loading' }} />;
  return (
    <TeamShell
      state={{ kind: 'ready' }}
      sections={
        <>
          {picker}
          <TeamRoom team={shown} reload={team.reload} />
        </>
      }
    />
  );
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
  const [pending, setPending] = useState<PendingGrant | null>(null);
  // A changed grant stays shown, and the boxes stay locked, until a team read that holds the change (the grant's newer
  // version) lands: a read sent before the save never flips the box back, and the next change is sent on the grant's
  // new version, never the one just used.
  const unseen = pending && grantVersion(team, pending.memberUserId, pending.role) <= pending.version ? pending : null;
  const shownGrant = (memberUserId: string, g: Team['members'][number]['grants'][number]) =>
    unseen && unseen.memberUserId === memberUserId && unseen.role === g.role ? unseen : g;

  /** Saves one member's allow and deny for one role as that grant's next change. */
  async function saveGrant(memberUserId: string, role: Role, allow: boolean, deny: boolean, version: number) {
    setBusy(true);
    setPending({ memberUserId, role, allow, deny, version });
    const result = await api.call(AGENTS_TEAM_GRANTS_SET, { businessId, memberUserId, role, allow, deny, revision: version + 1 });
    setBusy(false);
    setRolesNote(result.ok ? { ok: true, text: t('saved') } : { ok: false, failed: result as Refusal });
    // A refused change shows the stored value again at once; a saved one keeps its tick until a read holding it lands.
    if (!result.ok) setPending(null);
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
    const result = await api.call(AGENTS_TEAM_POOL_SET, {
      businessId,
      limit: poolLimit,
      allocations: team.members.map((m) => ({ memberUserId: m.userId, amount: allocations[m.userId] ?? '' })),
      revision: (team.pool?.version ?? 0) + 1,
    });
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
    const result = await api.call(AGENTS_TEAM_PROJECTS_CREATE, {
      businessId,
      name: projectName,
      limit: projectLimit,
      memberUserIds: projectMembers,
      seq: team.nextProjectSeq,
    });
    setBusy(false);
    if (result.ok) {
      setProjectNote({ ok: true, text: t('saved') });
      setProjectName('');
      setProjectLimit('');
      setProjectMembers([]);
    } else setProjectNote({ ok: false, failed: result as Refusal });
    reload();
  }

  const locked = busy || !!unseen || !team.canManage;

  return (
    <>
      <section id="agents-team-members">
        <h2>{t('membersTitle')}</h2>
        <p className="lt-hint">
          <Copy k="membersNote" /> <a href="/bank/business">{t('manageMembers')}</a>
        </p>
        {team.canManage ? null : (
          <p className="lt-hint">
            <Copy k="readOnly" />
          </p>
        )}
        <Grid
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
                const { allow, deny } = shownGrant(m.userId, g);
                const toggle = (effect: 'allow' | 'deny', value: boolean) =>
                  void saveGrant(m.userId, g.role, effect === 'allow' ? value : allow, effect === 'deny' ? value : deny, g.version);
                return (
                  <td key={g.role}>
                    <Checkbox
                      checked={allow}
                      disabled={locked}
                      aria-label={t('allowRole', { role: roleName(g.role) })}
                      onCheckedChange={(on) => toggle('allow', on)}
                    >
                      <Copy k="allowed" />
                    </Checkbox>
                    <Checkbox
                      checked={deny}
                      disabled={locked}
                      aria-label={t('denyRole', { role: roleName(g.role) })}
                      onCheckedChange={(on) => toggle('deny', on)}
                    >
                      <Copy k="denied" />
                    </Checkbox>
                    <span className="lt-hint" data-testid={`effective-${g.role}`}>
                      {g.deny ? t('denied') : g.allow ? t('allowed') : t('notGranted')}
                    </span>
                  </td>
                );
              })}
              <td data-testid="effective-roles">{m.effective.length ? m.effective.map(roleName).join(', ') : t('noRoles')}</td>
            </tr>
          ))}
        </Grid>
        <NoteLine note={rolesNote} />
        <form aria-label={t('grantTitle')} onSubmit={grantToAccount}>
          <h3>
            <Copy k="grantTitle" />
          </h3>
          <div className="lt-toolbar">
            <Field label={t('grantAccount')} value={grantTo} disabled={locked} onChange={(e) => setGrantTo(e.target.value)} />
            <Select
              label={t('grantRole')}
              value={grantRole}
              onChange={(value) => setGrantRole(value as Role)}
              options={ROLES.map((role) => ({ value: role, label: roleName(role) }))}
            />
          </div>
          <Button tone="primary" type="submit" disabled={locked || !grantTo.trim()}>
            <Copy k="grant" />
          </Button>
        </form>
      </section>

      <section id="agents-team-pool">
        <h2>{t('poolTitle')}</h2>
        <p className="lt-hint">
          <Copy k="poolNote" />
        </p>
        {team.pool ? (
          <KeyValue
            rows={[
              { label: t('poolLimitShown'), value: <span data-testid="pool-limit">{`${team.pool.limit} ${asset}`}</span> },
              { label: t('poolAllocated'), value: <span data-testid="pool-allocated">{`${team.pool.allocated} ${asset}`}</span> },
              { label: t('poolUsed'), value: <span data-testid="pool-used">{`${team.used} ${asset}`}</span> },
            ]}
          />
        ) : (
          <EmptyState title={t('poolNone')} />
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
          <Button tone="primary" type="submit" disabled={locked}>
            <Copy k="savePool" />
          </Button>
        </form>
      </section>

      <section id="agents-team-projects">
        <h2>{t('projectsTitle')}</h2>
        {team.projects.length ? (
          <Grid label={t('projectsTitle')} headers={[t('colProject'), t('colLimit'), t('colMembers')]}>
            {team.projects.map((p) => (
              <tr key={p.id}>
                <th scope="row">{p.name}</th>
                <td>{`${p.limit} ${p.assetId}`}</td>
                <td>{p.memberUserIds.map(name).join(', ')}</td>
              </tr>
            ))}
          </Grid>
        ) : (
          <EmptyState title={t('projectsEmpty')} />
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
              <Checkbox
                key={m.userId}
                checked={projectMembers.includes(m.userId)}
                disabled={locked}
                onCheckedChange={(on) => setProjectMembers((list) => (on ? [...list, m.userId] : list.filter((id) => id !== m.userId)))}
              >
                {name(m.userId)}
              </Checkbox>
            ))}
          </fieldset>
          <NoteLine note={projectNote} />
          <Button tone="primary" type="submit" disabled={locked}>
            <Copy k="createProject" />
          </Button>
        </form>
      </section>

      <section id="agents-team-limits">
        <h2>{t('limitsTitle')}</h2>
        <Grid label={t('limitsTitle')} headers={[t('colMember'), t('colAccount'), t('colAllocation'), t('colUsed'), t('colProjectLimits')]}>
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
        </Grid>
      </section>

      <TeamRuns businessId={businessId} onRun={reload} />
      <HeldActions team={team} name={name} />
      <TeamUsage team={team} name={name} />
    </>
  );
}

/** Runs of the person's own agent on the business pool: each checked against their allocation, projects and the pool. */
function TeamRuns({ businessId, onRun }: { businessId: string; onRun: () => void }) {
  const api = useApi();
  const { Copy, t } = agentsTeamCopy.useCopy();
  const mine = useResource((signal) => api.call(AGENTS_OWN_LIST, { limit: 50 }, { signal }), 'agents-team-own');
  const agents = mine.resource.status === 'ready' ? mine.resource.data : [];
  const [agentId, setAgentId] = useState('');
  const chosen = agents.some((a) => a.id === agentId) ? agentId : (agents[0]?.id ?? '');
  const [session, setSession] = useState<string | null>(null);
  const [ask, setAsk] = useState('');
  const [reply, setReply] = useState<ProcedureOutput<typeof AGENTS_TEAM_RUNS_RUN> | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  // Each run of a session is keyed by the session and its number there, a business key. A press after a lost or
  // unread answer sends the same key, so the service answers it as that run (a replay), never as a second charge; the
  // number moves on only once the service gave its answer or its typed refusal.
  const runCount = useRef(0);

  async function open() {
    setBusy(true);
    const result = await api.call(AGENTS_TEAM_RUNS_OPEN, { businessId, agentId: chosen });
    setBusy(false);
    setReply(null);
    if (result.ok) {
      setSession(result.data.sessionId);
      runCount.current = 0;
      setNote(null);
    } else setNote({ ok: false, failed: result as Refusal });
  }
  async function run(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    const requestId = `run:${session}:${runCount.current + 1}`;
    setBusy(true);
    const result = await api.call(AGENTS_TEAM_RUNS_RUN, { businessId, sessionId: session, requestId, ask });
    setBusy(false);
    if (result.ok || !ANSWER_UNKNOWN.has(result.reason)) runCount.current += 1;
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
    const result = await api.call(AGENTS_TEAM_RUNS_CLOSE, { businessId, sessionId: session });
    setBusy(false);
    if (result.ok) {
      setSession(null);
      setNote({ ok: true, text: t('runClosed') });
    } else setNote({ ok: false, failed: result as Refusal });
    onRun();
  }

  return (
    <section id="agents-team-runs" aria-label={t('runsTitle')}>
      <h2>{t('runsTitle')}</h2>
      <p className="lt-hint">
        <Copy k="runsNote" />
      </p>
      {mine.resource.status === 'failed' ? (
        <p role="alert">
          <RefusalText failed={mine.resource.failure} />
        </p>
      ) : agents.length === 0 ? (
        <EmptyState
          title={t('runsNoAgent')}
          action={
            <a className="lt-link" href="/agents/new">
              {t('runsMakeAgent')}
            </a>
          }
        />
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
              <div className="lt-actions">
                <Button tone="primary" type="submit" disabled={busy || !ask.trim()}>
                  <Copy k="run" />
                </Button>
                <Button tone="secondary" disabled={busy} onClick={() => void close()}>
                  <Copy k="runClose" />
                </Button>
              </div>
            </form>
          ) : (
            <Button tone="primary" disabled={busy || !chosen} onClick={() => void open()}>
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
    </section>
  );
}

/** Tool actions of members' agents that wait for an approver who is not the agent's creator (four eyes). */
function HeldActions({ team, name }: { team: Team; name: (userId: string) => string }) {
  const api = useApi();
  const { Copy, t } = agentsTeamCopy.useCopy();
  const businessId = team.businessId;
  const held = useResource(
    (signal) => api.call(AGENTS_TEAM_ACTIONS_LIST, { businessId, limit: 50 }, { signal }),
    `agents-team-held:${businessId}`,
  );
  const mine = useResource((signal) => api.call(AGENTS_OWN_LIST, { limit: 50 }, { signal }), 'agents-team-own');
  const agents = mine.resource.status === 'ready' ? mine.resource.data : [];
  const [agentId, setAgentId] = useState('');
  const agent = agents.find((a) => a.id === agentId) ?? agents[0];
  const [tool, setTool] = useState('');
  const chosenTool = agent?.tools.includes(tool) ? tool : (agent?.tools[0] ?? '');
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = held.resource.status === 'ready' ? held.resource.data : [];
  // The list is newest first; the next proposal is the latest number plus one, whatever the list's length.
  const nextSeq = (rows[0]?.seq ?? 0) + 1;

  async function propose(event: FormEvent) {
    event.preventDefault();
    if (!agent) return;
    setBusy(true);
    const result = await api.call(AGENTS_TEAM_ACTIONS_HOLD, { businessId, agentId: agent.id, tool: chosenTool, seq: nextSeq });
    setBusy(false);
    setNote(result.ok ? { ok: true, text: t('heldSaved') } : { ok: false, failed: result as Refusal });
    held.reload();
  }
  async function approve(actionId: string) {
    setBusy(true);
    const result = await api.call(AGENTS_TEAM_ACTIONS_APPROVE, { businessId, actionId });
    setBusy(false);
    setNote(result.ok ? { ok: true, text: t('approvedSaved') } : { ok: false, failed: result as Refusal });
    held.reload();
  }

  return (
    <section id="agents-team-approvals" aria-label={t('approvalsTitle')}>
      <h2>{t('approvalsTitle')}</h2>
      <p className="lt-hint">
        <Copy k="approvalsNote" />
      </p>
      {held.resource.status === 'failed' ? (
        <p role="alert">
          <RefusalText failed={held.resource.failure} />
        </p>
      ) : rows.length ? (
        <Grid label={t('heldTitle')} headers={[t('colAction'), t('colCreator'), t('colTool'), t('colStatus'), t('colApprover')]}>
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
                  <Button tone="secondary" disabled={busy} onClick={() => void approve(row.id)}>
                    <Copy k="approve" />
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Grid>
      ) : (
        <EmptyState title={t('heldEmpty')} />
      )}
      {agent ? (
        <form aria-label={t('proposeTitle')} onSubmit={propose}>
          <h3>
            <Copy k="proposeTitle" />
          </h3>
          <div className="lt-toolbar">
            <Select
              label={t('runsAgent')}
              value={agent.id}
              onChange={setAgentId}
              options={agents.map((a) => ({ value: a.id, label: a.name || t('runsUntitled') }))}
            />
            <Select label={t('proposeTool')} value={chosenTool} onChange={setTool} options={agent.tools} />
          </div>
          <Button tone="primary" type="submit" disabled={busy || !chosenTool || held.resource.status !== 'ready'}>
            <Copy k="propose" />
          </Button>
        </form>
      ) : null}
      <NoteLine note={note} />
    </section>
  );
}

/** Usage by member and task, from sealed windows of the business's team runs, for current members only. */
function TeamUsage({ team, name }: { team: Team; name: (userId: string) => string }) {
  const api = useApi();
  const { Copy, t } = agentsTeamCopy.useCopy();
  const usage = useResource(
    (signal) => api.call(AGENTS_TEAM_USAGE, { businessId: team.businessId }, { signal }),
    `agents-team-usage:${team.businessId}:${team.used}`,
  );
  return (
    <section id="agents-team-usage" aria-label={t('usageTitle')}>
      <h2>{t('usageTitle')}</h2>
      <p className="lt-hint">
        <Copy k="usageNote" />
      </p>
      {usage.resource.status === 'failed' ? (
        <p role="alert">
          <RefusalText failed={usage.resource.failure} />
        </p>
      ) : usage.resource.status !== 'ready' ? (
        <Skeleton shape="rows" />
      ) : (
        <UsageTable data={usage.resource.data} name={name} />
      )}
    </section>
  );
}

function UsageTable({ data, name }: { data: ProcedureOutput<typeof AGENTS_TEAM_USAGE>; name: (userId: string) => string }) {
  const { Copy, t } = agentsTeamCopy.useCopy();
  return (
    <>
      <Grid
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
      </Grid>
      <p>
        <Copy k="usageTotal" /> <span data-testid="usage-total">{`${data.sealedTotal} ${data.assetId}`}</span>
      </p>
      <h3>{t('windowsTitle')}</h3>
      <p className="lt-hint">
        <Copy k="windowsNote" />
      </p>
      {data.windows.length === 0 ? (
        <p>
          <Copy k="windowsEmpty" />
        </p>
      ) : (
        <Grid
          label={t('windowsTitle')}
          headers={[t('colWindowMember'), t('colWindowCost'), t('colWindowOwedBy'), t('colWindowPaid'), t('colWindowKey')]}
        >
          {data.windows.map((w) => (
            <tr key={`${w.sessionId}:${w.windowId}`} data-testid="sealed-window">
              <th scope="row">{name(w.userId)}</th>
              <td data-testid="window-cost">{`${w.amount} ${data.assetId}`}</td>
              <td data-testid="window-owed-by">{w.owedBy === 'business' ? t('owedByBusiness') : t('owedByMember')}</td>
              <td data-testid="window-paid">
                {w.payment
                  ? t('windowPaidFrom', { label: w.payment.label, ref: w.payment.ref })
                  : w.state === 'settled'
                    ? t('windowPaidMember')
                    : t('windowOwed')}
              </td>
              <td>
                <code data-testid="window-charge-key">{w.chargeKey ?? ''}</code>
              </td>
            </tr>
          ))}
        </Grid>
      )}
    </>
  );
}
