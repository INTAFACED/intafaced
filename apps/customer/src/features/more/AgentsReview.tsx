import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { decimalSchema, displayAmount } from '../../shared/money';
import { usePreferences } from '../../shared/preferences';
import { Button, DataTable, Field, Panel } from '../../shared/ui';
import { Read } from './common';
import { refusalWords } from './AgentsCatalogue';
import { ACTION_LOG_HEADER, actionLogRows } from './agents-catalogue';
import { downloadCsv, toCsv } from './depth-csv';
import { agentsReviewCopy } from './agents-review-copy';

/**
 * What my agents did (J-agents-13): the dashboard over a range of days, the activity log with its outcome filter and a
 * whole-log export, usage by agent, user and task, and one run's trace. Every figure is read from the service's stored
 * rows for the signed person; spend is the sum of sealed usage windows as stored. Nothing here writes or moves money.
 */

const amountLine = z.object({ assetId: z.string().min(1), amount: decimalSchema });
const dayFigures = z.object({
  day: z.string(),
  sessions: z.number().int().nonnegative(),
  actions: z.number().int().nonnegative(),
  executed: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  testRuns: z.number().int().nonnegative().nullable(),
  spend: z.array(amountLine),
});
const summarySchema = z.object({
  from: z.string(),
  to: z.string(),
  includesTest: z.boolean(),
  totals: dayFigures.omit({ day: true }),
  days: z.array(dayFigures),
});

const RANGE_REFUSALS = {
  'agents.refused.analytics_from_unset': 'fromUnset',
  'agents.refused.analytics_to_unset': 'toUnset',
  'agents.refused.analytics_range_invalid': 'rangeInvalid',
} as const;

const spendText = (lines: readonly { assetId: string; amount: string }[], none: string) =>
  lines.length ? lines.map((line) => `${displayAmount(line.amount)} ${line.assetId}`).join(', ') : none;

