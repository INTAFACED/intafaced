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
import { agentTestRunsCopy, hasTestRunsWords } from './agent-test-runs-copy';
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

function Answer({ failed }: { failed: Failed }) {
  const { t } = agentTestRunsCopy.useCopy();
  const code = refusalCode(failed);
  if (!code) return <Failure result={failed} />;
  const key = `code_${code.replaceAll('.', '_')}`;
  const words = hasTestRunsWords(key) ? t(key) : t('code_other');
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

const slug = (tool: string) => tool.replaceAll('.', '_');
/**
 * A tool that moves value in the Test panel's words: its name (`money`) or what it would do (`would`), or the tool's own
 * name when the panel has no words for it.
 */
const moneyToolWords = (t: Words, kind: 'money' | 'would', tool: string) => {
  const key = `${kind}_${slug(tool)}`;
  return hasTestRunsWords(key) ? t(key) : tool;
};
/** A question as the run list shows it: at most one line of it. */
const ASK_SHOWN = 80;
const shortAsk = (ask: string) => (ask.length > ASK_SHOWN ? `${ask.slice(0, ASK_SHOWN - 1)}…` : ask);

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
  if (effect.kind === 'would_move')
    return <>{t('effect_would_move', { would: moneyToolWords(t, 'would', effect.tool), module: effect.module })}</>;
  const params = { tool: toolWords(tools, effect.tool), input: inputWords(t, effect.input), module: effect.module };
  if (effect.kind === 'ask') return <>{t('effect_ask', params)}</>;
  const reads = effect.dataClass === 'own_data' || effect.dataClass === 'market_data';
  return <>{t(reads ? 'effect_run_read' : 'effect_run_write', params)}</>;
}

/**
 * Each press is its own request: a business key from this visit and a count. One whose answer was lost keeps its key while
 * the request is the same (`what`), so pressing again is the same request and never a second run; any other request
 * (an edit, another tool) gets a new key.
 */
function usePressKeys(prefix: string, agentId: string) {
  const keys = useRef({ visit: Date.now().toString(36), presses: 0, pending: null as { key: string; what: string } | null });
  return {
    next: (what: string) => {
      if (keys.current.pending?.what !== what) {
        keys.current.presses += 1;
        keys.current.pending = { key: `${prefix}:${agentId}:${keys.current.visit}:${keys.current.presses}`, what };
      }
      return keys.current.pending.key;
    },
    /** The answer came (or was a refusal by name): the next press is a new request. */
    settled: () => {
      keys.current.pending = null;
    },
  };
}
type Catalogue = ReturnType<typeof useCatalogue>;
function useCatalogue() {
  const api = useApi();
  return useResource((signal) => api.query('agents', 'own.catalogue', undefined, ownAgentCatalogueSchema, { signal }), 'own-catalogue');
}

/**
 * The Test page's Test panel (AG-testing-01, AG-spend-04): a run of the agent on the test engine, a test of a tool that
 * would move value, and a dry run of one call of one of the agent's tools. Every one is a test run: mode test, never
 * billed, labelled TEST, with no session, reservation, usage row or ledger call.
 */
export function TestPanel({ agent }: { agent: OwnAgent }) {
  const { t } = agentTestRunsCopy.useCopy();
  const catalogue = useCatalogue();
  return (
    <Panel title={t('testTitle')} role="region" aria-label={t('testTitle')}>
      <p className="muted">{t('testIntro')}</p>
      <EngineRun agent={agent} />
      <MoveTest agent={agent} catalogue={catalogue} />
      <DryRun agent={agent} catalogue={catalogue} />
    </Panel>
  );
}

