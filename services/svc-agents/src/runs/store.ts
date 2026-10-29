import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { assertMove, type RunState } from './machine.js';

/**
 * The run entity on Postgres (AG-sessions-01, ENGINE RS-1 to RS-4). `admit` writes the run row and its first event in
 * their own transaction before anything runs; `move` changes state only along RS-2 and appends one event per change.
 * Reads are always bounded to the caller's own runs: someone else's run reads as not found.
 */

export interface StoredRun {
  readonly id: string;
  readonly runKey: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly agentId: string;
  readonly task: string | null;
  readonly state: RunState;
  readonly reply: string | null;
  /** The metered cost as a decimal string, set when the run completes; null before. */
  readonly cost: string | null;
  readonly assetId: string | null;
  readonly metered: boolean | null;
  readonly actionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunEvent {
  readonly sequence: number;
  readonly state: RunState;
  readonly code: string | null;
  readonly occurredAt: string;
}

export interface RunOutcome {
  readonly reply?: string;
  readonly cost?: Amount;
  readonly assetId?: string;
  readonly metered?: boolean;
  readonly actionId?: string;
  /** The typed code a refusal or a failure ended on. */
  readonly code?: string;
}

/** The business key of one run: the caller's own request id on its session. */
export const runKeyOf = (sessionId: string, requestId: string) => `agents:run:${sessionId}:${requestId}`;

interface RunRow {
  id: string;
  run_key: string;
  user_id: string;
  session_id: string;
  request_id: string;
  agent_id: string;
  task: string | null;
  state: RunState;
  reply: string | null;
  cost: string | null;
  asset_id: string | null;
  metered: boolean | null;
  action_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const toRun = (row: RunRow): StoredRun => ({
  id: row.id,
  runKey: row.run_key,
  userId: row.user_id,
  sessionId: row.session_id,
  requestId: row.request_id,
  agentId: row.agent_id,
  task: row.task,
  state: row.state,
  reply: row.reply,
  cost: row.cost === null ? null : formatAmount(parseAmount(row.cost)),
  assetId: row.asset_id,
  metered: row.metered,
  actionId: row.action_id,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export interface RunStore {
  admit(input: {
    userId: string;
    sessionId: string;
    requestId: string;
    agentId: string;
    task: string | null;
  }): Promise<{ run: StoredRun; admitted: boolean }>;
  move(runId: string, to: RunState, outcome?: RunOutcome): Promise<StoredRun>;
  takeOver(runId: string, staleBefore: Date): Promise<StoredRun | null>;
  get(runId: string, userId: string): Promise<{ run: StoredRun; refusalCodes: string[] } | null>;
  events(runId: string, userId: string, after: number, limit: number): Promise<RunEvent[] | null>;
  forSession(sessionId: string): Promise<StoredRun[]>;
}

export function createRunStore(sql: Sql): RunStore {
  return {
    /**
     * Writes the run before anything runs. A repeat of the same request id on the session returns the stored run with
     * `admitted: false` and writes nothing.
     */
    async admit(input: {
      userId: string;
      sessionId: string;
      requestId: string;
      agentId: string;
      task: string | null;
    }): Promise<{ run: StoredRun; admitted: boolean }> {
      const runKey = runKeyOf(input.sessionId, input.requestId);
      return sql.begin(async (tx) => {
        const [inserted] = await tx<RunRow[]>`
          INSERT INTO agents.agent_runs (run_key, user_id, session_id, request_id, agent_id, task, state)
          VALUES (${runKey}, ${input.userId}, ${input.sessionId}, ${input.requestId}, ${input.agentId}, ${input.task}, 'admitted')
          ON CONFLICT (run_key) DO NOTHING
          RETURNING id, run_key, user_id, session_id, request_id, agent_id, task, state, reply, cost::text, asset_id,
                    metered, action_id, created_at, updated_at
        `;
        if (inserted) {
          await tx`INSERT INTO agents.agent_run_events (run_id, sequence, state) VALUES (${inserted.id}, 1, 'admitted')`;
          return { run: toRun(inserted), admitted: true };
        }
        const [stored] = await tx<RunRow[]>`
          SELECT id, run_key, user_id, session_id, request_id, agent_id, task, state, reply, cost::text, asset_id,
                 metered, action_id, created_at, updated_at
            FROM agents.agent_runs WHERE run_key = ${runKey}
        `;
        if (!stored) throw new Error(`agents run ${runKey} conflicted but is not stored`);
        return { run: toRun(stored), admitted: false };
      });
    },

    /**
     * Moves a run to `to` along RS-2 and appends its event, under a row lock so two movers never interleave. A move
     * RS-2 does not allow throws `agents.run_transition_invalid` and changes nothing.
     */
    async move(runId: string, to: RunState, outcome: RunOutcome = {}): Promise<StoredRun> {
      return sql.begin(async (tx) => {
        const [current] = await tx<Array<{ state: RunState }>>`
          SELECT state FROM agents.agent_runs WHERE id = ${runId} FOR UPDATE
        `;
        if (!current) throw new Error(`agents run ${runId} is not stored`);
        assertMove(current.state, to);
        const [row] = await tx<RunRow[]>`
          UPDATE agents.agent_runs
             SET state = ${to},
                 reply = ${to === 'completed' ? (outcome.reply ?? '') : null},
                 cost = COALESCE(${outcome.cost === undefined ? null : formatAmount(outcome.cost)}::numeric, cost),
                 asset_id = COALESCE(${outcome.assetId ?? null}, asset_id),
                 metered = COALESCE(${outcome.metered ?? null}::boolean, metered),
                 action_id = COALESCE(${outcome.actionId ?? null}::uuid, action_id),
                 updated_at = now()
           WHERE id = ${runId}
          RETURNING id, run_key, user_id, session_id, request_id, agent_id, task, state, reply, cost::text, asset_id,
                    metered, action_id, created_at, updated_at
        `;
        await tx`
          INSERT INTO agents.agent_run_events (run_id, sequence, state, code)
          SELECT ${runId}, COALESCE(MAX(sequence), 0) + 1, ${to}, ${outcome.code ?? null}
            FROM agents.agent_run_events WHERE run_id = ${runId}
        `;
        return toRun(row!);
      });
    },

    /**
     * Takes over a `running` run whose last change is older than `staleBefore`, renewing its lease; null when it is
     * live, moved on, or another retry took it first. A lease renewal is not a state change, so it appends no event.
     */
    async takeOver(runId: string, staleBefore: Date): Promise<StoredRun | null> {
      const [row] = await sql<RunRow[]>`
        UPDATE agents.agent_runs SET updated_at = now()
         WHERE id = ${runId} AND state = 'running' AND updated_at < ${staleBefore}
        RETURNING id, run_key, user_id, session_id, request_id, agent_id, task, state, reply, cost::text, asset_id,
                  metered, action_id, created_at, updated_at
      `;
      return row ? toRun(row) : null;
    },

    /** One of the caller's own runs, with the code of every refusal it met in order; null for none or someone else's. */
    async get(runId: string, userId: string): Promise<{ run: StoredRun; refusalCodes: string[] } | null> {
      const [row] = await sql<RunRow[]>`
        SELECT id, run_key, user_id, session_id, request_id, agent_id, task, state, reply, cost::text, asset_id,
               metered, action_id, created_at, updated_at
          FROM agents.agent_runs WHERE id = ${runId} AND user_id = ${userId}
      `;
      if (!row) return null;
      const codes = await sql<Array<{ code: string }>>`
        SELECT code FROM agents.agent_run_events
         WHERE run_id = ${runId} AND state = 'refused' AND code IS NOT NULL ORDER BY sequence
      `;
      return { run: toRun(row), refusalCodes: codes.map((c) => c.code) };
    },

    /** The caller's run events after `after`, oldest first; null when the run is not theirs. */
    async events(runId: string, userId: string, after: number, limit: number): Promise<RunEvent[] | null> {
      const [owned] = await sql<Array<{ id: string }>>`
        SELECT id FROM agents.agent_runs WHERE id = ${runId} AND user_id = ${userId}
      `;
      if (!owned) return null;
      const rows = await sql<Array<{ sequence: number; state: RunState; code: string | null; occurred_at: Date }>>`
        SELECT sequence, state, code, occurred_at FROM agents.agent_run_events
         WHERE run_id = ${runId} AND sequence > ${after}
         ORDER BY sequence LIMIT ${limit}
      `;
      return rows.map((r) => ({
        sequence: r.sequence,
        state: r.state,
        code: r.code,
        occurredAt: r.occurred_at.toISOString(),
      }));
    },

    /** Every run of one session, oldest first. The caller has already proved the session is theirs. */
    async forSession(sessionId: string): Promise<StoredRun[]> {
      const rows = await sql<RunRow[]>`
        SELECT id, run_key, user_id, session_id, request_id, agent_id, task, state, reply, cost::text, asset_id,
               metered, action_id, created_at, updated_at
          FROM agents.agent_runs WHERE session_id = ${sessionId} ORDER BY created_at, id
      `;
      return rows.map(toRun);
    },
  };
}
