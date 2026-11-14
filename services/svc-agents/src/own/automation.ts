import type { Sql } from 'postgres';
import {
  OWN_AGENT_AUTOMATION_LIMITS,
  OWN_AGENT_TRIGGER_SUBJECTS,
  type OwnAgentAutoRun,
  type OwnAgentCadence,
  type OwnAgentSchedule,
  type OwnAgentTrigger,
} from '@intafaced/contracts';
import { SUBJECT_PREFIX } from '@intafaced/events';
import { formatAmount, MoneyError, parseAmount, type Amount } from '@intafaced/ledger-client';
import { AgentError, MeteredReplayError } from '../errors.js';
import type { Guardrail } from '../fleet/guardrails.js';
import { ownAgentSwitch } from '../fleet/control.js';
import { RefusedError, type AgentRuntime } from '../runtime.js';
import { OwnAgentRefusal } from './catalog.js';
import { readOwnCaps } from './limits.js';
import { OwnAgentStore, type OwnAgentView } from './store.js';

/**
 * Schedules and event triggers of a person's own agent (AG-sessions-02, J-agents-07 #1 to #4).
 *
 * A schedule runs the agent once, or again every interval the person set, never below the owner's minimum; a trigger
 * runs it when one of the person's own events arrives. Each occurrence (`agents:schedule:<schedule>:<ordinal>`) or event
 * (`agents:trigger:<trigger>:<event id>`) is one row of own_agent_auto_runs, unique on that business key and written
 * before anything runs. Workers wake together, so a due occurrence is claimed under its schedule's row lock: one worker
 * writes the row and runs it, every other one that woke for it only counts its wake. If this crashes after the row and
 * before the run ends, the row stays `claimed` and a later tick resumes it under the same key, whose request id the
 * meter holds, so it is never run or billed twice.
 *
 * The run itself is the agent's own run on a session of its own: admitted against the agent's switch, the schedule's
 * cap per run (a session's spend ceiling, the lower of it and the agent's cap), the person's caps for the agent, and the
 * owner's daily occurrence limit, then metered through its usage window like any run. A blank cap or limit skips the
 * occurrence `agents.schedule_blocked` with its reason, and nothing runs. No value moves here; the window's charge is the
 * existing fee charge, at settlement.
 */

export const SCHEDULE_BLOCKED = 'agents.schedule_blocked' as const;
/** How long a claimed run may go without a change before another tick takes it over and resumes it. */
export const AUTO_RUN_LEASE_MS = 5 * 60_000;

/** The owner's cadence values; blank (null) refuses a new schedule `agents.schedule_cadence_unset`. */
export type Cadence = OwnAgentCadence;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUL = /\u0000/;

export const scheduleRunKey = (scheduleId: string, ordinal: number) => `agents:schedule:${scheduleId}:${ordinal}`;
export const triggerRunKey = (triggerId: string, eventId: string) => `agents:trigger:${triggerId}:${eventId}`;

/** A cap as the person typed it: blank is null (kept blank, never a default); anything else a decimal at or above zero. */
function capOf(text: string): Amount | null {
  const value = text.trim();
  if (!value) return null;
  try {
    const amount = parseAmount(value);
    if (amount < 0n) throw new OwnAgentRefusal('agents.own.cap_invalid');
    return amount;
  } catch (err) {
    if (err instanceof MoneyError) throw new OwnAgentRefusal('agents.own.cap_invalid');
    throw err;
  }
}

function askOf(text: string, blank: 'agents.schedule.ask_blank'): string {
  if (NUL.test(text)) throw new OwnAgentRefusal('agents.own.text_invalid');
  if (text.length > OWN_AGENT_AUTOMATION_LIMITS.ask) throw new OwnAgentRefusal('agents.own.text_invalid');
  if (!text.trim()) throw new OwnAgentRefusal(blank);
  return text;
}

export interface ScheduleRequest {
  readonly repeat: 'once' | 'repeat';
  readonly intervalMinutes: number | null;
  readonly perRunCap: Amount | null;
  readonly ask: string;
}

