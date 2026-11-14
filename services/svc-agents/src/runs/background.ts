import type { Sql } from 'postgres';
import type { EventBus } from '@intafaced/events';
import { STEP_STATES, type RunNotice, type SessionRun, type SessionRunState, type StopResult } from '@intafaced/contracts/agents-runs';
import { formatAmount, InsufficientFundsError, type Amount } from '@intafaced/ledger-client';
import { AgentError } from '../errors.js';
import type { AgentRuntime } from '../runtime.js';

/**
 * A session's background runs (AG-sessions-04, AG-control-01; J-agents-06). A person starts a run on their own open
 * session and leaves the screen; the run goes on without the page, one step at a time. Each step is one metered engine
 * call on the session's task under the business key `bg:<run id>:<step>`, so a step that is called again after a crash
 * is metered once (the engine refuses the replay and the run fails on it, charging nothing twice).
 *
 * A step is in flight from its start until its call returned and its reply was stored. A running run always has its
 * next step in flight, taking `stepMs` before its call is made. Pausing starts no further step (one in flight finishes);
 * resuming goes on from the stored steps. Stopping lets a call in flight finish and stores it, starts nothing more,
 * settles the session's open usage windows once and keeps that answer, so a second stop returns the first one. No step
 * holds a spend reservation past its own call: the engine reserves and releases inside the call.
 *
 * Every read and change is bounded to the caller's own runs: someone else's run id is not found.
 */

/** The owner's values for background session runs. Each null is blank and refuses a new run. */
export interface SessionRunSettings {
  /** AGENTS_SESSION_RUN_MAX_STEPS: the most steps one background run may be asked to take. */
  readonly maxSteps: number | null;
  /** AGENTS_BACKGROUND_STEP_MS: how long one background step is in flight before its call; the ticker's period. */
  readonly stepMs: number | null;
}

const ENDED: readonly SessionRunState[] = ['completed', 'stopped', 'failed'];

type RunRow = {
  id: string;
  user_id: string;
  session_id: string;
  agent_id: string;
  task: string;
  ask: string;
  follow_ups: string[];
  notice: RunNotice;
  steps_total: number;
  state: SessionRunState;
  failure_code: string | null;
  resumed_at: Date | null;
  stop_result: StopResult | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
};
type StepRow = {
  n: number;
  state: (typeof STEP_STATES)[number];
  reply: string | null;
  cost: string | null;
  started_at: Date;
  finished_at: Date | null;
};

const RUN_COLUMNS =
  'id::text AS id, user_id, session_id::text AS session_id, agent_id, task, ask, follow_ups, notice, steps_total, state, failure_code, resumed_at, stop_result, finished_at, created_at, updated_at';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function view(run: RunRow, steps: StepRow[]): SessionRun {
  const replies = steps.filter((s) => s.reply !== null);
  return {
    runId: run.id,
    sessionId: run.session_id,
    agentId: run.agent_id,
    task: run.task,
    ask: run.ask,
    followUps: run.follow_ups,
    notice: run.notice,
    state: run.state,
    stepsTotal: run.steps_total,
    failureCode: run.failure_code,
    resumedAt: iso(run.resumed_at),
    finishedAt: iso(run.finished_at),
    reply: replies.at(-1)?.reply ?? null,
    steps: steps.map((s) => ({
      n: s.n,
      state: s.state,
      reply: s.reply,
      cost: s.cost,
      startedAt: s.started_at.toISOString(),
      finishedAt: iso(s.finished_at),
    })),
    stop: run.stop_result,
    createdAt: run.created_at.toISOString(),
    updatedAt: run.updated_at.toISOString(),
  };
}

/** A change the run's state does not allow, by its own typed code. */
export class SessionRunConflict extends Error {
  constructor(readonly code: 'agents.run.paused' | 'agents.run.ended' | 'agents.session_run_steps_over') {
    super(code);
    this.name = 'SessionRunConflict';
  }
}

/** The business key of one step's engine call: the same step is metered once, however often it is called. */
export const stepRequestId = (runId: string, n: number) => `bg:${runId}:${n}`;

