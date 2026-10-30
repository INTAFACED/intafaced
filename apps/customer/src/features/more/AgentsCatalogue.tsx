import { useState } from 'react';
import { useApi } from '../session/session';
import { useResource, type Resource } from '../../shared/resource';
import { displayAmount } from '../../shared/money';
import { Button, DataTable, EmptyState, Field, Loading, Panel } from '../../shared/ui';
import { Details, Read, Select } from './common';
import { StatusPill } from './depth-kit';
import { z } from 'zod';
import {
  actionLogRows,
  ACTION_LOG_HEADER,
  agentEnabled,
  agentUse,
  AGENT_CATALOGUE,
  filterCatalogue,
  guardrailSchema,
  sortCatalogue,
  storedCatalogueSchema,
  type ActionRow,
  type AgentKind,
  type CatalogueAgent,
  type CatalogueSort,
  type Guardrail,
} from './agents-catalogue';
import { agentsCatalogueCopy } from './agents-catalogue-copy';
import { MadeAgents } from './AgentBuilder';
import { downloadCsv, toCsv } from './depth-csv';
import { usePreferences } from '../../shared/preferences';

const KINDS: readonly (AgentKind | 'all')[] = ['all', 'session', 'room', 'staff', 'unwired'];
const SORTS: readonly CatalogueSort[] = ['catalogue', 'name'];
const routeAssetSchema = z.array(z.object({ task: z.string(), capability: z.string(), assetId: z.string().min(1) }));