/**
 * A new schedule as the person typed it, checked: the owner's cadence first (blank refuses `agents.schedule_cadence_unset`),
 * then a repeating schedule's interval (blank refuses `agents.schedule.min_interval_unset`, below the owner's minimum
 * `agents.schedule.interval_below_minimum`), then the ask. A blank cap per run is kept blank.
 */
export function checkScheduleRequest(
  input: { repeat: 'once' | 'repeat'; intervalMinutes: string; perRunCap: string; ask: string },
  cadence: Cadence,
): ScheduleRequest {
  if (cadence.minIntervalMinutes === null || cadence.dailyLimit === null) throw new OwnAgentRefusal('agents.schedule_cadence_unset');
  let intervalMinutes: number | null = null;
  if (input.repeat === 'repeat') {
    const text = input.intervalMinutes.trim();
    if (!text) throw new OwnAgentRefusal('agents.schedule.min_interval_unset');
    if (!/^[0-9]{1,6}$/.test(text) || Number(text) < 1) throw new OwnAgentRefusal('agents.schedule.interval_invalid');
    intervalMinutes = Number(text);
    if (intervalMinutes < cadence.minIntervalMinutes) {
      throw new OwnAgentRefusal('agents.schedule.interval_below_minimum', { minimum: String(cadence.minIntervalMinutes) });
    }
  } else if (input.intervalMinutes.trim()) {
    throw new OwnAgentRefusal('agents.schedule.interval_invalid');
  }
  const ask = askOf(input.ask, 'agents.schedule.ask_blank');
  return { repeat: input.repeat, intervalMinutes, perRunCap: capOf(input.perRunCap), ask };
}

/** A new trigger: a subject this service offers (declared in packages/events), an ask, and a cap per run kept as typed. */
export function checkTriggerRequest(input: { subject: string; perRunCap: string; ask: string }): {
  subject: (typeof OWN_AGENT_TRIGGER_SUBJECTS)[number];
  perRunCap: Amount | null;
  ask: string;
} {
  const subject = OWN_AGENT_TRIGGER_SUBJECTS.find((s) => s === input.subject);
  if (!subject) throw new OwnAgentRefusal('agents.trigger_subject_invalid');
  return { subject, perRunCap: capOf(input.perRunCap), ask: askOf(input.ask, 'agents.schedule.ask_blank') };
}

interface AutoRunRow {
  id: string;
  run_key: string;
  agent_id: string;
  owner_id: string;
  source: 'schedule' | 'trigger';
  source_id: string;
  ordinal: number | null;
  event_id: string | null;
  due_at: Date;
  state: OwnAgentAutoRun['state'];
  code: string | null;
  reason_code: string | null;
  session_id: string | null;
  cost: string | null;
  wakes: number;
  runs: number;
  created_at: Date;
  updated_at: Date;
}

const AUTO_RUN_COLUMNS = `r.id, r.run_key, r.agent_id::text, r.owner_id, r.source, r.source_id::text, r.ordinal, r.event_id, r.due_at,
  r.state, r.code, r.reason_code, r.session_id::text, r.cost::text, r.wakes, r.created_at, r.updated_at,
  (SELECT count(*)::int FROM agents.agent_actions a
    WHERE r.session_id IS NOT NULL AND a.session_id = r.session_id AND a.kind = 'completion' AND a.status = 'executed') AS runs`;

