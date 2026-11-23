import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session';
import { useResource } from '../../shared/resource';
import { displayAmount } from '../../shared/money';
import { usePreferences } from '../../shared/preferences';
import { Button, Field } from '@intafaced/ui/lit';
import { Checkbox } from '@intafaced/ui/lit/templates';
import { Read } from './common';
import { refusalWords } from './AgentsCatalogue';
import { ACTION_LOG_HEADER, actionLogRows } from './agents-catalogue';
import { downloadCsv, toCsv } from './depth-csv';
import { agentsReviewCopy } from './agents-review-copy';
import { ScrollTable, Section } from './volt-parts';
import { ACTION_LOG_EXPORT_PAGE, usageGroupSchema, type ActionLogRow } from '@intafaced/contracts/agents-review';
import { AGENTS_RUN_TRACE } from '@intafaced/contracts/agents-run-procedures';
import { AGENTS_LOG_MINE, AGENTS_LOG_COUNT, AGENTS_LOG_EXPORT } from '@intafaced/contracts/agents-log-procedures';
import { AGENTS_USAGE_SUMMARY } from '@intafaced/contracts/agents-usage-procedures';
import { AGENTS_ANALYTICS_SUMMARY } from '@intafaced/contracts/agents-analytics-procedures';
import { type ProcedureOutput } from '@intafaced/contracts/procedure';

/**
 * What my agents did (J-agents-13): the dashboard over a range of days, the activity log with its outcome filter and a
 * whole-log export, usage by agent, user and task, and one run's trace. Every figure is read from the service's stored
 * rows for the signed person; spend is the sum of sealed usage windows as stored. Nothing here writes or moves money.
 */

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
        ? api.call(
            AGENTS_ANALYTICS_SUMMARY,
            { from: asked.from, to: asked.to, includeTest: asked.includeTest },
            {
              signal,
            },
          )
        : Promise.resolve({ ok: true as const, data: null }),
    `agent-dashboard:${userId}:${asked ? `${asked.from}:${asked.to}:${asked.includeTest}:${asked.n}` : 'none'}`,
  );
  const resource = summary.resource;
  const refusal = resource.status === 'failed' ? RANGE_REFUSALS[resource.failure.message as keyof typeof RANGE_REFUSALS] : undefined;
  return (
    <Section className="lt-region" title={t('dashboardTitle')} role="region" aria-label={t('dashboardTitle')}>
      <p className="lt-muted">{t('dashboardIntro')}</p>
      <form
        className="lt-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          setAsked((last) => ({ from, to, includeTest, n: (last?.n ?? 0) + 1 }));
        }}
      >
        <Field label={t('from')} value={from} onChange={(e) => setFrom(e.target.value)} maxLength={32} inputMode="numeric" />
        <Field label={t('to')} value={to} onChange={(e) => setTo(e.target.value)} maxLength={32} inputMode="numeric" />
        <Checkbox label={t('includeTest')} checked={includeTest} onChange={(e) => setIncludeTest(e.target.checked)} />
        <Button tone="primary" type="submit">
          {t('show')}
        </Button>
      </form>
      {refusal ? (
        <p role="alert">{t(refusal)}</p>
      ) : !asked ? (
        <p className="lt-muted">{t('chooseRange')}</p>
      ) : (
        <Read resource={resource} retry={summary.reload}>
          {(data) => (data ? <DashboardFigures data={data} /> : null)}
        </Read>
      )}
    </Section>
  );
}

function DashboardFigures({ data }: { data: ProcedureOutput<typeof AGENTS_ANALYTICS_SUMMARY> }) {
  const { t } = agentsReviewCopy.useCopy();
  const preferences = usePreferences();
  const money = (lines: readonly { assetId: string; amount: string }[]) =>
    preferences.hideBalances ? '••••' : spendText(lines, t('noSpend'));
  const { totals } = data;
  return (
    <>
      <p role="status">{data.includesTest ? t('filterWithTest') : t('filterLive')}</p>
      <dl className="lt-kv">
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
      <p className="lt-muted">{t('spendBasis')}</p>
      {data.days.length ? (
        <ScrollTable
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
        </ScrollTable>
      ) : (
        <p role="status">{t('nothingInRange')}</p>
      )}
    </>
  );
}

// ── Activity ────────────────────────────────────────────────────────────────