export function AgentsDashboard() {
  const api = useApi(),
    { userId } = useSession();
  const { t } = agentsReviewCopy.useCopy();
  const [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [includeTest, setIncludeTest] = useState(false),
    [asked, setAsked] = useState<{ from: string; to: string; includeTest: boolean; n: number } | null>(null);
  const summary = useResource(
    (signal) =>
      asked
        ? api.query('agents', 'analytics.summary', { from: asked.from, to: asked.to, includeTest: asked.includeTest }, summarySchema, {
            signal,
          })
        : Promise.resolve({ ok: true as const, data: null }),
    `agent-dashboard:${userId}:${asked ? `${asked.from}:${asked.to}:${asked.includeTest}:${asked.n}` : 'none'}`,
  );
  const resource = summary.resource;
  const refusal = resource.status === 'failed' ? RANGE_REFUSALS[resource.failure.message as keyof typeof RANGE_REFUSALS] : undefined;
  return (
    <Panel title={t('dashboardTitle')} role="region" aria-label={t('dashboardTitle')}>
      <p className="muted">{t('dashboardIntro')}</p>
      <form
        className="more-columns"
        onSubmit={(event) => {
          event.preventDefault();
          setAsked((last) => ({ from, to, includeTest, n: (last?.n ?? 0) + 1 }));
        }}
      >
        <Field label={t('from')} value={from} onChange={(e) => setFrom(e.target.value)} maxLength={32} inputMode="numeric" />
        <Field label={t('to')} value={to} onChange={(e) => setTo(e.target.value)} maxLength={32} inputMode="numeric" />
        <label className="field field--inline">
          <input type="checkbox" checked={includeTest} onChange={(e) => setIncludeTest(e.target.checked)} />
          <span>{t('includeTest')}</span>
        </label>
        <Button type="submit">{t('show')}</Button>
      </form>
      {refusal ? (
        <p role="alert">{t(refusal)}</p>
      ) : !asked ? (
        <p className="muted">{t('chooseRange')}</p>
      ) : (
        <Read resource={resource} retry={summary.reload}>
          {(data) => (data ? <DashboardFigures data={data} /> : null)}
        </Read>
      )}
    </Panel>
  );
}

function DashboardFigures({ data }: { data: z.infer<typeof summarySchema> }) {
  const { t } = agentsReviewCopy.useCopy();
  const preferences = usePreferences();
  const money = (lines: readonly { assetId: string; amount: string }[]) =>
    preferences.hideBalances ? '••••' : spendText(lines, t('noSpend'));
  const { totals } = data;
  return (
    <>
      <p role="status">{data.includesTest ? t('filterWithTest') : t('filterLive')}</p>
      <dl className="more-receipt agent-dashboard-totals">
        {(
          [
            ['sessions', totals.sessions],
            ['actions', totals.actions],
            ['executed', totals.executed],
            ['refused', totals.refused],
            ['failed', totals.failed],
          ] as const
        ).map(([key, value]) => (
          <div key={key}>
            <dt>{t(key)}</dt>
            <dd data-testid={`dashboard-${key}`}>{value}</dd>
          </div>
        ))}
        <div>
          <dt>{t('testRuns')}</dt>
          <dd data-testid="dashboard-test-runs">{totals.testRuns === null ? t('leftOut') : totals.testRuns}</dd>
        </div>
        <div>
          <dt>{t('spend')}</dt>
          <dd data-testid="dashboard-spend">{money(totals.spend)}</dd>
        </div>
      </dl>
      <p className="muted">{t('spendBasis')}</p>
      {data.days.length ? (
        <DataTable
          headers={[
            t('day'),
            t('sessions'),
            t('actions'),
            t('executed'),
            t('refused'),
            t('failed'),
            ...(data.includesTest ? [t('testRuns')] : []),
            t('spend'),
          ]}
          label={t('byDay')}
        >
          {data.days.map((day) => (
            <tr key={day.day}>
              <td lang="zxx">{day.day}</td>
              <td data-testid="day-sessions">{day.sessions}</td>
              <td data-testid="day-actions">{day.actions}</td>
              <td data-testid="day-executed">{day.executed}</td>
              <td data-testid="day-refused">{day.refused}</td>
              <td data-testid="day-failed">{day.failed}</td>
              {data.includesTest ? <td data-testid="day-test-runs">{day.testRuns}</td> : null}
              <td data-testid="day-spend">{money(day.spend)}</td>
            </tr>
          ))}
        </DataTable>
      ) : (
        <p role="status">{t('nothingInRange')}</p>
      )}
    </>
  );
}

// ── Activity ────────────────────────────────────────────────────────────────

const actionSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  sequence: z.number().int().nonnegative(),
  kind: z.enum(['session_open', 'session_close', 'completion', 'embedding', 'tool_call', 'usage_settlement']),
  status: z.enum(['executed', 'refused', 'failed']),
  tool: z.string().nullable(),
  task: z.string().nullable(),
  model: z.string().nullable(),
  inputTokens: z.string().regex(/^\d+$/),
  outputTokens: z.string().regex(/^\d+$/),
  cost: decimalSchema,
  refusalCode: z.string().nullable(),
  messageKey: z.string(),
  messageParams: z.record(z.string(), z.union([z.string(), z.number()])),
  occurredAt: z.string(),
});
type ActionRow = z.infer<typeof actionSchema>;
type Outcome = '' | 'executed' | 'refused' | 'failed';
const EXPORT_PAGE = 500;
/** How many of the newest rows the screen loads; the export always holds every row of the filter. */
const LOAD_SIZES = [50, 100, 250, 500] as const;

/** A refusal code as words only: a code this screen does not know reads as a plain sentence, never as the code. */
function reasonWords(code: string, other: string) {
  const words = refusalWords(code);
  return words === code ? other : words;
}

