import type { Sql } from 'postgres';
import {
  OWN_AGENT_EVAL_LIMITS,
  type OwnAgentEvalCase,
  type OwnAgentEvalResult,
  type OwnAgentEvalRun,
  type OwnAgentEvalRunSummary,
} from '@intafaced/contracts';
import { OwnAgentRefusal } from './catalog.js';

/**
 * Evaluations of a person's own agent (AG-testing-02; J-agents-04 #5 to #7). The test set is the agent's cases, each an
 * input and the answer expected. An evaluation runs every case `repeats` times on the test engine and labels every result
 * TEST: the engine is deterministic, calls no model, is never billed and makes no ledger call, reservation or intent.
 * A result passes when its reply contains the expected answer, exactly as typed; the score is the share that passed, and
 * the run passes when that share is at least the person's threshold. A blank threshold or repeats count is refused with
 * its name and nothing runs or is stored. One run per `agents:eval:<agent>:<request id>`: the same request again is
 * that run, never a second one.
 */

const NUL = /\u0000/;

/** The test engine's reply to one case: fixed, from the input alone, so every repeat answers alike and is never billed. */
export const testEngineReply = (input: string): string => `TEST reply: ${input}`;

/** The comparison a result is judged by: the reply contains the expected answer, exactly as typed. */
export const replyPasses = (reply: string, expected: string): boolean => reply.includes(expected);

export type EvalRequest = {
  readonly cases: readonly OwnAgentEvalCase[];
  readonly repeats: number;
  /** The threshold in hundredths of a percent (50 percent is 5000). */
  readonly thresholdHundredths: number;
  /** The threshold as stored and shown: canonical, no trailing zeros. */
  readonly threshold: string;
};

const REPEATS_RE = /^[0-9]{1,3}$/;
const THRESHOLD_RE = /^([0-9]{1,3})(?:\.([0-9]{1,2}))?$/;

/**
 * Checks a start as the person typed it; refuses the first thing it cannot run, with its name. A blank threshold or
 * repeats count stays blank and refuses: no default stands in for either.
 */
export function checkEvalRequest(input: { cases: readonly OwnAgentEvalCase[]; repeats: string; threshold: string }): EvalRequest {
  if (input.cases.length === 0) throw new OwnAgentRefusal('agents.eval.cases_empty');
  if (input.cases.length > OWN_AGENT_EVAL_LIMITS.cases) {
    throw new OwnAgentRefusal('agents.eval.too_many_cases', { limit: String(OWN_AGENT_EVAL_LIMITS.cases) });
  }
  // Stored and judged exactly as typed; only a case with nothing but spaces in it is blank.
  const cases = input.cases.map((entry) => ({ input: entry.input, expected: entry.expected }));
  for (const entry of cases) {
    if (NUL.test(entry.input) || NUL.test(entry.expected)) throw new OwnAgentRefusal('agents.own.text_invalid');
    if (!entry.input.trim() || !entry.expected.trim()) throw new OwnAgentRefusal('agents.eval.case_blank');
    if (entry.input.length > OWN_AGENT_EVAL_LIMITS.text || entry.expected.length > OWN_AGENT_EVAL_LIMITS.text) {
      throw new OwnAgentRefusal('agents.eval.case_too_long', { limit: String(OWN_AGENT_EVAL_LIMITS.text) });
    }
  }
  const repeatsText = input.repeats.trim();
  if (!repeatsText) throw new OwnAgentRefusal('agents.eval.repeats_unset');
  const repeats = REPEATS_RE.test(repeatsText) ? Number(repeatsText) : NaN;
  if (!(repeats >= 1 && repeats <= OWN_AGENT_EVAL_LIMITS.repeats)) {
    throw new OwnAgentRefusal('agents.eval.repeats_invalid', { limit: String(OWN_AGENT_EVAL_LIMITS.repeats) });
  }
  const thresholdText = input.threshold.trim().replace(/%$/, '').trim();
  if (!thresholdText) throw new OwnAgentRefusal('agents.eval.threshold_unset');
  const match = THRESHOLD_RE.exec(thresholdText);
  // A percent with at most two decimals, as whole hundredths: "50" is 5000, "66.5" is 6650, "66.66" is 6666.
  const fraction = match?.[2] ?? '';
  const thresholdHundredths = match ? Number(match[1]) * 100 + Number(fraction || '0') * (fraction.length === 1 ? 10 : 1) : NaN;
  if (!(thresholdHundredths >= 0 && thresholdHundredths <= 10_000)) throw new OwnAgentRefusal('agents.eval.threshold_invalid');
  return { cases, repeats, thresholdHundredths, threshold: percent(thresholdHundredths) };
}

