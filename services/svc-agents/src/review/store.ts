import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { AgentError } from '../errors.js';

/**
 * What a person's agents did, read back from the rows svc-agents already stores (AG-analytics-01, AG-audit-01,
 * AG-usage-02; J-agents-13). Every read here is the signed person's own rows and writes nothing. Spend is only ever
 * the sum of sealed usage windows as they are stored: an open window has no amount yet and is left out, never guessed.
 * Test runs and dry runs (own_agent_test_runs) are never billed and are left out unless the reader asks for them.
 */

export type Outcome = 'executed' | 'refused' | 'failed';

/** One asset's total as a decimal string. */
export interface AssetAmount {
  readonly assetId: string;
  readonly amount: string;
}

export interface DayFigures {
  /** The UTC day, YYYY-MM-DD. */
  readonly day: string;
  readonly sessions: number;
  readonly actions: number;
  readonly executed: number;
  readonly refused: number;
  readonly failed: number;
  /** Test and dry runs that day; null when the reader left them out. */
  readonly testRuns: number | null;
  readonly spend: AssetAmount[];
}

export interface AnalyticsSummary {
  readonly from: string;
  readonly to: string;
  readonly includesTest: boolean;
  readonly totals: Omit<DayFigures, 'day'>;
  readonly days: DayFigures[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A range end as given: blank refuses naming the end; a value that is not a real UTC day refuses as invalid. */
export function rangeDay(value: string | undefined, end: 'from' | 'to'): string {
  const text = value?.trim() ?? '';
  if (!text)
    throw new AgentError(
      `Analytics range ${end} is unset — pass it (no default window is invented)`,
      'agents.analytics_range_unset',
      end === 'from' ? 'agents.refused.analytics_from_unset' : 'agents.refused.analytics_to_unset',
      { value: end },
    );
  if (!DAY.test(text) || new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) !== text)
    throw new AgentError(
      `Analytics range ${end} is not a day`,
      'agents.analytics_range_invalid',
      'agents.refused.analytics_range_invalid',
      {
        value: end,
      },
    );
  return text;
}

/** Both ends of a range, checked; a range that ends before it starts refuses. */
export function analyticsRange(from: string | undefined, to: string | undefined): { from: string; to: string } {
  const start = rangeDay(from, 'from');
  const end = rangeDay(to, 'to');
  if (end < start)
    throw new AgentError(
      'Analytics range ends before it starts',
      'agents.analytics_range_invalid',
      'agents.refused.analytics_range_invalid',
      {
        value: 'to',
      },
    );
  return { from: start, to: end };
}

function addTo(map: Map<string, Amount>, assetId: string, amount: Amount) {
  map.set(assetId, (map.get(assetId) ?? 0n) + amount);
}
const amounts = (map: Map<string, Amount>): AssetAmount[] =>
  [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([assetId, amount]) => ({ assetId, amount: formatAmount(amount) }));

/**
 * The dashboard for a range of UTC days, both ends included: sessions by the day they opened, actions by outcome and
 * the day they happened, spend as the sum of the sealed windows of the person's sessions by the day the window opened
 * (its id starts with that day, the same day J-agents-02's usage shows), and, only when asked, test and dry runs.
 */
export async function analyticsSummary(
  sql: Sql,
  input: { userId: string; from: string; to: string; includeTest: boolean; feeAssetId: string },
): Promise<AnalyticsSummary> {
  const { userId, from, to, includeTest, feeAssetId } = input;
  const [sessions, actions, windows, tests] = await Promise.all([
    sql<Array<{ day: string; n: number }>>`
      SELECT to_char(opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS n
        FROM agents.agent_sessions
       WHERE user_id = ${userId}
         AND opened_at >= ${from}::date::timestamp AT TIME ZONE 'UTC'
         AND opened_at < (${to}::date + 1)::timestamp AT TIME ZONE 'UTC'
       GROUP BY 1
    `,
    sql<Array<{ day: string; status: Outcome; n: number }>>`
      SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, status, count(*)::int AS n
        FROM agents.agent_actions
       WHERE user_id = ${userId}
         AND occurred_at >= ${from}::date::timestamp AT TIME ZONE 'UTC'
         AND occurred_at < (${to}::date + 1)::timestamp AT TIME ZONE 'UTC'
       GROUP BY 1, 2
    `,
    sql<Array<{ day: string; asset: string; amount: string }>>`
      SELECT left(w.window_id, 10) AS day, coalesce(w.charged_asset, ${feeAssetId}) AS asset,
             coalesce(sum(w.charged_amount), 0)::text AS amount
        FROM agents.usage_windows w
        JOIN agents.agent_sessions s ON s.id = w.session_id
       WHERE s.user_id = ${userId} AND w.sealed_at IS NOT NULL
         AND left(w.window_id, 10) >= ${from} AND left(w.window_id, 10) <= ${to}
       GROUP BY 1, 2
    `,
    includeTest
      ? sql<Array<{ day: string; n: number }>>`
          SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS n
            FROM agents.own_agent_test_runs
           WHERE owner_id = ${userId}
             AND created_at >= ${from}::date::timestamp AT TIME ZONE 'UTC'
             AND created_at < (${to}::date + 1)::timestamp AT TIME ZONE 'UTC'
           GROUP BY 1
        `
      : Promise.resolve([] as Array<{ day: string; n: number }>),
  ]);

  type Acc = { sessions: number; executed: number; refused: number; failed: number; testRuns: number; spend: Map<string, Amount> };
  const byDay = new Map<string, Acc>();
  const at = (day: string) => {
    let acc = byDay.get(day);
    if (!acc) byDay.set(day, (acc = { sessions: 0, executed: 0, refused: 0, failed: 0, testRuns: 0, spend: new Map() }));
    return acc;
  };
  for (const row of sessions) at(row.day).sessions += row.n;
  for (const row of actions) at(row.day)[row.status] += row.n;
  for (const row of windows) addTo(at(row.day).spend, row.asset, parseAmount(row.amount));
  for (const row of tests) at(row.day).testRuns += row.n;

  const total: Acc = { sessions: 0, executed: 0, refused: 0, failed: 0, testRuns: 0, spend: new Map() };
  const days: DayFigures[] = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, acc]) => {
      total.sessions += acc.sessions;
      total.executed += acc.executed;
      total.refused += acc.refused;
      total.failed += acc.failed;
      total.testRuns += acc.testRuns;
      for (const [asset, amount] of acc.spend) addTo(total.spend, asset, amount);
      return figures(day, acc, includeTest);
    });
  const { day: _day, ...totals } = figures('', total, includeTest);
  return { from, to, includesTest: includeTest, totals, days };
}