/** One question on the test engine: the reply and its log, every row labelled TEST, mode test and billing 0. */
function EngineRun({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentTestRunsCopy.useCopy();
  const [ask, setAsk] = useState('');
  const [ran, setRan] = useState<Extract<OwnAgentTestRun, { kind: 'engine_run' }> | null>(null);
  const [refused, setRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = usePressKeys('own-test', agent.id);

  async function runTest() {
    setBusy(true);
    setRan(null);
    setRefused(null);
    const res = await api.mutate('agents', 'own.testRun', { id: agent.id, requestId: keys.next(ask), ask }, ownAgentTestRunSchema);
    setBusy(false);
    if (res.ok || refusalCode(res)) keys.settled();
    if (!res.ok) return setRefused(res);
    if (res.data.kind === 'engine_run') setRan(res.data);
  }

  return (
    <>
      <h3>{t('runTitle')}</h3>
      <p className="muted">{t('runIntro')}</p>
      <Field label={t('ask')} value={ask} maxLength={4000} onChange={(event) => setAsk(event.target.value)} />
      <Button disabled={busy} onClick={() => void runTest()}>
        {t('runTest')}
      </Button>
      {refused ? <Answer failed={refused} /> : null}
      {ran ? (
        <section role="region" aria-label={t('engineRun')}>
          <h4>
            {t('engineRun')} · {ran.label}
          </h4>
          <dl>
            <dt>{t('modeTerm')}</dt>
            <dd data-testid="run-mode">{t(`mode_${ran.mode}`)}</dd>
            <dt>{t('engineTerm')}</dt>
            <dd data-testid="run-engine">{t(`engine_${ran.engine}`)}</dd>
            <dt>{t('liveEngineTerm')}</dt>
            <dd data-testid="live-engine">{t(`liveEngine_${ran.liveEngine}`)}</dd>
            <dt>{t('billingTerm')}</dt>
            <dd data-testid="run-cost">
              {ran.cost} {ran.assetId}
            </dd>
          </dl>
          <section role="region" aria-label={t('replyTitle')}>
            <h4>{t('replyTitle')}</h4>
            <p>
              <span data-testid="reply-label">{ran.label}</span> <span data-testid="reply-text">{ran.reply}</span>
            </p>
          </section>
          <DataTable label={t('logTitle')} headers={[t('colStep'), t('colWhat'), t('colLabel')]}>
            {ran.log.map((row) => (
              <tr key={row.step} data-step={row.step}>
                <td>{t(`step_${row.step}`)}</td>
                <td data-testid="log-text">{row.text}</td>
                <td data-testid="log-label">{row.label}</td>
              </tr>
            ))}
          </DataTable>
        </section>
      ) : null}
    </>
  );
}

/** A tool that moves value, tested: what it would do, and that nothing was sent to the ledger. */
function MoveTest({ agent, catalogue }: { agent: OwnAgent; catalogue: Catalogue }) {
  const api = useApi();
  const { t } = agentTestRunsCopy.useCopy();
  const [picked, setPicked] = useState('');
  const [tested, setTested] = useState<Extract<OwnAgentTestRun, { kind: 'tool_test' }> | null>(null);
  const [refused, setRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = usePressKeys('own-tool-test', agent.id);

  async function testTool(tool: string) {
    setBusy(true);
    setTested(null);
    setRefused(null);
    const res = await api.mutate('agents', 'own.toolTest', { id: agent.id, requestId: keys.next(tool), tool }, ownAgentTestRunSchema);
    setBusy(false);
    if (res.ok || refusalCode(res)) keys.settled();
    if (!res.ok) return setRefused(res);
    if (res.data.kind === 'tool_test') setTested(res.data);
  }

  return (
    <>
      <h3>{t('moveTitle')}</h3>
      <p className="muted">{t('moveIntro')}</p>
      <Read resource={catalogue.resource} retry={catalogue.reload}>
        {(offered) => {
          const money = offered.tools.filter((entry) => entry.movesMoney).map((entry) => entry.name);
          const tool = money.includes(picked) ? picked : (money[0] ?? '');
          return (
            <>
              <Select
                label={t('moveTool')}
                value={tool}
                onChange={setPicked}
                options={money.map((name) => ({ value: name, label: moneyToolWords(t, 'money', name) }))}
              />
              <Button disabled={busy || !tool} onClick={() => void testTool(tool)}>
                {t('moveTest')}
              </Button>
            </>
          );
        }}
      </Read>
      {refused ? <Answer failed={refused} /> : null}
      {tested ? (
        <section role="region" aria-label={t('wouldDo')}>
          <h4>
            {t('wouldDo')} · {tested.label}
          </h4>
          <p data-testid="would-effect">
            <Effect effect={tested.effect} checks={tested.checks} />
          </p>
          <p data-testid="would-refused">
            {t('moveRefused')}{' '}
            {tested.checks
              .filter((check) => !check.passed)
              .map((check) => (
                <code key={check.check} lang="zxx">
                  {check.code}
                </code>
              ))}
          </p>
          <dl>
            <dt>{t('costTerm')}</dt>
            <dd data-testid="would-cost">
              {tested.cost} {tested.assetId}
            </dd>
          </dl>
          <p>{t('nothingSent')}</p>
        </section>
      ) : null}
    </>
  );
}

/** A dry run of one call of one of the agent's tools. */
function DryRun({ agent, catalogue }: { agent: OwnAgent; catalogue: Catalogue }) {
  const api = useApi();
  const { t } = agentTestRunsCopy.useCopy();
  const tools = agentGuardrailsCopy.useCopy().t;
  const [picked, setTool] = useState(agent.tools[0] ?? '');
  // A tool the agent no longer carries is never sent: the first it carries now stands in for it.
  const tool = agent.tools.includes(picked) ? picked : (agent.tools[0] ?? '');
  const [args, setArgs] = useState<Record<string, string>>({});
  const [dry, setDry] = useState<Extract<OwnAgentTestRun, { kind: 'dry_run' }> | null>(null);
  const [refused, setRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = usePressKeys('own-dry', agent.id);

  async function dryRun() {
    setBusy(true);
    setDry(null);
    setRefused(null);
    const input = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== ''));
    const requestId = keys.next(JSON.stringify([tool, Object.entries(input).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]));
    const res = await api.mutate('agents', 'own.dryRun', { id: agent.id, requestId, tool, input }, ownAgentTestRunSchema);
    setBusy(false);
    if (res.ok || refusalCode(res)) keys.settled();
    if (!res.ok) return setRefused(res);
    if (res.data.kind === 'dry_run') setDry(res.data);
  }

  const passed = dry?.checks.filter((check) => check.passed) ?? [];
  const failed = dry?.checks.filter((check) => !check.passed) ?? [];
  return (
    <>
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
    </>
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
      {list === 'live' ? (
        <div role="region" aria-label={t('liveTab')}>
          {live}
        </div>
      ) : (
        <TestRuns agent={agent} />
      )}
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
              headers={[t('colWhen'), t('colKind'), t('colTested'), t('colEffect'), t('colCost'), t('colLabel')]}
            >
              {rows.map((row) => (
                <tr key={row.id} data-run-id={row.id}>
                  <td>{new Date(row.createdAt).toLocaleString()}</td>
                  <td>{t(`kind_${row.kind}`)}</td>
                  <td>
                    {row.kind === 'engine_run'
                      ? shortAsk(row.ask)
                      : row.kind === 'tool_test'
                        ? moneyToolWords(t, 'money', row.tool)
                        : toolWords(tools, row.tool)}
                  </td>
                  <td>{t(row.kind === 'engine_run' ? 'outcome_answered' : `outcome_${row.effect.kind}`)}</td>
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