const autoRunView = (row: AutoRunRow, assetId: string): OwnAgentAutoRun => ({
  id: row.id,
  runKey: row.run_key,
  ordinal: row.ordinal,
  eventId: row.event_id,
  dueAt: row.due_at.toISOString(),
  state: row.state,
  code: row.code,
  reasonCode: row.reason_code,
  sessionId: row.session_id,
  runs: row.runs,
  wakes: row.wakes,
  cost: row.cost === null ? null : formatAmount(parseAmount(row.cost)),
  assetId,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

interface ScheduleRow {
  id: string;
  agent_id: string;
  repeat: 'once' | 'repeat';
  interval_minutes: number | null;
  per_run_cap: string | null;
  ask: string;
  state: OwnAgentSchedule['state'];
  next_ordinal: number;
  next_due_at: Date | null;
  created_at: Date;
}

interface TriggerRow {
  id: string;
  agent_id: string;
  subject: OwnAgentTrigger['subject'];
  per_run_cap: string | null;
  ask: string;
  state: OwnAgentTrigger['state'];
  created_at: Date;
}

const capView = (cap: string | null) => (cap === null ? null : formatAmount(parseAmount(cap)));

/** The person's own schedules and triggers. Every read and write is bound to the owner; another's reads as not found. */
export class OwnAutomationStore {
  constructor(
    private readonly sql: Sql,
    private readonly assetId: string,
  ) {}

  private async recent(sourceIds: readonly string[], limit: number): Promise<Map<string, OwnAgentAutoRun[]>> {
    const out = new Map<string, OwnAgentAutoRun[]>();
    if (sourceIds.length === 0) return out;
    const rows = await this.sql<AutoRunRow[]>`
      SELECT ${this.sql.unsafe(AUTO_RUN_COLUMNS)}
        FROM agents.own_agent_auto_runs r
       WHERE r.source_id IN ${this.sql(sourceIds as string[])}
       ORDER BY r.created_at DESC, r.ordinal DESC NULLS LAST
    `;
    for (const row of rows) {
      const list = out.get(row.source_id) ?? [];
      if (list.length < limit) list.push(autoRunView(row, this.assetId));
      out.set(row.source_id, list);
    }
    return out;
  }

  async createSchedule(ownerId: string, agent: OwnAgentView, createKey: string, request: ScheduleRequest): Promise<OwnAgentSchedule> {
    const [row] = await this.sql<Array<{ id: string }>>`
      INSERT INTO agents.own_agent_schedules (agent_id, owner_id, create_key, repeat, interval_minutes, per_run_cap, ask, next_due_at)
      VALUES (${agent.id}, ${ownerId}, ${createKey}, ${request.repeat}, ${request.intervalMinutes},
              ${request.perRunCap === null ? null : formatAmount(request.perRunCap)}::numeric, ${request.ask}, now())
      ON CONFLICT (owner_id, create_key) DO UPDATE SET updated_at = agents.own_agent_schedules.updated_at
      RETURNING id::text
    `;
    return this.schedule(ownerId, agent.id, row!.id);
  }

  async schedule(ownerId: string, agentId: string, id: string): Promise<OwnAgentSchedule> {
    const found = (await this.schedules(ownerId, agentId, OWN_AGENT_AUTOMATION_LIMITS.list)).find((s) => s.id === id);
    if (!found) throw new OwnAgentRefusal('agents.schedule.not_found');
    return found;
  }

  async schedules(ownerId: string, agentId: string, limit: number): Promise<OwnAgentSchedule[]> {
    const rows = await this.sql<ScheduleRow[]>`
      SELECT id::text, agent_id::text, repeat, interval_minutes, per_run_cap::text, ask, state, next_ordinal, next_due_at, created_at
        FROM agents.own_agent_schedules
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
       ORDER BY created_at DESC, id
       LIMIT ${limit}
    `;
    const recent = await this.recent(
      rows.map((r) => r.id),
      OWN_AGENT_AUTOMATION_LIMITS.list,
    );
    return rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      repeat: row.repeat,
      intervalMinutes: row.interval_minutes,
      perRunCap: capView(row.per_run_cap),
      ask: row.ask,
      state: row.state,
      nextDueAt: row.next_due_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      recent: recent.get(row.id) ?? [],
    }));
  }

  /**
   * Cancels a schedule: it has no next occurrence and none is claimed after this. A run already running goes on (the
   * person's stop is AG-control-01's). Cancelling again returns the cancelled schedule.
   */
  async cancelSchedule(ownerId: string, agentId: string, id: string): Promise<OwnAgentSchedule> {
    if (!UUID_RE.test(id)) throw new OwnAgentRefusal('agents.schedule.not_found');
    const [row] = await this.sql<Array<{ id: string }>>`
      UPDATE agents.own_agent_schedules
         SET state = CASE WHEN state = 'active' THEN 'cancelled' ELSE state END,
             next_due_at = CASE WHEN state = 'active' THEN NULL ELSE next_due_at END,
             updated_at = now()
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId} AND id = ${id}
      RETURNING id::text
    `;
    if (!row) throw new OwnAgentRefusal('agents.schedule.not_found');
    return this.schedule(ownerId, agentId, id);
  }

  async createTrigger(
    ownerId: string,
    agent: OwnAgentView,
    createKey: string,
    request: ReturnType<typeof checkTriggerRequest>,
  ): Promise<OwnAgentTrigger> {
    const [row] = await this.sql<Array<{ id: string }>>`
      INSERT INTO agents.own_agent_triggers (agent_id, owner_id, create_key, subject, per_run_cap, ask)
      VALUES (${agent.id}, ${ownerId}, ${createKey}, ${request.subject},
              ${request.perRunCap === null ? null : formatAmount(request.perRunCap)}::numeric, ${request.ask})
      ON CONFLICT (owner_id, create_key) DO UPDATE SET updated_at = agents.own_agent_triggers.updated_at
      RETURNING id::text
    `;
    const found = (await this.triggers(ownerId, agent.id, OWN_AGENT_AUTOMATION_LIMITS.list)).find((t) => t.id === row!.id);
    if (!found) throw new OwnAgentRefusal('agents.trigger.not_found');
    return found;
  }

  async triggers(ownerId: string, agentId: string, limit: number): Promise<OwnAgentTrigger[]> {
    const rows = await this.sql<TriggerRow[]>`
      SELECT id::text, agent_id::text, subject, per_run_cap::text, ask, state, created_at
        FROM agents.own_agent_triggers
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
       ORDER BY created_at DESC, id
       LIMIT ${limit}
    `;
    const ids = rows.map((r) => r.id);
    const runs = await this.recent(ids, OWN_AGENT_AUTOMATION_LIMITS.list);
    const deliveries =
      ids.length === 0
        ? []
        : await this.sql<Array<{ trigger_id: string; envelope_id: string; event_id: string; redelivered: boolean; received_at: Date }>>`
            SELECT trigger_id::text, envelope_id, event_id, redelivered, received_at
              FROM agents.own_agent_trigger_deliveries
             WHERE trigger_id IN ${this.sql(ids)}
             ORDER BY received_at DESC, envelope_id
          `;
    return rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      subject: row.subject,
      perRunCap: capView(row.per_run_cap),
      ask: row.ask,
      state: row.state,
      createdAt: row.created_at.toISOString(),
      runs: runs.get(row.id) ?? [],
      deliveries: deliveries
        .filter((d) => d.trigger_id === row.id)
        .slice(0, OWN_AGENT_AUTOMATION_LIMITS.list)
        .map((d) => ({
          eventId: d.event_id,
          envelopeId: d.envelope_id,
          redelivered: d.redelivered,
          receivedAt: d.received_at.toISOString(),
        })),
    }));
  }
}