function figures(
  day: string,
  acc: { sessions: number; executed: number; refused: number; failed: number; testRuns: number; spend: Map<string, Amount> },
  includeTest: boolean,
): DayFigures {
  return {
    day,
    sessions: acc.sessions,
    actions: acc.executed + acc.refused + acc.failed,
    executed: acc.executed,
    refused: acc.refused,
    failed: acc.failed,
    testRuns: includeTest ? acc.testRuns : null,
    spend: amounts(acc.spend),
  };
}

// ── The run trace ───────────────────────────────────────────────────────────

export interface TraceStep {
  readonly sequence: number;
  readonly state: string;
  readonly code: string | null;
  readonly startedAt: string;
  /** Milliseconds until the next step started; null for the last step, which ended the run or is still current. */
  readonly tookMs: number | null;
}

export interface TraceCall {
  readonly actionId: string;
  readonly sequence: number;
  readonly kind: string;
  readonly status: Outcome;
  readonly tool: string | null;
  readonly task: string | null;
  /** When the call was claimed, before the engine was asked; a call with no claim starts when it was recorded. */
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly tookMs: number;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly cost: string;
  readonly refusalCode: string | null;
}

export interface RunTrace {
  readonly runId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly task: string | null;
  readonly state: string;
  readonly cost: string | null;
  readonly assetId: string | null;
  readonly startedAt: string;
  readonly plan: TraceStep[];
  readonly calls: TraceCall[];
}

/**
 * One run of one of the person's sessions, timed from its stored rows: the run's steps from its event trail (admitted,
 * running, then how it ended), each with when it started and how long it lasted, and the calls the run made from the
 * action log with their tokens and cost. Null when the session holds no such run.
 */
