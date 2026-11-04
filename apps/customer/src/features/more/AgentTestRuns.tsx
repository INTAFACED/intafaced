import { useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, DataTable, Failure, Field, Panel, Stat } from '../../shared/ui';
import { TabList } from '../protocol/tokens/TabList';
import { Read, Select } from './common';
import { toolWords } from './AgentGuardrails';
import { agentGuardrailsCopy } from './agent-guardrails-copy';
import { agentTestRunsCopy } from './agent-test-runs-copy';
import {
  ownAgentAnalyticsSchema,
  ownAgentCatalogueSchema,
  ownAgentTestRunSchema,
  type OwnAgent,
  type OwnAgentDryRunCheck,
  type OwnAgentDryRunEffect,
  type OwnAgentTestRun,
} from '@intafaced/contracts/agents-own';

/**
 * An own agent's dry run (on its Test page), its live and test run lists (Runs) and its Analytics page (AG-spend-04,
 * AG-testing-01). A dry run is svc-agents' answer: every check a real call of the tool meets, which passed and which
 * did not with the code a real call would get, and what the call would do. It opens no session and makes no ledger
 * entry, intent or reservation; it is a test run, labelled TEST and never billed. Test runs are listed apart from live
 * runs, and live analytics leave them out unless the person includes them.
 */

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
type Words = ReturnType<typeof agentTestRunsCopy.useCopy>['t'];
const REFUSAL_REASONS: ReadonlySet<Failed['reason']> = new Set(['error', 'forbidden', 'not_mounted']);
const refusalCode = (failed: Failed): string | null =>
  REFUSAL_REASONS.has(failed.reason) && /^agents\.[a-z_.]+$/.test(failed.message) ? failed.message : null;
const WORDED = ['agents.request_id_replay', 'agents.own.not_found'] as const;

function Answer({ failed }: { failed: Failed }) {
  const { t } = agentTestRunsCopy.useCopy();
  const code = refusalCode(failed);
  if (!code) return <Failure result={failed} />;
  const words = (WORDED as readonly string[]).includes(code)
    ? t(`code_${code.replaceAll('.', '_')}` as `code_${'agents_request_id_replay' | 'agents_own_not_found'}`)
    : t('code_other');
  return (
    <p role="alert">
      {words} <code lang="zxx">{code}</code>
    </p>
  );
}

const inputWords = (t: Words, input: Readonly<Record<string, string>>) => {
  // By field name: the service stores the input as JSON, which keeps no order of its own.
  const entries = Object.entries(input).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length ? entries.map(([field, value]) => `${field}: ${value}`).join('; ') : t('noInput');
};

/** What the call would do, in words; a refusal names the first check that failed, with its code beside it. */
function Effect({ effect, checks }: { effect: OwnAgentDryRunEffect; checks: readonly OwnAgentDryRunCheck[] }) {
  const { t } = agentTestRunsCopy.useCopy();
  const tools = agentGuardrailsCopy.useCopy().t;
  if (effect.kind === 'refused') {
    const failed = checks.find((check) => !check.passed);
    return (
      <>
        {t('effect_refused', { check: failed ? t(`check_${failed.check}`) : effect.tool })} <code lang="zxx">{effect.code}</code>
      </>
    );
  }
  const params = { tool: toolWords(tools, effect.tool), input: inputWords(t, effect.input), module: effect.module };
  if (effect.kind === 'ask') return <>{t('effect_ask', params)}</>;
  const reads = effect.dataClass === 'own_data' || effect.dataClass === 'market_data';
  return <>{t(reads ? 'effect_run_read' : 'effect_run_write', params)}</>;
}