/** `empty` is the room's own words for a log with nothing in it; a filter that matches nothing says so instead. */
export function AgentsActivity({ title, note, empty }: { title: string; note: ReactNode; empty: string }) {
  const api = useApi(),
    { userId } = useSession();
  const { t } = agentsReviewCopy.useCopy();
  const [outcome, setOutcome] = useState<Outcome>(''),
    [limit, setLimit] = useState(50),
    [format, setFormat] = useState<'csv' | 'json'>('csv'),
    [exporting, setExporting] = useState(false),
    [exported, setExported] = useState<{ ok: true; count: number } | { ok: false } | null>(null);
  const filter = outcome ? { outcome } : {};
  const rows = useResource(
      (signal) => api.query('agents', 'log.mine', { limit, ...filter }, z.array(actionSchema).max(limit), { signal }),
      `agent-activity:${userId}:${outcome}:${limit}`,
    ),
    count = useResource(
      (signal) => api.query('agents', 'log.count', filter, z.object({ total: z.number().int().nonnegative() }), { signal }),
      `agent-activity-count:${userId}:${outcome}`,
    );

  async function exportAll() {
    setExporting(true);
    setExported(null);
    const all: ActionRow[] = [];
    // One id for the whole export: its last page writes the one audit row of it.
    const requestId = `export:${crypto.randomUUID()}`;
    let cursor: string | null | undefined;
    try {
      do {
        const page = await api.query(
          'agents',
          'log.export',
          { ...filter, limit: EXPORT_PAGE, requestId, format, ...(cursor ? { cursor } : {}) },
          z.object({ rows: z.array(actionSchema).max(EXPORT_PAGE), nextCursor: z.string().nullable() }),
        );
        if (!page.ok) {
          setExported({ ok: false });
          return;
        }
        all.push(...page.data.rows);
        cursor = page.data.nextCursor;
      } while (cursor);
      const done =
        format === 'csv'
          ? downloadCsv('agent-action-log.csv', toCsv(ACTION_LOG_HEADER, actionLogRows(all)))
          : downloadFile('agent-action-log.json', all.map((row) => JSON.stringify(row)).join('\n') + (all.length ? '\n' : ''));
      setExported(done ? { ok: true, count: all.length } : { ok: false });
    } finally {
      setExporting(false);
    }
  }

  return (
    <Panel title={title}>
      <label className="field">
        <span>{t('activityFilter')}</span>
        <select value={outcome} onChange={(event) => setOutcome(event.target.value as Outcome)}>
          <option value="">{t('outcomeAll')}</option>
          <option value="executed">{t('executed')}</option>
          <option value="refused">{t('refused')}</option>
          <option value="failed">{t('failed')}</option>
        </select>
      </label>
      <label className="field">
        <span>{t('rowsToLoad')}</span>
        <select value={String(limit)} onChange={(event) => setLimit(Number(event.target.value))}>
          {LOAD_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <Read resource={count.resource} retry={count.reload}>
        {({ total }) => (
          <p>
            {t('logTotalLabel')}: <strong data-testid="log-total">{total}</strong>
          </p>
        )}
      </Read>
      <div className="more-columns">
        <label className="field">
          <span>{t('exportFormat')}</span>
          <select value={format} onChange={(event) => setFormat(event.target.value as 'csv' | 'json')}>
            <option value="csv">{t('formatCsv')}</option>
            <option value="json">{t('formatJson')}</option>
          </select>
        </label>
        <Button variant="secondary" disabled={exporting} onClick={() => void exportAll()}>
          {exporting ? t('exporting') : t('export')}
        </Button>
      </div>
      {exported ? <p role="status">{exported.ok ? t('exported', { count: exported.count }) : t('exportFailed')}</p> : null}
      <p className="muted">{t('exportNote')}</p>
      <Read resource={rows.resource} retry={rows.reload} empty={outcome ? t('noActions') : empty}>
        {(list) => (
          <>
            <ActionTable rows={list} />
            {count.resource.status === 'ready' && count.resource.data.total > list.length ? (
              <p className="muted">{t('logShowing', { shown: list.length, total: count.resource.data.total })}</p>
            ) : null}
          </>
        )}
      </Read>
      <p className="muted">{note}</p>
    </Panel>
  );
}

function ActionTable({ rows }: { rows: readonly ActionRow[] }) {
  const { t } = agentsReviewCopy.useCopy();
  const preferences = usePreferences();
  return (
    <DataTable headers={[t('time'), t('agentSession'), t('action'), t('outcome'), t('reason'), t('cost')]} label={t('actionsTable')}>
      {rows.map((row) => (
        <tr key={row.id}>
          <td>
            <time dateTime={row.occurredAt}>{row.occurredAt}</time>
          </td>
          <td lang="zxx">
            {row.agentId}
            <small className="more-receipt">{row.sessionId}</small>
          </td>
          <td>
            {row.sequence}. {t(`kind_${row.kind}`)}
            <small lang="zxx">{row.tool ?? row.task ?? ''}</small>
          </td>
          <td data-testid="action-outcome">{t(row.status)}</td>
          <td data-testid="action-reason">{row.refusalCode ? reasonWords(row.refusalCode, t('refusedOther')) : t('noReason')}</td>
          <td lang="zxx">{preferences.hideBalances ? '••••' : displayAmount(row.cost)}</td>
        </tr>
      ))}
    </DataTable>
  );
}

function downloadFile(filename: string, text: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

// ── Usage ───────────────────────────────────────────────────────────────────

const usageGroup = z.object({
  key: z.string(),
  name: z.string().nullable(),
  windows: z.number().int().nonnegative(),
  assetId: z.string().min(1),
  amount: decimalSchema,
});
const usageSchema = z.object({
  windowCount: z.number().int().nonnegative(),
  windows: z.array(
    z.object({
      sessionId: z.string(),
      agentId: z.string(),
      agentName: z.string().nullable(),
      windowId: z.string(),
      day: z.string(),
      task: z.string(),
      state: z.enum(['unpaid', 'settled']),
      amount: decimalSchema,
      assetId: z.string().min(1),
    }),
  ),
  total: z.array(amountLine),
  byAgent: z.array(usageGroup),
  byUser: z.array(usageGroup),
  byTask: z.array(usageGroup),
});
const USAGE_PAGE = 500;

export function AgentsUsage() {
  const api = useApi(),
    { userId } = useSession();
  const { t } = agentsReviewCopy.useCopy();
  const preferences = usePreferences();
  const usage = useResource(
    (signal) => api.query('agents', 'usage.summary', { limit: USAGE_PAGE }, usageSchema, { signal }),
    `agent-usage-summary:${userId}`,
  );
  const cost = (amount: string, assetId: string) => (preferences.hideBalances ? '••••' : `${displayAmount(amount)} ${assetId}`);
  const groupTable = (
    label: string,
    head: string,
    rows: z.infer<typeof usageGroup>[],
    name: (row: z.infer<typeof usageGroup>) => string,
  ) => (
    <DataTable headers={[head, t('windows'), t('cost')]} label={label}>
      {rows.map((row) => (
        <tr key={`${row.key}:${row.assetId}`}>
          <td lang="zxx">{name(row)}</td>
          <td>{row.windows}</td>
          <td data-testid="usage-cost">{cost(row.amount, row.assetId)}</td>
        </tr>
      ))}
    </DataTable>
  );
  return (
    <Panel title={t('usageTitle')} role="region" aria-label={t('usageTitle')}>
      <p className="muted">{t('usageIntro')}</p>
      <Read resource={usage.resource} retry={usage.reload}>
        {(data) =>
          data.windowCount === 0 ? (
            <p role="status">{t('noUsage')}</p>
          ) : (
            <>
              <p>
                {t('usageTotal')}:{' '}
                <strong data-testid="usage-total">{preferences.hideBalances ? '••••' : spendText(data.total, t('noSpend'))}</strong>
              </p>
              {groupTable(t('byAgent'), t('agent'), data.byAgent, (row) => row.name ?? row.key)}
              {groupTable(t('byUser'), t('account'), data.byUser, (row) => row.key)}
              {groupTable(t('byTask'), t('task'), data.byTask, (row) => row.key || t('noTask'))}
              <DataTable headers={[t('day'), t('agent'), t('task'), t('window'), t('state'), t('cost')]} label={t('usageWindows')}>
                {data.windows.map((row) => (
                  <tr key={`${row.sessionId}:${row.windowId}`}>
                    <td lang="zxx">{row.day}</td>
                    <td lang="zxx">{row.agentName ?? row.agentId}</td>
                    <td lang="zxx">{row.task || t('noTask')}</td>
                    <td lang="zxx">{row.windowId}</td>
                    <td>{t(row.state)}</td>
                    <td data-testid="window-cost">{cost(row.amount, row.assetId)}</td>
                  </tr>
                ))}
              </DataTable>
              {data.windowCount > data.windows.length ? (
                <p className="muted">{t('usageShowing', { shown: data.windows.length, total: data.windowCount })}</p>
              ) : null}
            </>
          )
        }
      </Read>
      <p className="muted">{t('spendBasis')}</p>
    </Panel>
  );
}

// ── A run's trace ───────────────────────────────────────────────────────────

const traceSchema = z.object({
  runId: z.string(),
  requestId: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  task: z.string().nullable(),
  state: z.string(),
  cost: decimalSchema.nullable(),
  assetId: z.string().nullable(),
  startedAt: z.string(),
  plan: z.array(
    z.object({
      sequence: z.number().int(),
      state: z.enum(['admitted', 'running', 'waiting_approval', 'completed', 'refused', 'failed']),
      code: z.string().nullable(),
      startedAt: z.string(),
      tookMs: z.number().int().nullable(),
    }),
  ),
  calls: z.array(
    z.object({
      actionId: z.string(),
      sequence: z.number().int(),
      kind: z.enum(['session_open', 'session_close', 'completion', 'embedding', 'tool_call', 'usage_settlement']),
      status: z.enum(['executed', 'refused', 'failed']),
      tool: z.string().nullable(),
      task: z.string().nullable(),
      startedAt: z.string(),
      finishedAt: z.string(),
      tookMs: z.number().int().nonnegative(),
      inputTokens: z.string(),
      outputTokens: z.string(),
      cost: decimalSchema,
      refusalCode: z.string().nullable(),
    }),
  ),
});
const STATE_KEYS = {
  admitted: 'state_admitted',
  running: 'state_running',
  waiting_approval: 'state_waiting_approval',
  completed: 'state_completed',
  refused: 'state_refused',
  failed: 'state_failed',
} as const;
const TERMINAL = new Set(['completed', 'refused', 'failed']);
const clock = (at: string) => `${new Date(at).toISOString().slice(11, 23)} UTC`;

/** The runs of one recorded session, each with its trace on request. */
export function RunTraces({
  sessionId,
  runs,
}: {
  sessionId: string;
  runs: readonly { requestId: string; startedAt: string; state: 'running' | 'completed' }[];
}) {
  const { t } = agentsReviewCopy.useCopy();
  const [open, setOpen] = useState<string | null>(null);
  if (!runs.length) return null;
  return (
    <>
      <DataTable headers={[t('request'), t('started'), t('state'), '']} label={t('runsTitle')}>
        {runs.map((run) => (
          <tr key={run.requestId}>
            <td lang="zxx">{run.requestId}</td>
            <td>{clock(run.startedAt)}</td>
            <td>{t(`runState_${run.state}`)}</td>
            <td>
              <Button variant="secondary" aria-pressed={open === run.requestId} onClick={() => setOpen(run.requestId)}>
                {t('openTrace')}
              </Button>
            </td>
          </tr>
        ))}
      </DataTable>
      {open ? <RunTrace key={`${sessionId}:${open}`} sessionId={sessionId} requestId={open} /> : null}
    </>
  );
}

function RunTrace({ sessionId, requestId }: { sessionId: string; requestId: string }) {
  const api = useApi(),
    { userId } = useSession();
  const { t } = agentsReviewCopy.useCopy();
  const preferences = usePreferences();
  const trace = useResource(
    (signal) => api.query('agents', 'run.trace', { sessionId, requestId }, traceSchema, { signal }),
    `agent-run-trace:${userId}:${sessionId}:${requestId}`,
  );
  const cost = (amount: string | null, assetId: string | null) =>
    amount === null ? t('noCost') : preferences.hideBalances ? '••••' : `${displayAmount(amount)} ${assetId ?? ''}`.trim();
  return (
    <section>
      <h3>{t('traceTitle')}</h3>
      <p className="muted">{t('traceIntro')}</p>
      <Read resource={trace.resource} retry={trace.reload}>
        {(run) => (
          <>
            <DataTable headers={[t('step'), t('tool'), t('started'), t('took'), t('tokens'), t('cost')]} label={t('traceTitle')}>
              {run.plan.map((step) => (
                <tr key={`plan:${step.sequence}`} data-testid="trace-plan-step">
                  <td>
                    {t('planStep', { n: step.sequence, state: t(STATE_KEYS[step.state]) })}
                    {step.code ? <small> {reasonWords(step.code, t('refusedOther'))}</small> : null}
                  </td>
                  <td lang="zxx">{run.task ?? t('noCost')}</td>
                  <td>{clock(step.startedAt)}</td>
                  <td data-testid="trace-took">
                    {step.tookMs === null
                      ? TERMINAL.has(step.state)
                        ? t('runEnded')
                        : t('stillCurrent')
                      : t('tookMs', { ms: step.tookMs })}
                  </td>
                  <td>{t('noCost')}</td>
                  <td>{t('noCost')}</td>
                </tr>
              ))}
              {run.calls.map((call) => (
                <tr key={call.actionId} data-testid="trace-call">
                  <td>
                    {t('callStep', { n: call.sequence, kind: t(`kind_${call.kind}`), status: t(`status_${call.status}`) })}
                    {call.refusalCode ? <small> {reasonWords(call.refusalCode, t('refusedOther'))}</small> : null}
                  </td>
                  <td lang="zxx">{call.tool ?? call.task ?? t('noCost')}</td>
                  <td>{clock(call.startedAt)}</td>
                  <td data-testid="trace-took">{t('tookMs', { ms: call.tookMs })}</td>
                  <td lang="zxx">{t('tokensInOut', { input: call.inputTokens, output: call.outputTokens })}</td>
                  <td data-testid="trace-cost">{cost(call.cost, run.assetId)}</td>
                </tr>
              ))}
            </DataTable>
            <p data-testid="trace-run-cost">{t('runTotal', { cost: cost(run.cost, run.assetId) })}</p>
          </>
        )}
      </Read>
    </section>
  );
}