/**
 * The messages a step sends: the ask and every follow-up, then each stored reply in turn with the step that comes next.
 * A resumed run rebuilds them from the stored steps, so it goes on from where it stopped and never runs a step again.
 */
export function stepMessages(run: Pick<RunRow, 'ask' | 'follow_ups' | 'steps_total'>, done: readonly { reply: string | null }[]) {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [
    { role: 'user', content: [run.ask, ...run.follow_ups].join('\n\n') },
  ];
  done.forEach((step, i) => {
    if (step.reply === null) return;
    messages.push({ role: 'assistant', content: step.reply });
    messages.push({ role: 'user', content: `Go on with step ${i + 2} of ${run.steps_total}.` });
  });
  return messages;
}

async function lockRun(tx: Sql, runId: string, userId: string | null, skipLocked = false): Promise<RunRow | null> {
  const rows = await tx<RunRow[]>`
    SELECT ${tx.unsafe(RUN_COLUMNS)} FROM agents.session_background_runs
     WHERE id = ${runId} ${userId === null ? tx`` : tx`AND user_id = ${userId}`}
     FOR UPDATE ${skipLocked ? tx`SKIP LOCKED` : tx``}
  `;
  return rows[0] ?? null;
}

async function stepsOf(tx: Sql, runId: string): Promise<StepRow[]> {
  return tx<StepRow[]>`
    SELECT n, state, reply, cost, started_at, finished_at FROM agents.session_background_run_steps
     WHERE run_id = ${runId} ORDER BY n
  `;
}

/**
 * Makes the in-flight step's call and stores what it returned, as `done` (or `done_after_stop` when the person stopped
 * the run meanwhile). A refused call stores the step as `refused` and fails the run on its code. Called under the run's
 * row lock, so the ticker and a stop never make the same call twice.
 */
async function finishStep(tx: Sql, runtime: AgentRuntime, run: RunRow, steps: StepRow[], afterStop: boolean): Promise<'done' | 'refused'> {
  const step = steps.at(-1)!;
  try {
    const result = await runtime.think({
      sessionId: run.session_id,
      requestId: stepRequestId(run.id, step.n),
      task: run.task,
      messages: stepMessages(run, steps.slice(0, -1)),
    });
    await tx`
      UPDATE agents.session_background_run_steps
         SET state = ${afterStop ? 'done_after_stop' : 'done'}, reply = ${result.text}, cost = ${formatAmount(result.cost)},
             finished_at = now()
       WHERE run_id = ${run.id} AND n = ${step.n}
    `;
    return 'done';
  } catch (err) {
    const code = err instanceof AgentError ? err.code : 'agents.provider_failed';
    await tx`
      UPDATE agents.session_background_run_steps SET state = 'refused', finished_at = now()
       WHERE run_id = ${run.id} AND n = ${step.n}
    `;
    if (!afterStop) {
      await tx`
        UPDATE agents.session_background_runs SET state = 'failed', failure_code = ${code}, finished_at = now(), updated_at = now()
         WHERE id = ${run.id}
      `;
    }
    return 'refused';
  }
}

export class SessionRunStore {
  constructor(
    private readonly sql: Sql,
    private readonly runtime: AgentRuntime,
    private readonly feeAssetId: string,
  ) {}

  /** Starts one run on the caller's session; the same request key again is that run. */
  async start(input: {
    userId: string;
    sessionId: string;
    agentId: string;
    requestKey: string;
    task: string;
    ask: string;
    notice: RunNotice;
    steps: number;
  }): Promise<SessionRun> {
    const inserted = await this.sql<{ id: string }[]>`
      INSERT INTO agents.session_background_runs (user_id, session_id, agent_id, request_key, task, ask, notice, steps_total)
      VALUES (${input.userId}, ${input.sessionId}, ${input.agentId}, ${input.requestKey}, ${input.task}, ${input.ask},
              ${input.notice}, ${input.steps})
      ON CONFLICT (user_id, request_key) DO NOTHING
      RETURNING id::text AS id
    `;
    const id =
      inserted[0]?.id ??
      (
        await this.sql<{ id: string }[]>`
          SELECT id::text AS id FROM agents.session_background_runs
           WHERE user_id = ${input.userId} AND request_key = ${input.requestKey} AND session_id = ${input.sessionId}
        `
      )[0]?.id;
    // The same key on another session is another request reusing it: refused, never answered with the first run.
    if (!id) throw new AgentError('background run request key reused', 'agents.request_id_replay', 'agents.error.request_id_replay');
    return (await this.get(id, input.userId))!;
  }