/** The Test page's Test panel: a dry run of one call of one of the agent's tools. */
export function TestPanel({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentTestRunsCopy.useCopy();
  const tools = agentGuardrailsCopy.useCopy().t;
  const catalogue = useResource(
    (signal) => api.query('agents', 'own.catalogue', undefined, ownAgentCatalogueSchema, { signal }),
    'own-catalogue',
  );
  const [picked, setTool] = useState(agent.tools[0] ?? '');
  // A tool the agent no longer carries is never sent: the first it carries now stands in for it.
  const tool = agent.tools.includes(picked) ? picked : (agent.tools[0] ?? '');
  const [args, setArgs] = useState<Record<string, string>>({});
  const [dry, setDry] = useState<OwnAgentTestRun | null>(null);
  const [refused, setRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  // Each press is its own dry run: a business key from this visit and a count. One whose answer was lost keeps its key,
  // so pressing again is the same request and never a second dry run; any edit makes the next press a new one.
  const keys = useRef({ visit: Date.now().toString(36), presses: 0, pending: null as string | null });
  const edited = () => {
    keys.current.pending = null;
  };

  async function dryRun() {
    setBusy(true);
    setDry(null);
    setRefused(null);
    if (!keys.current.pending) {
      keys.current.presses += 1;
      keys.current.pending = `own-dry:${agent.id}:${keys.current.visit}:${keys.current.presses}`;
    }
    const input = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== ''));
    const res = await api.mutate(
      'agents',
      'own.dryRun',
      { id: agent.id, requestId: keys.current.pending, tool, input },
      ownAgentTestRunSchema,
    );
    setBusy(false);
    if (res.ok || refusalCode(res)) keys.current.pending = null;
    if (!res.ok) return setRefused(res);
    setDry(res.data);
  }

  const passed = dry?.checks.filter((check) => check.passed) ?? [];
  const failed = dry?.checks.filter((check) => !check.passed) ?? [];
  return (
    <Panel title={t('testTitle')} role="region" aria-label={t('testTitle')}>
      <p className="muted">{t('testIntro')}</p>
      <h3>{t('dryTitle')}</h3>
      <p className="muted">{t('dryIntro')}</p>
      <Read resource={catalogue.resource} retry={catalogue.reload}>
        {(offered) => {
          const declared = offered.tools.find((entry) => entry.name === tool);
          return agent.tools.length ? (
            <>
              <Select
                label={t('tool')}
                value={tool}
                onChange={(value) => {
                  edited();
                  setTool(value);
                  setArgs({});
                }}
                options={agent.tools.map((name) => ({ value: name, label: toolWords(tools, name) }))}
              />
              {Object.keys(declared?.shape?.input ?? {}).map((field) => (
                <Field
                  key={`${tool}:${field}`}
                  label={field}
                  hint={declared?.shape?.input[field]}
                  value={args[field] ?? ''}
                  maxLength={4000}
                  onChange={(event) => {
                    edited();
                    setArgs((current) => ({ ...current, [field]: event.target.value }));
                  }}
                />
              ))}
              <Button disabled={busy || !tool} onClick={() => void dryRun()}>
                {t('dryRun')}
              </Button>
            </>
          ) : (
            <p className="muted">{t('noTools')}</p>
          );
        }}
      </Read>
      {refused ? <Answer failed={refused} /> : null}
      {dry ? (
        <section role="region" aria-label={t('dryResult')}>
          <h3>
            {t('dryResult')} · {dry.label}
          </h3>
          <h4>{t('checksPassed')}</h4>
          <ul aria-label={t('checksPassed')}>
            {passed.map((check) => (
              <li key={check.check} data-check={check.check}>
                {t(`check_${check.check}`)}
              </li>
            ))}
          </ul>
          {failed.length ? (
            <>
              <h4>{t('checksFailed')}</h4>
              <ul aria-label={t('checksFailed')}>
                {failed.map((check) => (
                  <li key={check.check} data-check={check.check}>
                    {t(`check_${check.check}`)} <code lang="zxx">{check.code}</code>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <dl>
            <dt>{t('effectTerm')}</dt>
            <dd data-testid="dry-effect">
              <Effect effect={dry.effect} checks={dry.checks} />
            </dd>
            <dt>{t('costTerm')}</dt>
            <dd data-testid="dry-cost">
              {dry.cost} {dry.assetId}
            </dd>
          </dl>
          <p>{t('nothingMade')}</p>
        </section>
      ) : null}
    </Panel>
  );
}

const LISTS = ['live', 'test'] as const;

/** The Runs page: live runs and test runs, each its own tab, never mixed. `live` is the live runs list. */
export function RunsPage({ agent, live }: { agent: OwnAgent; live: ReactNode }) {
  const { t } = agentTestRunsCopy.useCopy();
  const [list, setList] = useState<(typeof LISTS)[number]>('live');
  return (
    <TabList
      label={t('runsTabs')}
      tabs={[
        { id: 'live', label: t('liveTab') },
        { id: 'test', label: t('testTab') },
      ]}
      value={list}
      onChange={setList}
    >
      {list === 'live' ? live : <TestRuns agent={agent} />}
    </TabList>
  );
}

function TestRuns({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentTestRunsCopy.useCopy();
  const tools = agentGuardrailsCopy.useCopy().t;
  const runs = useResource(
    (signal) => api.query('agents', 'own.testRuns', { id: agent.id, limit: 50 }, z.array(ownAgentTestRunSchema), { signal }),
    `own-test-runs:${agent.id}`,
  );
  return (
    <Panel title={t('testRunsTitle')}>
      <Read resource={runs.resource} retry={runs.reload}>
        {(rows) => (
          <>
            <DataTable
              label={t('testRunsTitle')}
              headers={[t('colWhen'), t('colKind'), t('colTool'), t('colEffect'), t('colCost'), t('colLabel')]}
            >
              {rows.map((row) => (
                <tr key={row.id} data-run-id={row.id}>
                  <td>{new Date(row.createdAt).toLocaleString()}</td>
                  <td>{t(`kind_${row.kind}`)}</td>
                  <td>{toolWords(tools, row.tool)}</td>
                  <td>{t(`outcome_${row.effect.kind}`)}</td>
                  <td data-testid="test-run-cost">
                    {row.cost} {row.assetId}
                  </td>
                  <td data-testid="test-run-label">{row.label}</td>
                </tr>
              ))}
            </DataTable>
            {rows.length === 0 ? <p className="muted">{t('testRunsEmpty')}</p> : null}
          </>
        )}
      </Read>
    </Panel>
  );
}

/** The Analytics page: runs by outcome and their cost, live runs only unless the person includes test runs. */
export function AnalyticsPage({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentTestRunsCopy.useCopy();
  const [includeTest, setIncludeTest] = useState(false);
  const figures = useResource(
    (signal) => api.query('agents', 'own.analytics', { id: agent.id, includeTest }, ownAgentAnalyticsSchema, { signal }),
    `own-analytics:${agent.id}:${includeTest}`,
  );
  return (
    <Panel title={t('analyticsTitle')} role="region" aria-label={t('analyticsTitle')}>
      <p className="muted">{t('analyticsIntro')}</p>
      <Field label={t('includeTest')} type="checkbox" checked={includeTest} onChange={(event) => setIncludeTest(event.target.checked)} />
      <Read resource={figures.resource} retry={figures.reload}>
        {(view) => (
          <div className="more-grid" data-include-test={String(view.includeTest)}>
            <Stat label={t('statRuns')} value={<span data-testid="analytics-runs">{view.runs}</span>} />
            <Stat label={t('statExecuted')} value={<span data-testid="analytics-executed">{view.executed}</span>} />
            <Stat label={t('statRefused')} value={<span data-testid="analytics-refused">{view.refused}</span>} />
            <Stat label={t('statFailed')} value={<span data-testid="analytics-failed">{view.failed}</span>} />
            <Stat
              label={t('statTestRuns')}
              value={<span data-testid="analytics-test-runs">{view.testRuns === null ? '—' : view.testRuns}</span>}
              note={view.testRuns === null ? t('testLeftOut') : undefined}
            />
            <Stat
              label={t('statCost')}
              value={
                <span data-testid="analytics-cost">
                  {view.cost} {view.assetId}
                </span>
              }
            />
          </div>
        )}
      </Read>
      <p role="note">{t('analyticsParked')}</p>
    </Panel>
  );
}
