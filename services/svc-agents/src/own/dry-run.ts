import type { Sql } from 'postgres';
import type {
  OwnAgentAnalytics,
  OwnAgentDryRunCheck,
  OwnAgentDryRunEffect,
  OwnAgentHolds,
  OwnAgentLiveEngine,
  OwnAgentTestLogRow,
  OwnAgentTestGuard,
  OwnAgentTestRun,
  OwnAgentValuePayload,
} from '@intafaced/contracts/agents-own';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { OWN_TOOL_DOORS, OWN_TOOLS, OwnAgentRefusal } from './catalog.js';
import { OwnConsentStore, OwnRuleStore, stricter, type PolicyBaseline, type RuleChoice } from './guardrails.js';
import { readOwnCaps } from './limits.js';
import { decideApproval, guardedEngineRun } from './content-guard.js';

/**
 * DRY RUNS OF A PERSON'S OWN AGENT (AG-spend-04; J-agents-04 #3).
 *
 * A dry run checks one call of one of the agent's tools the way `own.tool.try` and `own.session.open` check a real one,
 * and says what the call would do. It reads the agent, the person's consents, rules and caps, and the owner's baseline;
 * it writes only its own test-run row. It opens no session and calls no tool, the runtime, the spend gate or the
 * ledger, so it makes no ledger entry, no intent and no reservation. Every dry run is a test run: labelled TEST, never
 * billed, listed apart from live runs and left out of live analytics unless the person includes it (J-agents-04 #4).
 */

/** The agent as a dry run needs it: its id and the tools saved on it. */
export type DryRunAgent = { readonly id: string; readonly tools: readonly string[] };

export type DryRunOutcome = { readonly checks: OwnAgentDryRunCheck[]; readonly effect: OwnAgentDryRunEffect };

const passed = (check: OwnAgentDryRunCheck['check']): OwnAgentDryRunCheck => ({ check, passed: true, code: null });
const failed = (check: OwnAgentDryRunCheck['check'], code: string): OwnAgentDryRunCheck => ({ check, passed: false, code });

/**
 * Every check a real call of `tool` would meet, in the order it meets them, and the would-be effect. The caps come
 * first, as the session a real call runs in cannot open without them. A tool the agent does not carry, or one that moves
 * money, stops there: nothing after it has a class to check. Otherwise every check is evaluated, and the effect is
 * refused with the first failing check's code, or what the call would do in a new session of the agent.
 */
export async function dryRunToolCall(
  sql: Sql,
  baseline: PolicyBaseline,
  input: { ownerId: string; agent: DryRunAgent; tool: string; input: Readonly<Record<string, string>> },
): Promise<DryRunOutcome> {
  const caps = await readOwnCaps(sql, input.ownerId, input.agent.id);
  const checks: OwnAgentDryRunCheck[] = [caps ? passed('caps_set') : failed('caps_set', 'agents.spend.cap_unset')];
  const refusedAt = (): DryRunOutcome => {
    const first = checks.find((check) => !check.passed)!;
    return { checks, effect: { kind: 'refused', tool: input.tool, code: first.code! } };
  };
  const entry = OWN_TOOLS.find((tool) => tool.name === input.tool);
  // As a new session's guardrail grants it (ownGuardrail): on the agent, with a declared shape and a class.
  const declared = entry && input.agent.tools.includes(input.tool) && entry.shape !== null && entry.dataClass !== null;
  checks.push(declared ? passed('tool_declared') : failed('tool_declared', 'agents.tool_not_declared'));
  checks.push(entry?.movesMoney ? failed('moves_no_value', 'agents.own.money_tool') : passed('moves_no_value'));
  if (!declared || entry.movesMoney || entry.dataClass === null || entry.shape === null) return refusedAt();
  const { dataClass, module } = entry;
  const consented = await new OwnConsentStore(sql).granted(input.ownerId, input.agent.id, dataClass);
  checks.push(consented ? passed('consent') : failed('consent', 'agents.consent_required'));
  const required = baseline[dataClass];
  checks.push(required ? passed('baseline') : failed('baseline', 'agents.baseline_value_unset'));
  let choice: RuleChoice | null = null;
  if (required) {
    const rule = await new OwnRuleStore(sql).forTool(input.ownerId, input.agent.id, input.tool);
    choice = rule ? stricter(rule.choice, required) : required;
    checks.push(choice === 'hand_off' ? failed('rule', 'agents.rule_hand_off') : passed('rule'));
  }
  const asks = choice === 'ask_before';
  // A call a rule holds for approval runs nothing yet, so its door is not met; one that would run meets it.
  if (!asks) checks.push(OWN_TOOL_DOORS.has(input.tool) ? passed('door_wired') : failed('door_wired', 'agents.tool_not_wired'));
  if (checks.some((check) => !check.passed)) return refusedAt();
  return { checks, effect: { kind: asks ? 'ask' : 'run', tool: input.tool, module, dataClass, input: { ...input.input } } };
}