  /** One of the caller's runs with its steps, or null for a run that is not theirs. */
  async get(runId: string, userId: string): Promise<SessionRun | null> {
    const [run] = await this.sql<RunRow[]>`
      SELECT ${this.sql.unsafe(RUN_COLUMNS)} FROM agents.session_background_runs WHERE id = ${runId} AND user_id = ${userId}
    `;
    if (!run) return null;
    return view(run, await stepsOf(this.sql, runId));
  }

  /** Takes no further step; a step in flight finishes. Pausing a paused run is that run. */
  async pause(runId: string, userId: string): Promise<SessionRun | null> {
    return this.change(runId, userId, async (tx, run) => {
      if (run.state === 'paused') return;
      await tx`UPDATE agents.session_background_runs SET state = 'paused', updated_at = now() WHERE id = ${run.id}`;
    });
  }

  /** Goes on from the stored steps. Resuming a running run is that run. */
  async resume(runId: string, userId: string): Promise<SessionRun | null> {
    return this.change(runId, userId, async (tx, run) => {
      if (run.state !== 'paused') return;
      await tx`
        UPDATE agents.session_background_runs SET state = 'running', resumed_at = now(), updated_at = now() WHERE id = ${run.id}
      `;
    });
  }

  /** One more request to a running run: one more step, with the follow-up in its messages. Refused while paused, and
   * past the most steps allowed. */
  async askMore(runId: string, userId: string, text: string, maxSteps: number): Promise<SessionRun | null> {
    return this.change(runId, userId, async (tx, run) => {
      if (run.state === 'paused') throw new SessionRunConflict('agents.run.paused');
      // A follow-up is one more step, and the run never grows past the most steps the owner allows.
      if (run.steps_total + 1 > maxSteps) throw new SessionRunConflict('agents.session_run_steps_over');
      await tx`
        UPDATE agents.session_background_runs
           SET follow_ups = follow_ups || ${tx.json([text])}::jsonb, steps_total = steps_total + 1, updated_at = now()
         WHERE id = ${run.id}
      `;
    });
  }

  /**
   * Stops the run: a call in flight finishes and is stored, nothing further runs, and the session's open windows are
   * settled once. The answer is kept: a second stop returns it and settles nothing again (`repeated`).
   */
  async stop(runId: string, userId: string): Promise<{ run: SessionRun; repeated: boolean } | null> {
    const outcome = await this.sql.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      const run = await lockRun(tx, runId, userId);
      if (!run) return null;
      if (run.stop_result) return { repeated: true };
      if (ENDED.includes(run.state)) throw new SessionRunConflict('agents.run.ended');
      await tx`UPDATE agents.session_background_runs SET state = 'stopped', updated_at = now() WHERE id = ${run.id}`;
      const steps = await stepsOf(tx, run.id);
      if (steps.at(-1)?.state === 'in_flight') await finishStep(tx, this.runtime, run, steps, true);
      const result = await this.settle(run.session_id);
      await tx`
        UPDATE agents.session_background_runs SET stop_result = ${tx.json(result)}, finished_at = now(), updated_at = now()
         WHERE id = ${run.id}
      `;
      return { repeated: false };
    });
    if (!outcome) return null;
    return { run: (await this.get(runId, userId))!, repeated: outcome.repeated };
  }

  /**
   * Settles the session's open windows one by one. A window the ledger refuses for funds stays sealed and unpaid and is
   * named; the windows paid before it are kept in the answer, so what was billed is never under-reported.
   */
  private async settle(sessionId: string): Promise<StopResult> {
    const stoppedAt = new Date().toISOString();
    const settlements: StopResult['settlements'] = [];
    let billed: Amount = 0n;
    let unpaid: string | null = null;
    for (const windowId of await this.runtime.openWindowIds(sessionId)) {
      try {
        const r = await this.runtime.settleWindow(sessionId, windowId);
        billed += r.amount;
        settlements.push({ windowId: r.windowId, amount: formatAmount(r.amount), chargeKey: r.chargeKey, settled: r.settled });
      } catch (err) {
        if (!(err instanceof InsufficientFundsError)) throw err;
        unpaid = 'agents.window_unpaid';
        break;
      }
    }
    return { stoppedAt, billed: formatAmount(billed), assetId: this.feeAssetId, settlements, unpaid };
  }

  private async change(runId: string, userId: string, fn: (tx: Sql, run: RunRow) => Promise<void>): Promise<SessionRun | null> {
    const found = await this.sql.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      const run = await lockRun(tx, runId, userId);
      if (!run) return false;
      if (ENDED.includes(run.state)) throw new SessionRunConflict('agents.run.ended');
      await fn(tx, run);
      return true;
    });
    return found ? this.get(runId, userId) : null;
  }
}