/** Hundredths of a percent as a decimal string with no trailing zeros: 5000 is "50", 6666 is "66.66". */
function percent(hundredths: number): string {
  const whole = Math.trunc(hundredths / 100);
  const part = String(hundredths % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return part ? `${whole}.${part}` : String(whole);
}

/** Every case on every repeat, through the test engine, judged by the comparison. */
export function evaluate(request: EvalRequest): {
  results: OwnAgentEvalResult[];
  passed: number;
  total: number;
  score: string;
  verdict: 'pass' | 'fail';
} {
  const results: OwnAgentEvalResult[] = [];
  request.cases.forEach((entry, caseIndex) => {
    for (let repeat = 1; repeat <= request.repeats; repeat += 1) {
      const reply = testEngineReply(entry.input);
      results.push({
        caseIndex,
        repeat,
        input: entry.input,
        expected: entry.expected,
        reply,
        passed: replyPasses(reply, entry.expected),
        label: 'TEST',
      });
    }
  });
  const total = results.length;
  const passed = results.filter((result) => result.passed).length;
  // The verdict compares the exact share; the score shown is cut to two places, never rounded up past the threshold.
  const verdict = passed * 10_000 >= request.thresholdHundredths * total ? 'pass' : 'fail';
  return { results, passed, total, score: percent(Math.floor((passed * 10_000) / total)), verdict };
}

type SummaryRow = Omit<RunRow, 'cases_json' | 'results_json'> & { cases: number };

interface RunRow {
  id: string;
  request_id: string;
  cases_json: OwnAgentEvalCase[];
  repeats: number;
  threshold: string;
  passed: number;
  total: number;
  score: string;
  verdict: 'pass' | 'fail';
  results_json: OwnAgentEvalResult[];
  created_at: Date;
}

const summaryView = (row: SummaryRow): OwnAgentEvalRunSummary => ({
  id: row.id,
  requestId: row.request_id,
  cases: row.cases,
  repeats: row.repeats,
  threshold: row.threshold,
  passed: row.passed,
  total: row.total,
  score: row.score,
  verdict: row.verdict,
  label: 'TEST',
  createdAt: row.created_at.toISOString(),
});

const runView = (row: RunRow): OwnAgentEvalRun => ({
  id: row.id,
  requestId: row.request_id,
  cases: row.cases_json,
  repeats: row.repeats,
  threshold: row.threshold,
  passed: row.passed,
  total: row.total,
  score: row.score,
  verdict: row.verdict,
  label: 'TEST',
  results: row.results_json,
  createdAt: row.created_at.toISOString(),
});

/** The stored run is this request: the same cases in the same order, the same repeats and the same threshold. */
const sameRequest = (row: RunRow, request: EvalRequest): boolean =>
  row.repeats === request.repeats &&
  row.threshold === request.threshold &&
  JSON.stringify(row.cases_json.map((entry) => [entry.input, entry.expected])) ===
    JSON.stringify(request.cases.map((entry) => [entry.input, entry.expected]));

const RUN_COLUMNS = 'id, request_id, cases_json, repeats, threshold, passed, total, score, verdict, results_json, created_at';

/** An own agent's test set and evaluation runs. Nothing here is a balance and no value moves. */
export class OwnEvalStore {
  constructor(private readonly sql: Sql) {}

  /** The agent's test set, in the order the person wrote it; empty until a run saves one. */
  async testSet(ownerId: string, agentId: string): Promise<OwnAgentEvalCase[]> {
    const rows = await this.sql<{ input: string; expected: string }[]>`
      SELECT input, expected FROM agents.own_agent_eval_cases
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
       ORDER BY position
    `;
    return rows.map((row) => ({ input: row.input, expected: row.expected }));
  }

  /** The agent's runs, newest first, without their cases or results: a count of cases is all the list shows. */
  async runs(ownerId: string, agentId: string, limit: number): Promise<OwnAgentEvalRunSummary[]> {
    const rows = await this.sql<SummaryRow[]>`
      SELECT id, request_id, jsonb_array_length(cases_json)::int AS cases, repeats, threshold, passed, total, score, verdict, created_at
        FROM agents.own_agent_eval_runs
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
       ORDER BY created_at DESC, id
       LIMIT ${limit}
    `;
    return rows.map(summaryView);
  }

  /** The agent's newest run in full, with its cases and every result, or null before the first. */
  async latest(ownerId: string, agentId: string): Promise<OwnAgentEvalRun | null> {
    const rows = await this.sql<RunRow[]>`
      SELECT ${this.sql.unsafe(RUN_COLUMNS)} FROM agents.own_agent_eval_runs
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
       ORDER BY created_at DESC, id
       LIMIT 1
    `;
    return rows[0] ? runView(rows[0]) : null;
  }

  /**
   * Runs and stores one evaluation, and saves its cases as the agent's test set, in one transaction. The same request id
   * again returns the run it made, untouched; with another request it refuses `agents.request_id_replay`.
   */
  async start(ownerId: string, agentId: string, requestId: string, request: EvalRequest): Promise<OwnAgentEvalRun> {
    const key = `agents:eval:${agentId}:${requestId}`;
    const stored = await this.find(ownerId, key);
    if (stored) return this.replayed(stored, request);
    const outcome = evaluate(request);
    return this.sql.begin(async (tx) => {
      // One start of this agent at a time: the test set it replaces is the agent's, so two starts never interleave. The
      // run is stamped with the clock after the lock, not the transaction's start, so the newest run is the one whose
      // cases are the test set.
      await tx`SELECT id FROM agents.own_agents WHERE id = ${agentId} AND owner_id = ${ownerId} FOR UPDATE`;
      const inserted = await tx<RunRow[]>`
        INSERT INTO agents.own_agent_eval_runs
          (agent_id, owner_id, request_id, request_key, cases_json, repeats, threshold, passed, total, score, verdict, results_json,
           created_at)
        VALUES (${agentId}, ${ownerId}, ${requestId}, ${key}, ${tx.json(request.cases.map((entry) => ({ ...entry })))},
                ${request.repeats}, ${request.threshold}, ${outcome.passed}, ${outcome.total}, ${outcome.score}, ${outcome.verdict},
                ${tx.json(outcome.results.map((result) => ({ ...result })))},
                clock_timestamp())
        ON CONFLICT (owner_id, request_key) DO NOTHING
        RETURNING ${tx.unsafe(RUN_COLUMNS)}
      `;
      // Another start with this key committed first: that run is this request's, or the key was reused for another.
      if (!inserted[0]) {
        const raced = await tx<RunRow[]>`
          SELECT ${tx.unsafe(RUN_COLUMNS)} FROM agents.own_agent_eval_runs WHERE owner_id = ${ownerId} AND request_key = ${key}
        `;
        return this.replayed(raced[0]!, request);
      }
      await tx`DELETE FROM agents.own_agent_eval_cases WHERE owner_id = ${ownerId} AND agent_id = ${agentId}`;
      for (const [position, entry] of request.cases.entries()) {
        await tx`
          INSERT INTO agents.own_agent_eval_cases (agent_id, owner_id, position, input, expected)
          VALUES (${agentId}, ${ownerId}, ${position}, ${entry.input}, ${entry.expected})
        `;
      }
      return runView(inserted[0]);
    });
  }

  private async find(ownerId: string, key: string): Promise<RunRow | null> {
    const rows = await this.sql<RunRow[]>`
      SELECT ${this.sql.unsafe(RUN_COLUMNS)} FROM agents.own_agent_eval_runs WHERE owner_id = ${ownerId} AND request_key = ${key}
    `;
    return rows[0] ?? null;
  }

  private replayed(row: RunRow, request: EvalRequest): OwnAgentEvalRun {
    if (!sameRequest(row, request)) throw new OwnAgentRefusal('agents.request_id_replay');
    return runView(row);
  }
}
