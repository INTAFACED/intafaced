import { useState } from 'react';
import { useApi } from '../session/session';
import { useResource, type Resource } from '../../shared/resource';
import { displayAmount } from '../../shared/money';
import { Button, DataTable, EmptyState, Field, Loading, Panel } from '../../shared/ui';
import { Details, Read, Select } from './common';
import { StatusPill } from './depth-kit';
import {
  actionLogRows,
  ACTION_LOG_HEADER,
  agentUse,
  AGENT_CATALOGUE,
  filterCatalogue,
  guardrailSchema,
  type ActionRow,
  type AgentKind,
  type CatalogueAgent,
} from './agents-catalogue';
import { agentsCatalogueCopy } from './agents-catalogue-copy';
import { downloadCsv, toCsv } from './depth-csv';
import { usePreferences } from '../../shared/preferences';

const KINDS: readonly (AgentKind | 'all')[] = ['all', 'session', 'room', 'staff', 'unwired'];

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
  const [selected, setSelected] = useState<string | null>(null);
  const label = (id: string) => t(`name_${id}` as 'name_navigator');
  const shown = filterCatalogue(AGENT_CATALOGUE, { query, kind }, label);
  const chosen = AGENT_CATALOGUE.find((agent) => agent.id === selected) ?? null;
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
        </div>
        <div className="depth-cards">
          {shown.map((agent) => (
            <article key={agent.id} className="depth-card" aria-current={selected === agent.id}>
              <h3>{label(agent.id)}</h3>
              <StatusPill state={agent.kind === 'session' ? 'ready' : agent.kind === 'room' ? 'info' : 'blocked'}>
                {t(`kind_${agent.kind}`)}
              </StatusPill>
              <p>{t(`about_${agent.id}` as 'about_navigator')}</p>
              <div className="depth-card-actions">
                <Button variant="secondary" aria-pressed={selected === agent.id} onClick={() => setSelected(agent.id)}>
                  <Copy k="open" />
                </Button>
                {agent.kind === 'session' ? (
                  <Button onClick={() => onSession(agent.id)}>
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
          ))}
        </div>
      </Panel>
      <Panel title={t('detailTitle')}>
        {chosen ? <AgentDetail agent={chosen} onSession={onSession} /> : <p className="muted">{t('pickAgent')}</p>}
      </Panel>
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
                <DataTable headers={[t('toolName'), t('toolAccess'), t('toolApproval')]} label={t('tools')}>
                  {g.tools.map((tool) => (
                    <tr key={tool.name}>
                      <td>{tool.name}</td>
                      <td>{tool.mode}</td>
                      <td>{tool.requiresApproval ? t('approvalRequired') : t('approvalNone')}</td>
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
