import { useState } from 'react';
import { useApi } from '../session';
import { useResource, type Resource } from '../../shared/resource';
import { displayAmount } from '../../shared/money';
import { Button, Field, Tag } from '@intafaced/ui/lit';
import { Checkbox } from '@intafaced/ui/lit/templates';
import { Details, Read, Select } from './common';
import { EmptyNote, ScrollTable, Section, Waiting } from './volt-parts';
import {
  actionLogRows,
  ACTION_LOG_HEADER,
  agentEnabled,
  agentUse,
  AGENT_CATALOGUE,
  catalogueFromStored,
  filterCatalogue,
  sortCatalogue,
  type ActionRow,
  type AgentKind,
  type CatalogueAgent,
  type CatalogueSort,
  type Eligibility,
  type Guardrail,
} from './agents-catalogue';
import { agentsCatalogueCopy } from './agents-catalogue-copy';
import { MadeAgents } from './agent-room/own-agent';
import { NavigatorOnChain } from './NavigatorOnChain';
import { downloadCsv, toCsv } from './depth-csv';
import { usePreferences } from '../../shared/preferences';
import type { UiLocale } from '../../shared/i18n';
import { AGENTS_ROUTES_LIST } from '@intafaced/contracts/agents-routes-procedures';
import { AGENTS_AGENT_GET, AGENTS_AGENT_CATALOGUE } from '@intafaced/contracts/agents-agent-procedures';
import { type ProcedureOutput } from '@intafaced/contracts/procedure';

const KINDS: readonly (AgentKind | 'all')[] = ['all', 'session', 'room', 'staff', 'unwired'];
const SORTS: readonly CatalogueSort[] = ['catalogue', 'name'];

/** The fee asset an agent's spend cap is counted in: that of the completion routes its tasks run on, as the session panel reads it, when they agree. */
function capAsset(guardrail: Guardrail, routes: readonly ProcedureOutput<typeof AGENTS_ROUTES_LIST>[number][]): string | null {
  const assets = new Set(
    routes
      .filter((route) => route.capability === 'complete' && guardrail.limits.allowedTasks.includes(route.task))
      .map((route) => route.assetId),
  );
  return assets.size === 1 ? [...assets][0]! : null;
}

