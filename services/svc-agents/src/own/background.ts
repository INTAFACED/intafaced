import type { Sql } from 'postgres';
import { z } from 'zod';
import { transaction } from '@intafaced/db';
import { ownAgentSwitch } from '../fleet/control.js';

/**
 * A test run of a person's own agent that goes on in the background, one step at a time (AG-control-02, ENGINE KS-4).
 * Before each step the run re-reads the agent's switches: a quarantine or a kind kill set while it runs stops it at that
 * step, as `stopped` with `agents.agent.quarantined` (or `agents.agent.disabled_by_kind`), and it never takes another.
 * It runs on the test engine: mode test, cost 0, labelled TEST, with no session, reservation, usage row or ledger call.
 */

/** The owner's values for background test runs. Each null is blank and refuses a new run. */
export interface BackgroundSettings {
  /** AGENTS_BACKGROUND_TEST_STEPS: how many steps one background test run takes. */
  readonly steps: number | null;
  /** AGENTS_BACKGROUND_STEP_MS: how long one step takes; the ticker's period. */
  readonly stepMs: number | null;
}

export const BACKGROUND_STATES = ['running', 'done', 'stopped'] as const;
export const ownBackgroundRunSchema = z.object({
  id: z.string().uuid(),
  ask: z.string(),
  state: z.enum(BACKGROUND_STATES),
  stepsDone: z.number().int(),
  stepsTotal: z.number().int(),
  stopCode: z.string().nullable(),
  mode: z.literal('test'),
  cost: z.literal('0'),
  label: z.literal('TEST'),
  startedAt: z.string(),
  updatedAt: z.string(),
});
export type OwnBackgroundRun = z.infer<typeof ownBackgroundRunSchema>;

type Row = {
  id: string;
  ask: string;
  state: (typeof BACKGROUND_STATES)[number];
  steps_done: number;
  steps_total: number;
  stop_code: string | null;
  started_at: Date;
  updated_at: Date;
};
const COLUMNS = 'id, ask, state, steps_done, steps_total, stop_code, started_at, updated_at';
const view = (row: Row): OwnBackgroundRun => ({
  id: row.id,
  ask: row.ask,
  state: row.state,
  stepsDone: row.steps_done,
  stepsTotal: row.steps_total,
  stopCode: row.stop_code,
  mode: 'test',
  cost: '0',
  label: 'TEST',
  startedAt: row.started_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export const STOP_CODE = { quarantined: 'agents.agent.quarantined', disabled_by_kind: 'agents.agent.disabled_by_kind' } as const;

export class BackgroundRunStore {
  constructor(private readonly sql: Sql) {}

  /** Starts one run; the same request key again is that run. The caller has already checked the agent is switched on. */
  async start(ownerId: string, agentId: string, requestKey: string, ask: string, steps: number): Promise<OwnBackgroundRun> {
    const rows = await this.sql<Row[]>`
      INSERT INTO agents.own_agent_background_runs (owner_id, agent_id, request_key, ask, steps_total)
      VALUES (${ownerId}, ${agentId}, ${requestKey}, ${ask}, ${steps})
      ON CONFLICT (owner_id, request_key) DO NOTHING
      RETURNING ${this.sql.unsafe(COLUMNS)}
    `;
    if (rows[0]) return view(rows[0]);
    const [existing] = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM agents.own_agent_background_runs
       WHERE owner_id = ${ownerId} AND request_key = ${requestKey} AND agent_id = ${agentId}
    `;
    if (!existing) throw new Error('agents.request_id_replay');
    return view(existing);
  }

  /** The agent's background runs, newest first. */
  async list(ownerId: string, agentId: string, limit: number): Promise<OwnBackgroundRun[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM agents.own_agent_background_runs
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
       ORDER BY started_at DESC, id
       LIMIT ${limit}
    `;
    return rows.map(view);
  }
}

/**
 * One boundary for every running run: each re-reads its agent's switches, then either stops there or takes one step.
 * A run another ticker holds is skipped, so two instances never take the same step twice. Returns how many it touched.
 */
export async function advanceBackgroundRuns(sql: Sql, batch = 100): Promise<number> {
  return transaction(sql, async (tx) => {
    const running = await tx<{ id: string; agent_id: string; steps_done: number; steps_total: number }[]>`
      SELECT id, agent_id::text AS agent_id, steps_done, steps_total FROM agents.own_agent_background_runs
       WHERE state = 'running'
       ORDER BY updated_at
       LIMIT ${batch}
       FOR UPDATE SKIP LOCKED
    `;
    for (const run of running) {
      const on = await ownAgentSwitch(tx, run.agent_id);
      if (on !== 'active') {
        await tx`
          UPDATE agents.own_agent_background_runs SET state = 'stopped', stop_code = ${STOP_CODE[on]}, updated_at = now()
           WHERE id = ${run.id}
        `;
        continue;
      }
      const done = run.steps_done + 1;
      await tx`
        UPDATE agents.own_agent_background_runs
           SET steps_done = ${done}, state = ${done >= run.steps_total ? 'done' : 'running'}, updated_at = now()
         WHERE id = ${run.id}
      `;
    }
    return running.length;
  });
}