export async function runTrace(sql: Sql, input: { sessionId: string; requestId: string }): Promise<RunTrace | null> {
  const [run] = await sql<
    Array<{
      id: string;
      request_id: string;
      session_id: string;
      agent_id: string;
      task: string | null;
      state: string;
      cost: string | null;
      asset_id: string | null;
      action_id: string | null;
      created_at: Date;
    }>
  >`
    SELECT id, request_id, session_id::text, agent_id, task, state, cost::text, asset_id, action_id::text, created_at
      FROM agents.agent_runs
     WHERE session_id = ${input.sessionId} AND request_id = ${input.requestId}
  `;
  if (!run) return null;
  const [events, claims, calls] = await Promise.all([
    sql<Array<{ sequence: number; state: string; code: string | null; occurred_at: Date }>>`
      SELECT sequence, state, code, occurred_at FROM agents.agent_run_events WHERE run_id = ${run.id} ORDER BY sequence
    `,
    sql<Array<{ claimed_at: Date }>>`
      SELECT claimed_at FROM agents.think_claims WHERE session_id = ${run.session_id} AND request_id = ${run.request_id}
    `,
    run.action_id
      ? sql<
          Array<{
            id: string;
            sequence: number;
            kind: string;
            status: Outcome;
            tool: string | null;
            task: string | null;
            input_tokens: string;
            output_tokens: string;
            cost: string;
            refusal_code: string | null;
            occurred_at: Date;
          }>
        >`
          SELECT id, sequence, kind, status, tool, task, input_tokens::text, output_tokens::text, cost::text, refusal_code, occurred_at
            FROM agents.agent_actions
           WHERE id = ${run.action_id} AND session_id = ${run.session_id}
        `
      : Promise.resolve([]),
  ]);
  const claimedAt = claims[0]?.claimed_at ?? null;
  return {
    runId: run.id,
    requestId: run.request_id,
    sessionId: run.session_id,
    agentId: run.agent_id,
    task: run.task,
    state: run.state,
    cost: run.cost === null ? null : formatAmount(parseAmount(run.cost)),
    assetId: run.asset_id,
    startedAt: run.created_at.toISOString(),
    plan: events.map((event, index) => {
      const next = events[index + 1];
      return {
        sequence: event.sequence,
        state: event.state,
        code: event.code,
        startedAt: event.occurred_at.toISOString(),
        tookMs: next ? next.occurred_at.getTime() - event.occurred_at.getTime() : null,
      };
    }),
    calls: calls.map((call) => {
      const started = claimedAt && claimedAt <= call.occurred_at ? claimedAt : call.occurred_at;
      return {
        actionId: call.id,
        sequence: Number(call.sequence),
        kind: call.kind,
        status: call.status,
        tool: call.tool,
        task: call.task,
        startedAt: started.toISOString(),
        finishedAt: call.occurred_at.toISOString(),
        tookMs: call.occurred_at.getTime() - started.getTime(),
        inputTokens: call.input_tokens,
        outputTokens: call.output_tokens,
        cost: formatAmount(parseAmount(call.cost)),
        refusalCode: call.refusal_code,
      };
    }),
  };
}

// ── The activity log: filtered, counted and exported whole ──────────────────

/** A position in the log, newest first: the last row's time, session and sequence. */
export interface LogCursor {
  readonly at: string;
  readonly sessionId: string;
  readonly sequence: number;
}

export function encodeLogCursor(cursor: LogCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.sessionId, cursor.sequence])).toString('base64url');
}

export function decodeLogCursor(text: string): LogCursor {
  try {
    const [at, sessionId, sequence] = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as unknown[];
    if (
      typeof at === 'string' &&
      Number.isFinite(Date.parse(at)) &&
      typeof sessionId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId) &&
      typeof sequence === 'number' &&
      Number.isSafeInteger(sequence) &&
      sequence >= 0
    )
      return { at, sessionId, sequence };
  } catch {
    /* refused below */
  }
  throw new AgentError('Log cursor is not one this service issued', 'agents.cursor_invalid', 'agents.refused.cursor_invalid');
}

/** The business key of a person's export of their own log: one audit row per export, however often it is retried. */
export const ownExportKey = (userId: string, requestId: string) => `agents:logexport:${userId}:${requestId}`;

/**
 * The audit row of a person's export of their own log (AG-audit-01): written once, on the export's last page, in the
 * append-only agent_log_reads table, with the person as both reader and subject. A retry with the same request id
 * writes nothing more.
 */
export async function recordOwnExport(
  sql: Sql,
  input: { userId: string; requestId: string; filter: Record<string, string>; rowCount: number },
): Promise<void> {
  await sql`
    INSERT INTO agents.agent_log_reads (business_key, operator_id, subject_id, kind, reason, filter, row_count)
    VALUES (${ownExportKey(input.userId, input.requestId)}, ${input.userId}, ${input.userId}, 'export', 'own_export',
            ${sql.json(input.filter)}, ${input.rowCount})
    ON CONFLICT (business_key) DO NOTHING
  `;
}