type RowKind = OwnAgentTestRun['kind'];
interface TestRunRow {
  id: string;
  request_id: string;
  kind: RowKind;
  tool: string | null;
  input_json: Record<string, string> | null;
  checks_json: OwnAgentDryRunCheck[] | null;
  effect_json: OwnAgentDryRunEffect | null;
  ask: string | null;
  reply: string | null;
  live_engine: OwnAgentLiveEngine | null;
  log_json: OwnAgentTestLogRow[] | null;
  content: string | null;
  output_schema: string | null;
  guard_json: OwnAgentTestGuard | null;
  draft_json: OwnAgentValuePayload | null;
  created_at: Date;
}
const TEST_RUN_COLUMNS =
  'id, request_id, kind, tool, input_json, checks_json, effect_json, ask, reply, live_engine, log_json, content, output_schema, guard_json, draft_json, created_at';

/** An engine run kept before the guards existed read no outside content and met no schema: it answered. */
const UNGUARDED: OwnAgentTestGuard = { content: null, outcome: 'answered', code: null, approval: null };

const testRunView = (row: TestRunRow, assetId: string): OwnAgentTestRun => {
  const base = {
    id: row.id,
    requestId: row.request_id,
    mode: 'test' as const,
    cost: '0' as const,
    assetId,
    label: 'TEST' as const,
    createdAt: row.created_at.toISOString(),
  };
  if (row.kind === 'engine_run') {
    return {
      ...base,
      kind: 'engine_run',
      ask: row.ask!,
      reply: row.reply!,
      engine: 'test',
      liveEngine: row.live_engine!,
      log: row.log_json!,
      content: row.content,
      outputSchema: row.output_schema,
      guard: row.guard_json ?? UNGUARDED,
    };
  }
  return { ...base, kind: row.kind, tool: row.tool!, input: row.input_json!, checks: row.checks_json!, effect: row.effect_json! };
};

/** A sorted copy of one call's input, so the same input in another field order is the same call. */
const sortedInput = (args: Readonly<Record<string, string>>) => JSON.stringify(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)));

/** What a request is, to tell the same request again from a request id reused for another. */
type Call =
  | { kind: 'dry_run' | 'tool_test'; tool: string; input: Readonly<Record<string, string>> }
  | { kind: 'engine_run'; ask: string; content: string | null; outputSchema: string | null };

const sameCall = (row: TestRunRow, call: Call): boolean =>
  row.kind === call.kind &&
  (call.kind === 'engine_run'
    ? row.ask === call.ask && row.content === call.content && row.output_schema === call.outputSchema
    : row.tool === call.tool && sortedInput(row.input_json ?? {}) === sortedInput(call.input));

/** What a test run stores, beside its key: a dry run or tool test's call and outcome, or an engine run's exchange. */
type Stored =
  | { kind: 'dry_run' | 'tool_test'; tool: string; input: Readonly<Record<string, string>>; outcome: DryRunOutcome }
  | {
      kind: 'engine_run';
      ask: string;
      reply: string;
      liveEngine: OwnAgentLiveEngine;
      log: OwnAgentTestLogRow[];
      content: string | null;
      outputSchema: string | null;
      guard: OwnAgentTestGuard;
      drafted: OwnAgentValuePayload | null;
    };

/**
 * A tool that moves value, tested (AG-testing-01; J-agents-04 #2): what a call of it would do, and the check a real call
 * of it by the person's own agent fails. Pure: it reads nothing and sends nothing, so no ledger call is made and no
 * session, reservation or intent. A tool that moves no value, or one not offered, is refused by name: a dry run is how
 * those are tested.
 */