/**
 * One pass over every live run: a step in flight whose time is up makes its call and is stored; a running run then
 * starts its next step, or completes after its last. A paused run starts nothing. A run another ticker holds is skipped,
 * so two instances never make the same call. Returns how many runs it touched.
 */
export async function advanceSessionRuns(sql: Sql, runtime: AgentRuntime, stepMs: number, batch = 50): Promise<number> {
  const live = await sql<{ id: string }[]>`
    SELECT id::text AS id FROM agents.session_background_runs
     WHERE state IN ('queued', 'running', 'paused')
     ORDER BY updated_at
     LIMIT ${batch}
  `;
  let touched = 0;
  for (const { id } of live) {
    const moved = await sql.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      const run = await lockRun(tx, id, null, true);
      if (!run || ENDED.includes(run.state)) return false;
      const steps = await stepsOf(tx, id);
      const last = steps.at(-1);
      if (last?.state === 'in_flight') {
        if (Date.now() - last.started_at.getTime() < stepMs) return false;
        if ((await finishStep(tx, runtime, run, steps, false)) === 'refused') return true;
      }
      if (run.state === 'paused') return last?.state === 'in_flight';
      const taken = last ? last.n : 0;
      if (taken >= run.steps_total) {
        await tx`
          UPDATE agents.session_background_runs SET state = 'completed', finished_at = now(), updated_at = now() WHERE id = ${id}
        `;
        return true;
      }
      await tx`INSERT INTO agents.session_background_run_steps (run_id, n) VALUES (${id}, ${taken + 1})`;
      await tx`UPDATE agents.session_background_runs SET state = 'running', updated_at = now() WHERE id = ${id}`;
      return true;
    });
    if (moved) touched++;
  }
  return touched;
}

/**
 * Publishes the finish notice of every completed run not yet announced, on the run id, then marks it. A crash between
 * the publish and the mark publishes it again on the next pass under the same key; svc-notify writes one row per key.
 */
export async function publishCompletedRuns(sql: Sql, bus: EventBus, batch = 100): Promise<number> {
  const rows = await sql<{ id: string; user_id: string; session_id: string; agent_id: string; notice: RunNotice; finished_at: Date }[]>`
    SELECT id::text AS id, user_id, session_id::text AS session_id, agent_id, notice, finished_at
      FROM agents.session_background_runs
     WHERE state = 'completed' AND notice_published_at IS NULL
     ORDER BY finished_at
     LIMIT ${batch}
  `;
  for (const row of rows) {
    await bus.publish(
      'agentRunCompleted',
      {
        runId: row.id,
        userId: row.user_id,
        sessionId: row.session_id,
        agentId: row.agent_id,
        notice: row.notice,
        finishedAt: row.finished_at.toISOString(),
      },
      { idempotencyKey: `agents.run.completed:${row.id}` },
    );
    await sql`UPDATE agents.session_background_runs SET notice_published_at = now() WHERE id = ${row.id}`;
  }
  return rows.length;
}