export function AgentsCatalogue({
  log,
  reload,
  onSession,
  onCoach,
}: {
  log: Resource<ActionRow[]>;
  reload: () => void;
  onSession: (agentId: string) => void;
  onCoach: () => void;
}) {
  const { Copy, t } = agentsCatalogueCopy.useCopy();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<AgentKind | 'all'>('all');
  const [sort, setSort] = useState<CatalogueSort>('catalogue');
  const [selected, setSelected] = useState<string | null>(null);
  const [comparing, setComparing] = useState<string[]>([]);
  const [compared, setCompared] = useState<string[] | null>(null);
  const api = useApi();
  const stored = useResource((signal) => api.call(AGENTS_AGENT_CATALOGUE, undefined, { signal }), 'agent-catalogue');
  // The catalogue is the stored list and nothing else: until it is read there are no cards, and with none stored the
  // empty state says so (catalogueFromStored).
  const rows = stored.resource.status === 'ready' ? stored.resource.data : [];
  const catalogue = catalogueFromStored(rows);
  const known = (id: string) => AGENT_CATALOGUE.some((agent) => agent.id === id);
  const row = (id: string) => rows.find((r) => r.agentId === id);
  const label = (id: string) => (known(id) ? t(`name_${id}` as 'name_navigator') : (row(id)?.name ?? id));
  const about = (id: string) => (known(id) ? t(`about_${id}` as 'about_navigator') : (row(id)?.purpose ?? null));
  const shown = sortCatalogue(filterCatalogue(catalogue, { query, kind }, label), sort, label);
  const chosen = catalogue.find((agent) => agent.id === selected) ?? null;
  const enabled = (agent: CatalogueAgent) => agentEnabled(agent, rows);
  return (
    <div className="lt-stack">
      <Section className="lt-region" title={t('catalogueTitle')}>
        <p className="lt-muted">
          <Copy k="catalogueIntro" />
        </p>
        <div className="lt-toolbar">
          <Field label={t('search')} value={query} maxLength={64} onChange={(event) => setQuery(event.target.value)} />
          <Select
            label={t('kindFilter')}
            value={kind}
            onChange={(value) => setKind(value as AgentKind | 'all')}
            options={KINDS.map((value) => ({ value, label: value === 'all' ? t('kindAll') : t(`kind_${value}`) }))}
          />
          <Select
            label={t('sort')}
            value={sort}
            onChange={(value) => setSort(value as CatalogueSort)}
            options={SORTS.map((value) => ({ value, label: t(`sort_${value}`) }))}
          />
        </div>
        {stored.resource.status === 'loading' ? <Waiting /> : null}
        {stored.resource.status === 'ready' && catalogue.length === 0 ? <EmptyNote title={t('catalogueEmpty')} /> : null}
        <div className="lt-grid">
          {shown.map((agent) => {
            const usable = enabled(agent);
            const parked = agent.kind === 'unwired' || agent.kind === 'staff';
            return (
              <article key={agent.id} className="lt-region" aria-current={selected === agent.id}>
                <h3>{label(agent.id)}</h3>
                <Tag tone={agent.kind === 'session' ? 'accent' : 'neutral'}>{t(`kind_${agent.kind}`)}</Tag>
                <Tag tone={usable ? 'accent' : 'neutral'}>
                  <span data-testid="agent-status">{usable ? t('enabled') : t('disabled')}</span>
                </Tag>
                {about(agent.id) ? <p>{about(agent.id)}</p> : null}
                <div className="lt-actions">
                  <Button tone="secondary" aria-pressed={selected === agent.id} onClick={() => setSelected(agent.id)}>
                    <Copy k="open" />
                  </Button>
                  {agent.kind === 'session' ? (
                    <Checkbox
                      label={<Copy k="compare" />}
                      checked={comparing.includes(agent.id)}
                      onChange={(event) => {
                        const { checked } = event.target;
                        setComparing((ids) => (checked ? [...ids, agent.id] : ids.filter((id) => id !== agent.id)));
                        if (!checked) setCompared((ids) => ids && ids.filter((id) => id !== agent.id));
                      }}
                    />
                  ) : null}
                  {agent.kind === 'session' ? (
                    <Button tone="primary" disabled={!usable} onClick={() => onSession(agent.id)}>
                      <Copy k="openSession" />
                    </Button>
                  ) : agent.tab === 'Coach' ? (
                    <Button tone="primary" onClick={onCoach}>
                      <Copy k="openCoach" />
                    </Button>
                  ) : agent.href ? (
                    <a className="lt-button lt-button-secondary" href={agent.href}>
                      <Copy k="openRoom" />
                    </a>
                  ) : parked ? (
                    // An agent no customer can open yet stays in the catalogue with its open button off, and the card
                    // names its blocker beside it.
                    <Button tone="primary" disabled aria-describedby={`agent-blocker-${agent.id}`}>
                      <Copy k="openSession" />
                    </Button>
                  ) : null}
                </div>
                {parked ? (
                  <p className="lt-muted" role="note" id={`agent-blocker-${agent.id}`}>
                    <Copy k={agent.kind === 'unwired' ? 'blocker_unwired' : 'blocker_staff'} />
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>
        {stored.resource.status === 'failed' ? (
          <Read resource={stored.resource} retry={stored.reload}>
            {() => null}
          </Read>
        ) : null}
        <Button tone="secondary" disabled={comparing.length < 2} onClick={() => setCompared([...comparing])}>
          {comparing.length < 2 ? t('compareNone') : t('compareCount', { count: String(comparing.length) })}
        </Button>
      </Section>
      {compared ? <CompareAgents ids={compared} label={label} /> : null}
      <Section className="lt-region" title={t('detailTitle')}>
        {chosen ? (
          <AgentDetail agent={chosen} name={label(chosen.id)} about={about(chosen.id)} onSession={onSession} />
        ) : (
          <p className="lt-muted">{t('pickAgent')}</p>
        )}
      </Section>
      <MadeAgents />
      <MyAgents log={log} reload={reload} />
    </div>
  );
}

function AgentDetail({
  agent,
  name,
  about,
  onSession,
}: {
  agent: CatalogueAgent;
  name: string;
  about: string | null;
  onSession: (agentId: string) => void;
}) {
  const api = useApi();
  const { Copy, t } = agentsCatalogueCopy.useCopy();
  const guardrail = useResource(
    (signal) =>
      agent.kind === 'session'
        ? api.call(AGENTS_AGENT_GET, { agentId: agent.id }, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `agent-detail:${agent.id}`,
  );
  return (
    <>
      <h3>{name}</h3>
      {about ? <p>{about}</p> : null}
      {agent.kind === 'unwired' || agent.kind === 'staff' ? (
        <p className="lt-muted" role="note">
          <Copy k={agent.kind === 'unwired' ? 'blocker_unwired' : 'blocker_staff'} />
        </p>
      ) : null}
      {agent.kind === 'session' ? (
        <Read resource={guardrail.resource} retry={guardrail.reload} empty={t('notRegistered')}>
          {(g) =>
            g ? (
              <>
                <Details
                  items={[
                    [t('state'), g.enabled ? t('enabled') : t('disabled')],
                    [t('version'), g.version],
                    [t('actions'), g.limits.maxActionsPerSession],
                    [t('tokens'), g.limits.maxOutputTokensPerCall],
                    [t('spendCap'), g.limits.maxSpendPerSession ? displayAmount(g.limits.maxSpendPerSession) : t('noCap')],
                    [t('tasks'), g.limits.allowedTasks.join(', ') || t('none')],
                    [t('modules'), g.limits.allowedModules.join(', ') || t('none')],
                  ]}
                />
                <Details items={[[t('permissionMode'), modeWords(g.capacityMode)]]} />
                <p>
                  <Copy k="actsAsYou" />
                </p>
                <ScrollTable
                  headers={[t('toolName'), t('toolAccess'), t('toolApproval'), t('toolInputs'), t('toolOutputs'), t('toolRefusals')]}
                  label={t('tools')}
                >
                  {g.tools.map((tool) => (
                    <tr key={tool.name}>
                      <td>{tool.name}</td>
                      <td>{tool.mode}</td>
                      <td>{tool.requiresApproval ? t('approvalRequired') : t('approvalNone')}</td>
                      <td>{tool.shape ? <ShapeFields fields={tool.shape.input} /> : t('shapeUnpublished')}</td>
                      <td>{tool.shape ? <ShapeFields fields={tool.shape.output} /> : t('shapeUnpublished')}</td>
                      <td>
                        <ul>
                          {tool.refusals.map((code) => (
                            <li key={code}>{refusalWords(code)}</li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </ScrollTable>
                <p className="lt-muted">
                  <Copy k="costOpenNotice" />
                </p>
                <Button tone="primary" disabled={!g.enabled} onClick={() => onSession(agent.id)}>
                  <Copy k="openSession" />
                </Button>
              </>
            ) : null
          }
        </Read>
      ) : null}
      {agent.id === 'navigator' ? <NavigatorOnChain /> : null}
    </>
  );
}

/** A tool's declared fields as the service stores them: each name with its type in words, in the stored order. */
function ShapeFields({ fields }: { fields: Readonly<Record<string, string>> }) {
  return (
    <ul>
      {Object.entries(fields).map(([field, type]) => (
        <li key={field}>
          {field}: {type}
        </li>
      ))}
    </ul>
  );
}

const MODES = ['research_only', 'read_only', 'draft_preview', 'confirm_each', 'bounded_autonomous'] as const;
function modeWords(mode: string | null): string {
  const { t } = agentsCatalogueCopy;
  if (mode === null) return t('mode_none');
  return (MODES as readonly string[]).includes(mode) ? t(`mode_${mode as (typeof MODES)[number]}`) : t('mode_other');
}
const REFUSALS = [
  'session_closed',
  'action_limit',
  'tool_not_declared',
  'module_not_allowed',
  'mode_unknown',
  'mode_forbids_write',
  'withdraw_scope_required',
  'tool_call_limit',
  'approval_required',
  'place_idempotency_required',
  'place_key_conflict',
  'task_not_allowed',
  'output_limit',
  'spend_limit',
  'price_unset',
  'funds_insufficient',
  'funds_unread',
  'copy_intel.returns_board_refused',
] as const;
/**
 * A guardrail refusal's copy key (`agents.refused.<name>`) as words in `locale`, for a refusal this screen knows; any
 * other message is left to the shared failure copy (null). The typed code itself is read back from the session's log.
 */
export function refusalKeyWords(message: string, locale: UiLocale): { message: string; language: UiLocale } | null {
  const name = message.startsWith('agents.refused.') ? message.slice('agents.refused.'.length) : null;
  if (name === null || !(REFUSALS as readonly string[]).includes(name)) return null;
  const copy = agentsCatalogueCopy.forLocale(locale);
  const key = `refusal_${name as (typeof REFUSALS)[number]}` as const;
  return { message: copy.t(key), language: copy.languageFor(key) };
}
/** A refusal code as words; a code this screen does not know is shown as the code itself. */
export function refusalWords(code: string): string {
  const name = code.replace(/^agents\./, '');
  return (REFUSALS as readonly string[]).includes(name) ? agentsCatalogueCopy.t(`refusal_${name as (typeof REFUSALS)[number]}`) : code;
}

/** Two or more metered agents side by side, each column from that agent's own published guardrail. */
function CompareAgents({ ids, label }: { ids: readonly string[]; label: (id: string) => string }) {
  const api = useApi();
  const { t } = agentsCatalogueCopy.useCopy();
  const both = useResource(
    async (signal) => {
      const [routes, ...guards] = await Promise.all([
        api.call(AGENTS_ROUTES_LIST, undefined, { signal }),
        ...ids.map((agentId) => api.call(AGENTS_AGENT_GET, { agentId }, { signal })),
      ]);
      if (!routes!.ok) return routes!;
      const rows: { id: string; guardrail: Guardrail | null }[] = [];
      for (const [index, guard] of guards.entries()) {
        if (!guard.ok) return guard;
        rows.push({ id: ids[index]!, guardrail: guard.data });
      }
      return { ok: true as const, data: { routes: routes!.data, rows } };
    },
    `agent-compare:${ids.join(',')}`,
  );
  const list = (values: readonly string[]) => (values.length ? values.join(', ') : t('none'));
  return (
    <Section className="lt-region" title={t('compareTitle')}>
      <Read resource={both.resource} retry={both.reload}>
        {({ routes, rows }) => (
          <ScrollTable headers={['', ...rows.map((row) => label(row.id))]} label={t('compareTitle')}>
            {(
              [
                [t('tools'), (g: Guardrail) => list(g.tools.map((tool) => tool.name))],
                [t('compareModes'), (g: Guardrail) => list([...new Set(g.tools.map((tool) => tool.mode))])],
                [
                  t('spendCap'),
                  (g: Guardrail) => {
                    const cap = g.limits.maxSpendPerSession;
                    if (!cap) return t('noCap');
                    const asset = capAsset(g, routes);
                    return asset
                      ? t('capPerSession', { amount: displayAmount(cap), asset })
                      : t('capNoAsset', { amount: displayAmount(cap) });
                  },
                ],
                [t('tasks'), (g: Guardrail) => list(g.limits.allowedTasks)],
                [t('eligibility'), (g: Guardrail) => eligibilityWords(g.eligibility)],
              ] as const
            ).map(([name, cell]) => (
              <tr key={name}>
                <td>{name}</td>
                {rows.map((row) => (
                  <td key={row.id}>{row.guardrail ? cell(row.guardrail) : t('notRegistered')}</td>
                ))}
              </tr>
            ))}
          </ScrollTable>
        )}
      </Read>
    </Section>
  );
}

/** Whether this person may use the agent, and when not, the rule that leaves them out, from its published law. */
function eligibilityWords(eligibility: Eligibility | undefined): string {
  const { t } = agentsCatalogueCopy;
  if (!eligibility) return t('eligibilityUnstated');
  const plan = (value: string) => (value === 'none' || value === '' ? t('planNone') : value);
  if (eligibility.rule === 'none') return t('eligibleNoRule');
  if (eligibility.eligible) return t('eligiblePlan', { plan: plan(eligibility.yourPlan) });
  if (!eligibility.published) return t('notEligibleUnpublished');
  if (eligibility.code === 'agents.depth_invalid') return t('notEligiblePlanLimits', { plan: plan(eligibility.yourPlan) });
  return t('notEligiblePlan', { plans: eligibility.plans.join(', '), plan: plan(eligibility.yourPlan) });
}

function MyAgents({ log, reload }: { log: Resource<ActionRow[]>; reload: () => void }) {
  const { Copy, t } = agentsCatalogueCopy.useCopy();
  const preferences = usePreferences();
  const [exported, setExported] = useState<'done' | 'fail' | 'none' | null>(null);
  const when = (at: string) =>
    new Intl.DateTimeFormat(preferences.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
  return (
    <Section className="lt-region" title={t('mineTitle')}>
      <p className="lt-muted">
        <Copy k="mineIntro" />
      </p>
      {log.status === 'loading' ? <Waiting /> : null}
      <Read resource={log} retry={reload} empty={t('mineEmpty')}>
        {(rows) => {
          const use = agentUse(rows);
          return (
            <>
              <ScrollTable
                headers={[t('colAgent'), t('colSessions'), t('colActions'), t('colOutcomes'), t('colSpend'), t('colLast')]}
                label={t('mineTitle')}
              >
                {use.map((row) => (
                  <tr key={row.agentId}>
                    <td lang="zxx">{row.agentId}</td>
                    <td>{row.sessions}</td>
                    <td>{row.actions}</td>
                    <td>
                      {row.executed} / {row.refused} / {row.failed}
                    </td>
                    <td>{preferences.hideBalances ? '••••' : displayAmount(row.spend)}</td>
                    <td>{when(row.lastUsed)}</td>
                  </tr>
                ))}
              </ScrollTable>
              <p className="lt-muted">
                <Copy k="spendNote" />
              </p>
              <Button
                tone="secondary"
                onClick={() => {
                  if (!rows.length) return setExported('none');
                  setExported(downloadCsv('agent-action-log.csv', toCsv(ACTION_LOG_HEADER, actionLogRows(rows))) ? 'done' : 'fail');
                }}
              >
                <Copy k="exportLog" />
              </Button>
              {exported ? (
                <p role="status">
                  <Copy k={exported === 'done' ? 'exportDone' : exported === 'fail' ? 'exportFail' : 'exportNone'} />
                </p>
              ) : null}
            </>
          );
        }}
      </Read>
    </Section>
  );
}