export function testValueTool(tool: string): DryRunOutcome {
  const entry = OWN_TOOLS.find((row) => row.name === tool);
  if (!entry) throw new OwnAgentRefusal('agents.tool_not_declared', { tool });
  if (!entry.movesMoney) throw new OwnAgentRefusal('agents.test.tool_moves_no_value', { tool });
  return {
    checks: [{ check: 'moves_no_value', passed: false, code: 'agents.own.money_tool' }],
    effect: { kind: 'would_move', tool, module: entry.module, input: {} },
  };
}

/** What one test engine run reads beside the question: outside content and an output schema, each optional. */
export type EngineRunExtras = { readonly content?: string | null; readonly outputSchema?: string | null };

/** Optional text as stored: absent or blank is none. */
const optionalText = (text: string | null | undefined): string | null =>
  text === undefined || text === null || !text.trim() ? null : text;

/**
 * One question asked of the agent on the test engine (AG-testing-01; J-agents-04 #1), under the hostile content and
 * output guards (AG-guardrails-03; J-agents-10 #1-#3). The test engine answers from the input alone, whatever engine the
 * deployment runs live runs on (`liveEngine`, kept beside the run): it calls no provider, opens no session, holds no
 * reservation, writes no usage row and calls no ledger. The reply and every log row are labelled TEST, and the run costs
 * 0, blocked or not.
 */
export function testEngineRun(
  ask: string,
  liveEngine: OwnAgentLiveEngine,
  assetId: string,
  extras: EngineRunExtras = {},
): Extract<Stored, { kind: 'engine_run' }> {
  const content = optionalText(extras.content);
  const outputSchema = optionalText(extras.outputSchema);
  for (const text of [ask, content ?? '', outputSchema ?? ''])
    if (/\u0000/.test(text)) throw new OwnAgentRefusal('agents.own.text_invalid');
  if (!ask.trim()) throw new OwnAgentRefusal('agents.test.ask_blank');
  const { guard, reply, drafted } = guardedEngineRun({ ask, content, outputSchema });
  const middle: OwnAgentTestLogRow =
    guard.outcome === 'blocked' ? { step: 'blocked', text: guard.code!, label: 'TEST' } : { step: 'answered', text: reply, label: 'TEST' };
  return {
    kind: 'engine_run',
    ask,
    reply,
    liveEngine,
    content,
    outputSchema,
    guard,
    drafted,
    log: [{ step: 'asked', text: ask, label: 'TEST' }, middle, { step: 'billed', text: `0 ${assetId}`, label: 'TEST' }],
  };
}

/** An own agent's test runs. Nothing here is a balance and no value moves. */
export class OwnTestRunStore {
  constructor(
    private readonly sql: Sql,
    private readonly assetId: string,
  ) {}

  /**
   * Stores one dry run under `agents:test-run:<agent>:<request id>`. The same request id again returns the dry run it
   * made, as it was; with another tool or input it refuses `agents.request_id_replay`.
   */
  async dryRun(
    ownerId: string,
    agentId: string,
    requestId: string,
    call: { tool: string; input: Readonly<Record<string, string>> },
    check: () => Promise<DryRunOutcome>,
  ): Promise<OwnAgentTestRun> {
    return this.once(ownerId, agentId, requestId, { kind: 'dry_run', ...call }, async () => ({
      kind: 'dry_run',
      ...call,
      outcome: await check(),
    }));
  }

  /** Stores one tool test, keyed as a dry run is; the same request id again is that test. */
  async toolTest(ownerId: string, agentId: string, requestId: string, tool: string): Promise<OwnAgentTestRun> {
    return this.once(ownerId, agentId, requestId, { kind: 'tool_test', tool, input: {} }, async () => ({
      kind: 'tool_test',
      tool,
      input: {},
      outcome: testValueTool(tool),
    }));
  }