/** What running an occurrence or an event needs. */
export interface AutoRunDeps {
  readonly sql: Sql;
  readonly runtime: AgentRuntime;
  readonly cadence: Cadence;
  /** The run task every run of an own agent is routed and priced as. */
  readonly task: string;
  /** The guardrail a session of the agent is bound to, with `perSessionCap` as its spend ceiling. */
  readonly guardrailOf: (agent: OwnAgentView) => Guardrail;
  readonly log?: (msg: string, detail: Record<string, unknown>) => void;
}

const minCap = (a: Amount, b: Amount) => (a < b ? a : b);

async function settle(
  sql: Sql,
  id: string,
  state: 'ran' | 'skipped' | 'refused' | 'failed',
  fields: { code?: string | null; reason?: string | null; cost?: Amount | null },
) {
  await sql`
    UPDATE agents.own_agent_auto_runs
       SET state = ${state}, code = ${fields.code ?? null}, reason_code = ${fields.reason ?? null},
           cost = ${fields.cost === undefined || fields.cost === null ? null : formatAmount(fields.cost)}::numeric, updated_at = now()
     WHERE id = ${id} AND state = 'claimed'
  `;
}

/**
 * Runs one claimed occurrence or event, once: admission, then the agent's own run on a session of its own under the run
 * key as its request id, then the session's close, which bills its window. Ends `ran`, `skipped` (with
 * `agents.schedule_blocked` and its reason), `refused` (with the run's own refusal code) or `failed`.
 */
