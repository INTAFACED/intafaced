import type { Sql } from 'postgres';
import type {
  OwnAgentAnalytics,
  OwnAgentDryRunCheck,
  OwnAgentDryRunEffect,
  OwnAgentHolds,
  OwnAgentTestRun,
} from '@intafaced/contracts/agents-own';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { OWN_TOOL_DOORS, OWN_TOOLS, OwnAgentRefusal } from './catalog.js';
import { OwnConsentStore, OwnRuleStore, stricter, type PolicyBaseline, type RuleChoice } from './guardrails.js';
import { readOwnCaps } from './limits.js';

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

interface TestRunRow {
  id: string;
  request_id: string;
  kind: 'dry_run';
  tool: string;
  input_json: Record<string, string>;
  checks_json: OwnAgentDryRunCheck[];
  effect_json: OwnAgentDryRunEffect;
  created_at: Date;
}
const TEST_RUN_COLUMNS = 'id, request_id, kind, tool, input_json, checks_json, effect_json, created_at';

const testRunView = (row: TestRunRow, assetId: string): OwnAgentTestRun => ({
  id: row.id,
  requestId: row.request_id,
  kind: row.kind,
  tool: row.tool,
  input: row.input_json,
  checks: row.checks_json,
  effect: row.effect_json,
  cost: '0',
  assetId,
  label: 'TEST',
  createdAt: row.created_at.toISOString(),
});

/** The same tool and the same input, whatever order the fields came in. */
const sameCall = (row: TestRunRow, tool: string, input: Readonly<Record<string, string>>): boolean => {
  const sorted = (args: Readonly<Record<string, string>>) => JSON.stringify(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)));
  return row.tool === tool && sorted(row.input_json) === sorted(input);
};

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
    const key = `agents:test-run:${agentId}:${requestId}`;
    const stored = await this.find(ownerId, key);
    if (stored) return this.replayed(stored, call);
    const outcome = await check();
    const inserted = await this.sql<TestRunRow[]>`
      INSERT INTO agents.own_agent_test_runs
        (agent_id, owner_id, request_id, request_key, kind, tool, input_json, checks_json, effect_json, created_at)
      VALUES (${agentId}, ${ownerId}, ${requestId}, ${key}, 'dry_run', ${call.tool}, ${this.sql.json({ ...call.input })},
              ${this.sql.json(outcome.checks.map((entry) => ({ ...entry })))}, ${this.sql.json({ ...outcome.effect })}, clock_timestamp())
      ON CONFLICT (owner_id, request_key) DO NOTHING
      RETURNING ${this.sql.unsafe(TEST_RUN_COLUMNS)}
    `;
    // Another dry run under this key committed first: it is this request's, or the key was reused for another call.
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

  private replayed(row: TestRunRow, call: { tool: string; input: Readonly<Record<string, string>> }): OwnAgentTestRun {
    if (!sameCall(row, call.tool, call.input)) throw new OwnAgentRefusal('agents.request_id_replay');
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