  /** Stores one test engine run, keyed as a dry run is; the same request id again is that run, as it was. */
  async engineRun(
    ownerId: string,
    agentId: string,
    requestId: string,
    ask: string,
    liveEngine: OwnAgentLiveEngine,
    extras: EngineRunExtras = {},
  ): Promise<OwnAgentTestRun> {
    const call: Call = { kind: 'engine_run', ask, content: optionalText(extras.content), outputSchema: optionalText(extras.outputSchema) };
    return this.once(ownerId, agentId, requestId, call, async () => testEngineRun(ask, liveEngine, this.assetId, extras));
  }

  /**
   * The person's decision on an engine run's approval request (AG-guardrails-03; J-agents-10 #2): only `approved` counts,
   * and the drafted step must match it or the run is refused `agents.payload.mismatch`. The decision is kept on the run
   * once, under a row lock: approving a decided run again returns the decision it has, and nothing is ever sent.
   */
  async approve(ownerId: string, agentId: string, runId: string, approved: OwnAgentValuePayload): Promise<OwnAgentTestRun> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<TestRunRow[]>`
        SELECT ${tx.unsafe(TEST_RUN_COLUMNS)} FROM agents.own_agent_test_runs
         WHERE owner_id = ${ownerId} AND agent_id = ${agentId} AND id = ${runId} AND kind = 'engine_run'
         FOR UPDATE
      `;
      const row = rows[0];
      if (!row) throw new OwnAgentRefusal('agents.test.run_not_found');
      const guard = row.guard_json ?? UNGUARDED;
      if (guard.outcome === 'approved' || guard.outcome === 'payload_refused') return testRunView(row, this.assetId);
      const decided = decideApproval(guard, row.draft_json, approved);
      const log: OwnAgentTestLogRow[] = [
        ...(row.log_json ?? []).filter((entry) => entry.step !== 'billed'),
        { step: 'decided', text: decided.code ?? 'approved', label: 'TEST' },
        { step: 'billed', text: `0 ${this.assetId}`, label: 'TEST' },
      ];
      const updated = await tx<TestRunRow[]>`
        UPDATE agents.own_agent_test_runs
           SET guard_json = ${tx.json(decided as never)}, log_json = ${tx.json(log as never)}
         WHERE id = ${row.id}
        RETURNING ${tx.unsafe(TEST_RUN_COLUMNS)}
      `;
      return testRunView(updated[0]!, this.assetId);
    }) as Promise<OwnAgentTestRun>;
  }

  private async once(
    ownerId: string,
    agentId: string,
    requestId: string,
    call: Call,
    make: () => Promise<Stored>,
  ): Promise<OwnAgentTestRun> {
    const key = `agents:test-run:${agentId}:${requestId}`;
    const stored = await this.find(ownerId, key);
    if (stored) return this.replayed(stored, call);
    const made = await make();
    const json = <T>(value: T) => (value === null ? null : this.sql.json(value as never));
    const run =
      made.kind === 'engine_run'
        ? {
            tool: null,
            input: null,
            checks: null,
            effect: null,
            ask: made.ask,
            reply: made.reply,
            liveEngine: made.liveEngine,
            log: made.log,
            content: made.content,
            outputSchema: made.outputSchema,
            guard: made.guard,
            drafted: made.drafted,
          }
        : {
            tool: made.tool,
            input: { ...made.input },
            checks: made.outcome.checks.map((entry) => ({ ...entry })),
            effect: { ...made.outcome.effect },
            ask: null,
            reply: null,
            liveEngine: null,
            log: null,
            content: null,
            outputSchema: null,
            guard: null,
            drafted: null,
          };
    const inserted = await this.sql<TestRunRow[]>`
      INSERT INTO agents.own_agent_test_runs
        (agent_id, owner_id, request_id, request_key, kind, tool, input_json, checks_json, effect_json, ask, reply, live_engine, log_json,
         content, output_schema, guard_json, draft_json, created_at)
      VALUES (${agentId}, ${ownerId}, ${requestId}, ${key}, ${made.kind}, ${run.tool}, ${json(run.input)}, ${json(run.checks)},
              ${json(run.effect)}, ${run.ask}, ${run.reply}, ${run.liveEngine}, ${json(run.log ? run.log.map((row) => ({ ...row })) : null)},
              ${run.content}, ${run.outputSchema}, ${json(run.guard)}, ${json(run.drafted)}, clock_timestamp())
      ON CONFLICT (owner_id, request_key) DO NOTHING
      RETURNING ${this.sql.unsafe(TEST_RUN_COLUMNS)}
    `;
    // Another test run under this key committed first: it is this request's, or the key was reused for another.
    if (!inserted[0]) return this.replayed((await this.find(ownerId, key))!, call);
    return testRunView(inserted[0], this.assetId);
  }

  /** The agent's test runs, newest first. */
  async list(ownerId: string, agentId: string, limit: number): Promise<OwnAgentTestRun[]> {
    const rows = await this.sql<TestRunRow[]>`
      SELECT ${this.sql.unsafe(TEST_RUN_COLUMNS)} FROM agents.own_agent_test_runs
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
       ORDER BY created_at DESC, id
       LIMIT ${limit}
    `;
    return rows.map((row) => testRunView(row, this.assetId));
  }

  async count(ownerId: string, agentId: string): Promise<number> {
    const rows = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM agents.own_agent_test_runs WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
    `;
    return rows[0]?.n ?? 0;
  }

  private async find(ownerId: string, key: string): Promise<TestRunRow | null> {
    const rows = await this.sql<TestRunRow[]>`
      SELECT ${this.sql.unsafe(TEST_RUN_COLUMNS)} FROM agents.own_agent_test_runs WHERE owner_id = ${ownerId} AND request_key = ${key}
    `;
    return rows[0] ?? null;
  }

  private replayed(row: TestRunRow, call: Call): OwnAgentTestRun {
    if (!sameCall(row, call)) throw new OwnAgentRefusal('agents.request_id_replay');
    return testRunView(row, this.assetId);
  }
}

/**
 * What the agent holds for the person across its sessions (`sessionAgentId` is `own.<agent id>`): the sessions, every
 * spend reservation on them in any state, and every stored place intent. Read from svc-agents' own tables.
 */
export async function ownAgentHolds(sql: Sql, ownerId: string, sessionAgentId: string): Promise<OwnAgentHolds> {
  const rows = await sql<OwnAgentHolds[]>`
    SELECT
      (SELECT count(*)::int FROM agents.agent_sessions s WHERE s.user_id = ${ownerId} AND s.agent_id = ${sessionAgentId}) AS sessions,
      (SELECT count(*)::int FROM agents.spend_reservations r
         JOIN agents.agent_sessions s ON s.id = r.session_id
        WHERE r.user_id = ${ownerId} AND s.user_id = ${ownerId} AND s.agent_id = ${sessionAgentId}) AS reservations,
      (SELECT count(*)::int FROM agents.agent_place_intents i
         JOIN agents.agent_sessions s ON s.id = i.session_id
        WHERE s.user_id = ${ownerId} AND s.agent_id = ${sessionAgentId}) AS intents
  `;
  return rows[0]!;
}

/**
 * The agent's runs by outcome and their cost. Live runs are the engine runs asked of it (its completions); test runs
 * are added only when `includeTest` is true, and never cost anything, so the cost is the live runs' alone.
 */
export async function ownAgentAnalytics(
  sql: Sql,
  input: { ownerId: string; agentId: string; sessionAgentId: string; includeTest: boolean; assetId: string },
): Promise<OwnAgentAnalytics> {
  const rows = await sql<{ executed: number; refused: number; failed: number; cost: string }[]>`
    SELECT count(*) FILTER (WHERE a.status = 'executed')::int AS executed,
           count(*) FILTER (WHERE a.status = 'refused')::int AS refused,
           count(*) FILTER (WHERE a.status = 'failed')::int AS failed,
           coalesce(sum(a.cost), 0)::text AS cost
      FROM agents.agent_actions a
     WHERE a.user_id = ${input.ownerId} AND a.agent_id = ${input.sessionAgentId} AND a.kind = 'completion'
  `;
  const live = rows[0]!;
  const liveRuns = live.executed + live.refused + live.failed;
  const testRuns = input.includeTest ? await new OwnTestRunStore(sql, input.assetId).count(input.ownerId, input.agentId) : null;
  return {
    includeTest: input.includeTest,
    runs: liveRuns + (testRuns ?? 0),
    liveRuns,
    executed: live.executed,
    refused: live.refused,
    failed: live.failed,
    testRuns,
    cost: formatAmount(parseAmount(live.cost)),
    assetId: input.assetId,
  };
}