/** The fee asset an agent's spend cap is counted in: that of the completion routes its tasks run on, as the session panel reads it, when they agree. */
function capAsset(guardrail: Guardrail, routes: readonly z.infer<typeof routeAssetSchema>[number][]): string | null {
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
  const stored = useResource(
    (signal) => api.query('agents', 'agent.catalogue', undefined, storedCatalogueSchema, { signal }),
    'agent-catalogue',
  );
  const label = (id: string) => t(`name_${id}` as 'name_navigator');
  const shown = sortCatalogue(filterCatalogue(AGENT_CATALOGUE, { query, kind }, label), sort, label);
  const chosen = AGENT_CATALOGUE.find((agent) => agent.id === selected) ?? null;
  const enabled = (agent: CatalogueAgent) =>
    agent.kind !== 'session'
      ? agentEnabled(agent, [])
      : stored.resource.status === 'ready'
        ? agentEnabled(agent, stored.resource.data)
        : null;
  return (
    <div className="more-grid">
      <Panel title={t('catalogueTitle')}>
        <p className="muted">
          <Copy k="catalogueIntro" />
        </p>
        <div className="depth-filters">
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
        <div className="depth-cards">
          {shown.map((agent) => {
            const usable = enabled(agent);
            return (
              <article key={agent.id} className="depth-card" aria-current={selected === agent.id}>
                <h3>{label(agent.id)}</h3>
                <StatusPill state={agent.kind === 'session' ? 'ready' : agent.kind === 'room' ? 'info' : 'blocked'}>
                  {t(`kind_${agent.kind}`)}
                </StatusPill>
                <StatusPill state={usable ? 'ready' : 'blocked'}>
                  <span data-testid="agent-status">
                    {usable === null
                      ? stored.resource.status === 'loading'
                        ? t('statusChecking')
                        : t('statusUnknown')
                      : usable
                        ? t('enabled')
                        : t('disabled')}
                  </span>
                </StatusPill>
                <p>{t(`about_${agent.id}` as 'about_navigator')}</p>
                <div className="depth-card-actions">
                  <Button variant="secondary" aria-pressed={selected === agent.id} onClick={() => setSelected(agent.id)}>
                    <Copy k="open" />
                  </Button>
                  {agent.kind === 'session' ? (
                    <label className="field field--check">
                      <input
                        type="checkbox"
                        checked={comparing.includes(agent.id)}
                        onChange={(event) => {
                          const { checked } = event.target;
                          setComparing((ids) => (checked ? [...ids, agent.id] : ids.filter((id) => id !== agent.id)));
                          if (!checked) setCompared((ids) => ids && ids.filter((id) => id !== agent.id));
                        }}
                      />
                      <Copy k="compare" />
                    </label>
                  ) : null}
                  {agent.kind === 'session' ? (
                    <Button disabled={usable === false} onClick={() => onSession(agent.id)}>
                      <Copy k="openSession" />
                    </Button>
                  ) : agent.tab === 'Coach' ? (
                    <Button onClick={onCoach}>
                      <Copy k="openCoach" />
                    </Button>
                  ) : agent.href ? (
                    <a className="button button--secondary" href={agent.href}>
                      <Copy k="openRoom" />
                    </a>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
        {stored.resource.status === 'failed' ? (
          <Read resource={stored.resource} retry={stored.reload}>
            {() => null}
          </Read>
        ) : null}
        <Button variant="secondary" disabled={comparing.length < 2} onClick={() => setCompared([...comparing])}>
          {comparing.length < 2 ? t('compareNone') : t('compareCount', { count: String(comparing.length) })}
        </Button>
      </Panel>
      {compared ? <CompareAgents ids={compared} label={label} /> : null}
      <Panel title={t('detailTitle')}>
        {chosen ? <AgentDetail agent={chosen} onSession={onSession} /> : <p className="muted">{t('pickAgent')}</p>}
      </Panel>
      <MadeAgents />
      <MyAgents log={log} reload={reload} />
    </div>
  );
}

function AgentDetail({ agent, onSession }: { agent: CatalogueAgent; onSession: (agentId: string) => void }) {
  const api = useApi();
  const { Copy, t } = agentsCatalogueCopy.useCopy();
  const guardrail = useResource(
    (signal) =>
      agent.kind === 'session'
        ? api.query('agents', 'agent.get', { agentId: agent.id }, guardrailSchema, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `agent-detail:${agent.id}`,
  );
  return (
    <>
      <h3>{t(`name_${agent.id}` as 'name_navigator')}</h3>
      <p>{t(`about_${agent.id}` as 'about_navigator')}</p>
      {agent.kind === 'unwired' || agent.kind === 'staff' ? (
        <p className="muted" role="note">
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
                <DataTable
                  headers={[t('toolName'), t('toolAccess'), t('toolApproval'), t('toolInputs'), t('toolOutputs'), t('toolRefusals')]}
                  label={t('tools')}
                >
                  {g.tools.map((tool) => (
                    <tr key={tool.name}>
                      <td>{tool.name}</td>
                      <td>{tool.mode}</td>
                      <td>{tool.requiresApproval ? t('approvalRequired') : t('approvalNone')}</td>
                      <td>{t('shapeUnpublished')}</td>
                      <td>{t('shapeUnpublished')}</td>
                      <td>
                        <ul>
                          {tool.refusals.map((code) => (
                            <li key={code}>{refusalWords(code)}</li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </DataTable>
                <p className="muted">
                  <Copy k="costOpenNotice" />
                </p>
                <Button disabled={!g.enabled} onClick={() => onSession(agent.id)}>
                  <Copy k="openSession" />
                </Button>
              </>
            ) : null
          }
        </Read>
      ) : null}
    </>
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
] as const;
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
        api.query('agents', 'routes.list', undefined, routeAssetSchema, { signal }),
        ...ids.map((agentId) => api.query('agents', 'agent.get', { agentId }, guardrailSchema, { signal })),
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
    <Panel title={t('compareTitle')}>
      <Read resource={both.resource} retry={both.reload}>
        {({ routes, rows }) => (
          <DataTable headers={['', ...rows.map((row) => label(row.id))]} label={t('compareTitle')}>
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
              ] as const
            ).map(([name, cell]) => (
              <tr key={name}>
                <td>{name}</td>
                {rows.map((row) => (
                  <td key={row.id}>{row.guardrail ? cell(row.guardrail) : t('notRegistered')}</td>
                ))}
              </tr>
            ))}
          </DataTable>
        )}
      </Read>
    </Panel>
  );
}

function MyAgents({ log, reload }: { log: Resource<ActionRow[]>; reload: () => void }) {
  const { Copy, t } = agentsCatalogueCopy.useCopy();
  const preferences = usePreferences();
  const [exported, setExported] = useState<'done' | 'fail' | 'none' | null>(null);
  const when = (at: string) =>
    new Intl.DateTimeFormat(preferences.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
  return (
    <Panel title={t('mineTitle')}>
      <p className="muted">
        <Copy k="mineIntro" />
      </p>
      {log.status === 'loading' ? <Loading /> : null}
      <Read resource={log} retry={reload} empty={t('mineEmpty')}>
        {(rows) => {
          const use = agentUse(rows);
          return (
            <>
              <DataTable
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
              </DataTable>
              <p className="muted">
                <Copy k="spendNote" />
              </p>
              <Button
                variant="secondary"
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
    </Panel>
  );
}