// ── Usage by agent, user and task, from sealed windows ─────────────────────

export interface UsageWindowRow {
  readonly sessionId: string;
  readonly agentId: string;
  readonly agentName: string | null;
  readonly windowId: string;
  readonly day: string;
  readonly task: string;
  readonly state: 'unpaid' | 'settled';
  readonly amount: string;
  readonly assetId: string;
}

export interface UsageGroup {
  readonly key: string;
  readonly name: string | null;
  readonly windows: number;
  readonly assetId: string;
  readonly amount: string;
}

export interface UsageSummary {
  /** Every sealed window of the person's sessions, counted; `windows` holds the newest `limit` of them. */
  readonly windowCount: number;
  readonly windows: UsageWindowRow[];
  readonly total: AssetAmount[];
  readonly byAgent: UsageGroup[];
  readonly byUser: UsageGroup[];
  readonly byTask: UsageGroup[];
}

/**
 * The person's usage from sealed windows only, the same rule as session.mine and J-agents-02's usage: each sealed
 * window's stored amount, by agent, by user (the account the session belongs to) and by task (every task the window's
 * usage ran as). Each grouping adds up to the same total, because each sealed window lands in exactly one group.
 */
export async function usageSummary(sql: Sql, input: { userId: string; limit: number; feeAssetId: string }): Promise<UsageSummary> {
  const rows = await sql<
    Array<{
      session_id: string;
      user_id: string;
      agent_id: string;
      agent_name: string | null;
      window_id: string;
      task: string;
      unpaid: boolean;
      amount: string;
      asset: string;
    }>
  >`
    SELECT w.session_id::text, s.user_id, s.agent_id, nullif(oa.name, '') AS agent_name, w.window_id,
           coalesce(t.tasks, '') AS task,
           (w.charge_tx_id IS NULL AND w.charged_amount > 0) AS unpaid,
           coalesce(w.charged_amount, 0)::text AS amount, coalesce(w.charged_asset, ${input.feeAssetId}) AS asset
      FROM agents.usage_windows w
      JOIN agents.agent_sessions s ON s.id = w.session_id
      LEFT JOIN agents.own_agents oa ON oa.id::text = s.agent_id AND oa.owner_id = s.user_id
      LEFT JOIN LATERAL (
        SELECT string_agg(DISTINCT r.task, ', ' ORDER BY r.task) AS tasks
          FROM agents.usage_records r
         WHERE r.session_id = w.session_id AND r.window_id = w.window_id
      ) t ON true
     WHERE s.user_id = ${input.userId} AND w.sealed_at IS NOT NULL
     ORDER BY w.window_id DESC, w.session_id DESC
  `;
  const total = new Map<string, Amount>();
  const groups = { agent: new Map<string, Group>(), user: new Map<string, Group>(), task: new Map<string, Group>() };
  for (const row of rows) {
    const amount = parseAmount(row.amount);
    addTo(total, row.asset, amount);
    group(groups.agent, row.agent_id, row.agent_name, row.asset, amount);
    group(groups.user, row.user_id, null, row.asset, amount);
    group(groups.task, row.task, null, row.asset, amount);
  }
  return {
    windowCount: rows.length,
    windows: rows.slice(0, input.limit).map((row) => ({
      sessionId: row.session_id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      windowId: row.window_id,
      day: row.window_id.slice(0, 10),
      task: row.task,
      state: row.unpaid ? 'unpaid' : 'settled',
      amount: formatAmount(parseAmount(row.amount)),
      assetId: row.asset,
    })),
    total: amounts(total),
    byAgent: groupRows(groups.agent),
    byUser: groupRows(groups.user),
    byTask: groupRows(groups.task),
  };
}

type Group = { key: string; name: string | null; assetId: string; windows: number; amount: Amount };

function group(map: Map<string, Group>, key: string, name: string | null, assetId: string, amount: Amount) {
  const id = `${key}\u0000${assetId}`;
  const found = map.get(id);
  if (found) {
    found.windows += 1;
    found.amount += amount;
  } else map.set(id, { key, name, assetId, windows: 1, amount });
}

const groupRows = (map: Map<string, Group>): UsageGroup[] =>
  [...map.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.assetId < b.assetId ? -1 : 1))
    .map((g) => ({ key: g.key, name: g.name, windows: g.windows, assetId: g.assetId, amount: formatAmount(g.amount) }));