type Outcome = '' | 'executed' | 'refused' | 'failed';
const EXPORT_PAGE = ACTION_LOG_EXPORT_PAGE;
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
      (signal) => api.call(AGENTS_LOG_MINE, { limit, ...filter }, { signal }),
      `agent-activity:${userId}:${outcome}:${limit}`,
    ),
    count = useResource((signal) => api.call(AGENTS_LOG_COUNT, filter, { signal }), `agent-activity-count:${userId}:${outcome}`);

  async function exportAll() {
    setExporting(true);
    setExported(null);
    const all: ActionLogRow[] = [];
    // One id for the whole export: its last page writes the one audit row of it.
    const requestId = `export:${crypto.randomUUID()}`;
    let cursor: string | null | undefined;
    try {
      do {
        const page = await api.call(AGENTS_LOG_EXPORT, { ...filter, limit: EXPORT_PAGE, requestId, format, ...(cursor ? { cursor } : {}) });
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
    <Section className="lt-region" title={title}>
      <label className="lt-field">
        <span>{t('activityFilter')}</span>
        <select value={outcome} onChange={(event) => setOutcome(event.target.value as Outcome)}>
          <option value="">{t('outcomeAll')}</option>
          <option value="executed">{t('executed')}</option>
          <option value="refused">{t('refused')}</option>
          <option value="failed">{t('failed')}</option>
        </select>
      </label>
      <label className="lt-field">
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
      <div className="lt-toolbar">
        <label className="lt-field">
          <span>{t('exportFormat')}</span>
          <select value={format} onChange={(event) => setFormat(event.target.value as 'csv' | 'json')}>
            <option value="csv">{t('formatCsv')}</option>
            <option value="json">{t('formatJson')}</option>
          </select>
        </label>
        <Button tone="secondary" disabled={exporting} onClick={() => void exportAll()}>
          {exporting ? t('exporting') : t('export')}
        </Button>
      </div>
      {exported ? <p role="status">{exported.ok ? t('exported', { count: exported.count }) : t('exportFailed')}</p> : null}
      <p className="lt-muted">{t('exportNote')}</p>
      <Read resource={rows.resource} retry={rows.reload} empty={outcome ? t('noActions') : empty}>
        {(list) => (
          <>
            <ActionTable rows={list} />
            {count.resource.status === 'ready' && count.resource.data.total > list.length ? (
              <p className="lt-muted">{t('logShowing', { shown: list.length, total: count.resource.data.total })}</p>
            ) : null}
          </>
        )}
      </Read>
      <p className="lt-muted">{note}</p>
    </Section>
  );
}

function ActionTable({ rows }: { rows: readonly ActionLogRow[] }) {
  const { t } = agentsReviewCopy.useCopy();
  const preferences = usePreferences();
  return (
    <ScrollTable headers={[t('time'), t('agentSession'), t('action'), t('outcome'), t('reason'), t('cost')]} label={t('actionsTable')}>
      {rows.map((row) => (
        <tr key={row.id}>
          <td>
            <time dateTime={row.occurredAt}>{row.occurredAt}</time>
          </td>
          <td lang="zxx">
            {row.agentId}
            <small className="lt-mono lt-muted">{row.sessionId}</small>
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
    </ScrollTable>
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

const USAGE_PAGE = 500;

export function AgentsUsage() {
  const api = useApi(),
    { userId } = useSession();
  const { t } = agentsReviewCopy.useCopy();
  const preferences = usePreferences();
  const usage = useResource((signal) => api.call(AGENTS_USAGE_SUMMARY, { limit: USAGE_PAGE }, { signal }), `agent-usage-summary:${userId}`);
  const cost = (amount: string, assetId: string) => (preferences.hideBalances ? '••••' : `${displayAmount(amount)} ${assetId}`);
  const groupTable = (
    label: string,
    head: string,
    rows: z.infer<typeof usageGroupSchema>[],
    name: (row: z.infer<typeof usageGroupSchema>) => string,
  ) => (
    <ScrollTable headers={[head, t('windows'), t('cost')]} label={label}>
      {rows.map((row) => (
        <tr key={`${row.key}:${row.assetId}`}>
          <td lang="zxx">{name(row)}</td>
          <td>{row.windows}</td>
          <td data-testid="usage-cost">{cost(row.amount, row.assetId)}</td>
        </tr>
      ))}
    </ScrollTable>
  );
  return (
    <Section className="lt-region" title={t('usageTitle')} role="region" aria-label={t('usageTitle')}>
      <p className="lt-muted">{t('usageIntro')}</p>
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
              <ScrollTable headers={[t('day'), t('agent'), t('task'), t('window'), t('state'), t('cost')]} label={t('usageWindows')}>
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
              </ScrollTable>
              {data.windowCount > data.windows.length ? (
                <p className="lt-muted">{t('usageShowing', { shown: data.windows.length, total: data.windowCount })}</p>
              ) : null}
            </>
          )
        }
      </Read>
      <p className="lt-muted">{t('spendBasis')}</p>
    </Section>
  );
}

// ── A run's trace ───────────────────────────────────────────────────────────

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
      <ScrollTable headers={[t('request'), t('started'), t('state'), '']} label={t('runsTitle')}>
        {runs.map((run) => (
          <tr key={run.requestId}>
            <td lang="zxx">{run.requestId}</td>
            <td>{clock(run.startedAt)}</td>
            <td>{t(`runState_${run.state}`)}</td>
            <td>
              <Button tone="secondary" aria-pressed={open === run.requestId} onClick={() => setOpen(run.requestId)}>
                {t('openTrace')}
              </Button>
            </td>
          </tr>
        ))}
      </ScrollTable>
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
    (signal) => api.call(AGENTS_RUN_TRACE, { sessionId, requestId }, { signal }),
    `agent-run-trace:${userId}:${sessionId}:${requestId}`,
  );
  const cost = (amount: string | null, assetId: string | null) =>
    amount === null ? t('noCost') : preferences.hideBalances ? '••••' : `${displayAmount(amount)} ${assetId ?? ''}`.trim();
  return (
    <section>
      <h3>{t('traceTitle')}</h3>
      <p className="lt-muted">{t('traceIntro')}</p>
      <Read resource={trace.resource} retry={trace.reload}>
        {(run) => (
          <>
            <ScrollTable headers={[t('step'), t('tool'), t('started'), t('took'), t('tokens'), t('cost')]} label={t('traceTitle')}>
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
            </ScrollTable>
            <p data-testid="trace-run-cost">{t('runTotal', { cost: cost(run.cost, run.assetId) })}</p>
          </>
        )}
      </Read>
    </section>
  );
}