export async function executeAutoRun(deps: AutoRunDeps, runId: string): Promise<void> {
  const { sql, runtime } = deps;
  const [row] = await sql<
    Array<{
      id: string;
      run_key: string;
      agent_id: string;
      owner_id: string;
      source: 'schedule' | 'trigger';
      source_id: string;
      session_id: string | null;
      state: string;
      per_run_cap: string | null;
      ask: string;
    }>
  >`
    SELECT r.id, r.run_key, r.agent_id::text, r.owner_id, r.source, r.source_id::text, r.session_id::text, r.state,
           COALESCE(s.per_run_cap, t.per_run_cap)::text AS per_run_cap, COALESCE(s.ask, t.ask) AS ask
      FROM agents.own_agent_auto_runs r
      LEFT JOIN agents.own_agent_schedules s ON r.source = 'schedule' AND s.id = r.source_id
      LEFT JOIN agents.own_agent_triggers t ON r.source = 'trigger' AND t.id = r.source_id
     WHERE r.id = ${runId}
  `;
  if (!row || row.state !== 'claimed') return;
  const skip = (reason: string) => settle(sql, row.id, 'skipped', { code: SCHEDULE_BLOCKED, reason });

  let agent: OwnAgentView;
  try {
    agent = await new OwnAgentStore(sql).get(row.owner_id, row.agent_id);
  } catch (err) {
    if (err instanceof OwnAgentRefusal) return skip(err.code);
    throw err;
  }
  // Admission, as for the person's own run: nothing runs on a guess.
  if ((await ownAgentSwitch(sql, agent.id)) !== 'active') return skip('agents.agent.disabled');
  if (row.per_run_cap === null) return skip('agents.schedule.cap_per_run_unset');
  if (!(await readOwnCaps(sql, row.owner_id, agent.id))) return skip('agents.spend.cap_unset');
  if (deps.cadence.dailyLimit === null) return skip('agents.schedule_cadence_unset');
  // Today's runs of this schedule or trigger: those that ran, and those claimed before this one and still running, so
  // runs claimed together (two fills at once) cannot each pass the limit before either settles.
  const [today] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM agents.own_agent_auto_runs
     WHERE source_id = ${row.source_id} AND id <> ${row.id} AND created_at >= date_trunc('day', now())
       AND (state = 'ran'
            OR (state = 'claimed' AND (created_at, id) < (SELECT created_at, id FROM agents.own_agent_auto_runs WHERE id = ${row.id})))
  `;
  if (today!.n >= deps.cadence.dailyLimit) return skip('agents.schedule.daily_limit_reached');

  // The session of this run, opened once: a resumed run keeps the session its first attempt opened.
  let sessionId = row.session_id;
  if (!sessionId) {
    const perSessionCap = formatAmount(minCap(parseAmount(agent.perSessionCap!), parseAmount(row.per_run_cap)));
    const session = await runtime.openOwnSession({ userId: row.owner_id, guardrail: deps.guardrailOf({ ...agent, perSessionCap }) });
    const [bound] = await sql<Array<{ session_id: string }>>`
      UPDATE agents.own_agent_auto_runs SET session_id = COALESCE(session_id, ${session.id}::uuid), updated_at = now()
       WHERE id = ${row.id} RETURNING session_id::text
    `;
    sessionId = bound!.session_id;
    if (sessionId !== session.id) await runtime.closeSession(session.id).catch(() => undefined);
  }

  let cost: Amount | null = null;
  try {
    const result = await runtime.think({
      sessionId,
      requestId: row.run_key,
      task: deps.task,
      ...(agent.instructions.trim() ? { system: agent.instructions } : {}),
      // The ask is the person's own, stored with the schedule or trigger. An event's payload never reaches the agent:
      // it is untrusted and can choose no tool, destination or amount.
      messages: [{ role: 'user', content: row.ask }],
    });
    cost = result.cost;
  } catch (err) {
    if (err instanceof MeteredReplayError) {
      // A resumed run whose engine call was already metered: it ran, once. Its cost is what the meter holds for it.
      const [metered] = await sql<Array<{ cost: string | null }>>`
        SELECT sum(cost)::text AS cost FROM agents.agent_actions
         WHERE session_id = ${sessionId} AND kind = 'completion' AND status = 'executed'
      `;
      cost = metered?.cost ? parseAmount(metered.cost) : null;
    } else if (err instanceof RefusedError) {
      await runtime.closeSettled(sessionId).catch(() => undefined);
      return settle(sql, row.id, 'refused', { code: err.refusal.code });
    } else {
      await settle(sql, row.id, 'failed', { code: err instanceof AgentError ? err.code : 'agents.error.engine_unavailable' });
      deps.log?.('own agent automatic run failed', { runKey: row.run_key, err: String(err) });
      return;
    }
  }
  // Closing bills the session's window on its own charge key. A window the ledger refuses stays unpaid and is retried
  // before the person's next run (the runtime's unpaid-window rule); the run itself happened once.
  await runtime
    .closeSettled(sessionId)
    .catch((err: unknown) => deps.log?.('own agent automatic run window unpaid', { runKey: row.run_key, err: String(err) }));
  await settle(sql, row.id, 'ran', { cost });
}

/**
 * One worker's claim of the occurrences it woke for. Under the schedule's row lock: still active and still on that
 * ordinal, the worker writes the occurrence row and moves the schedule on; already taken, it counts its wake on the
 * row the other worker wrote. Returns the ids this worker claimed.
 */
async function claimDue(sql: Sql, due: ReadonlyArray<{ id: string; ordinal: number }>): Promise<string[]> {
  const claimed: string[] = [];
  for (const { id, ordinal } of due) {
    const runId = await sql.begin(async (tx) => {
      const [schedule] = await tx<
        Array<{ agent_id: string; owner_id: string; repeat: string; state: string; next_ordinal: number; next_due_at: Date | null }>
      >`
        SELECT agent_id::text, owner_id, repeat, state, next_ordinal, next_due_at
          FROM agents.own_agent_schedules WHERE id = ${id} FOR UPDATE
      `;
      if (!schedule) return null;
      const key = scheduleRunKey(id, ordinal);
      if (schedule.state !== 'active' || schedule.next_ordinal !== ordinal || !schedule.next_due_at) {
        await tx`UPDATE agents.own_agent_auto_runs SET wakes = wakes + 1 WHERE run_key = ${key}`;
        return null;
      }
      const [inserted] = await tx<Array<{ id: string; fresh: boolean }>>`
        INSERT INTO agents.own_agent_auto_runs (run_key, agent_id, owner_id, source, source_id, ordinal, due_at)
        VALUES (${key}, ${schedule.agent_id}, ${schedule.owner_id}, 'schedule', ${id}, ${ordinal}, ${schedule.next_due_at})
        ON CONFLICT (run_key) DO UPDATE SET wakes = agents.own_agent_auto_runs.wakes + 1
        RETURNING id::text, (xmax = 0) AS fresh
      `;
      await tx`
        UPDATE agents.own_agent_schedules
           SET next_ordinal = next_ordinal + 1,
               state = CASE WHEN repeat = 'once' THEN 'completed' ELSE state END,
               next_due_at = CASE WHEN repeat = 'once' THEN NULL
                                  ELSE GREATEST(next_due_at + make_interval(mins => interval_minutes), now()) END,
               updated_at = now()
         WHERE id = ${id}
      `;
      return inserted?.fresh ? inserted.id : null;
    });
    if (runId) claimed.push(runId);
  }
  return claimed;
}

/** The active schedules due now, with the ordinal each is on. */
async function dueSchedules(sql: Sql, limit: number): Promise<Array<{ id: string; ordinal: number }>> {
  return sql<Array<{ id: string; ordinal: number }>>`
    SELECT id::text, next_ordinal AS ordinal FROM agents.own_agent_schedules
     WHERE state = 'active' AND next_due_at <= now()
     ORDER BY next_due_at, id
     LIMIT ${limit}
  `;
}

/**
 * One tick of the due-run workers. Every worker wakes and reads what is due before any of them claims, as workers on
 * separate machines would; each then claims under the schedule's lock and runs what it claimed. Claimed runs a crash
 * left behind past their lease are taken over and resumed first.
 */
export async function tickSchedules(
  deps: AutoRunDeps,
  workers: number,
  now: () => Date = () => new Date(),
): Promise<{ claimed: number; resumed: number }> {
  const stale = await deps.sql<Array<{ id: string }>>`
    UPDATE agents.own_agent_auto_runs SET updated_at = now()
     WHERE state = 'claimed' AND updated_at < ${new Date(now().getTime() - AUTO_RUN_LEASE_MS)}
    RETURNING id::text
  `;
  for (const { id } of stale) await executeAutoRun(deps, id);
  const woke = await Promise.all(Array.from({ length: Math.max(1, workers) }, () => dueSchedules(deps.sql, 20)));
  const claimed = await Promise.all(
    woke.map(async (due) => {
      const ids = await claimDue(deps.sql, due);
      for (const id of ids) await executeAutoRun(deps, id);
      return ids.length;
    }),
  );
  return { claimed: claimed.reduce((a, b) => a + b, 0), resumed: stale.length };
}

/**
 * One delivery of a person's own event to their triggers on its subject. Under each trigger's row lock: the delivery is
 * recorded (a redelivery of an event id already seen is marked so), and the event's run row is written once; only the
 * delivery that wrote it runs it. The run row is the seen-set, in Postgres, so a restart never runs an event twice.
 * `event.subject` is the bus subject as the envelope carries it (`intafaced.trade.fill.settled`); a trigger stores its
 * subject without the bus prefix (`trade.fill.settled`). An event that happened before a trigger was added
 * (`occurredAt`, the event's own time) never runs it, however late it is delivered.
 */
export async function deliverTriggerEvent(
  deps: AutoRunDeps,
  event: { subject: string; userId: string; eventId: string; envelopeId: string; occurredAt: string },
): Promise<number> {
  const prefix = `${SUBJECT_PREFIX}.`;
  if (!event.subject.startsWith(prefix)) throw new Error(`deliverTriggerEvent takes a bus subject (${prefix}…), not ${event.subject}`);
  const subject = event.subject.slice(prefix.length);
  const triggers = await deps.sql<Array<{ id: string }>>`
    SELECT id::text FROM agents.own_agent_triggers
     WHERE subject = ${subject} AND owner_id = ${event.userId} AND state = 'active' AND created_at <= ${event.occurredAt}::timestamptz
  `;
  let ran = 0;
  for (const trigger of triggers) {
    const runId = await deps.sql.begin(async (tx) => {
      const [locked] = await tx<Array<{ agent_id: string; owner_id: string; state: string }>>`
        SELECT agent_id::text, owner_id, state FROM agents.own_agent_triggers WHERE id = ${trigger.id} FOR UPDATE
      `;
      if (!locked || locked.state !== 'active') return null;
      const [seen] = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM agents.own_agent_trigger_deliveries WHERE trigger_id = ${trigger.id} AND event_id = ${event.eventId}
      `;
      await tx`
        INSERT INTO agents.own_agent_trigger_deliveries (trigger_id, agent_id, envelope_id, event_id, redelivered)
        VALUES (${trigger.id}, ${locked.agent_id}, ${event.envelopeId}, ${event.eventId}, ${seen!.n > 0})
        ON CONFLICT (trigger_id, envelope_id) DO NOTHING
      `;
      const [inserted] = await tx<Array<{ id: string }>>`
        INSERT INTO agents.own_agent_auto_runs (run_key, agent_id, owner_id, source, source_id, event_id, due_at)
        VALUES (${triggerRunKey(trigger.id, event.eventId)}, ${locked.agent_id}, ${locked.owner_id}, 'trigger', ${trigger.id}, ${event.eventId}, now())
        ON CONFLICT (run_key) DO NOTHING
        RETURNING id::text
      `;
      return inserted?.id ?? null;
    });
    if (runId) {
      await executeAutoRun(deps, runId);
      ran += 1;
    }
  }
  return ran;
}
