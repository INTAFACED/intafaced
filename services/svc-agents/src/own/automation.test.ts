import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger } from '@intafaced/ledger-client';
import { ModelGateway } from '../gateway/gateway.js';
import { parseRoutingTable } from '../gateway/routing.js';
import { UsageMeter } from '../metering/meter.js';
import { MockModelProvider } from '../providers/mock.js';
import { createAgentsRouter } from '../router.js';
import { AgentRuntime } from '../runtime.js';
import { UserSpendStore } from '../spend/store.js';
import {
  checkScheduleRequest,
  checkTriggerRequest,
  deliverTriggerEvent,
  scheduleRunKey,
  tickSchedules,
  type AutoRunDeps,
} from './automation.js';
import { OWN_RUN_TASK, ownGuardrail } from './routes.js';

/**
 * Schedules and event triggers of a person's own agent (AG-sessions-02; J-agents-07 #1 to #4): a blank interval or a
 * blank owner cadence refuses and stores nothing; two workers waking for one occurrence make one run; a blank cap per run
 * skips the occurrence with its reason; a run a crash left claimed is resumed once, never doubled; a cancelled schedule
 * has no further occurrence; the same event delivered twice, or again after a restart, is one run.
 */

const URL = process.env.TEST_DATABASE_URL_AGENTS ?? 'postgres://svc_agents:svc_agents@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SECRET = 'an-agents-own-automation-test-secret-of-32-plus!';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
const CADENCE = { minIntervalMinutes: 1, dailyLimit: 100 };

function callerFor(userId: string) {
  const principal = {
    sub: userId,
    userId,
    sid: '55555555-5555-4555-8555-555555555555',
    scopes: ['agents:read', 'agents:execute', 'identity:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-own-automation',
  });
}

describe('a schedule and a trigger as typed, without a database', () => {
  const typed = { repeat: 'repeat' as const, intervalMinutes: '5', perRunCap: '0.1', ask: 'TEST check' };

  it('refuses a blank owner cadence first, then a repeating schedule with its interval blank, by name', () => {
    expect(() => checkScheduleRequest(typed, { minIntervalMinutes: null, dailyLimit: 100 })).toThrow('agents.schedule_cadence_unset');
    expect(() => checkScheduleRequest(typed, { minIntervalMinutes: 1, dailyLimit: null })).toThrow('agents.schedule_cadence_unset');
    expect(() => checkScheduleRequest({ ...typed, intervalMinutes: '' }, CADENCE)).toThrow('agents.schedule.min_interval_unset');
    expect(() => checkScheduleRequest({ ...typed, intervalMinutes: '  ' }, CADENCE)).toThrow('agents.schedule.min_interval_unset');
    for (const intervalMinutes of ['0', '1.5', '-1', 'hourly'])
      expect(() => checkScheduleRequest({ ...typed, intervalMinutes }, CADENCE)).toThrow('agents.schedule.interval_invalid');
    expect(() => checkScheduleRequest({ ...typed, intervalMinutes: '4' }, { minIntervalMinutes: 5, dailyLimit: 1 })).toThrow(
      'agents.schedule.interval_below_minimum',
    );
    expect(() => checkScheduleRequest({ ...typed, ask: ' ' }, CADENCE)).toThrow('agents.schedule.ask_blank');
    expect(() => checkScheduleRequest({ ...typed, perRunCap: '-1' }, CADENCE)).toThrow('agents.own.cap_invalid');
  });

  it('keeps a blank cap per run blank, never a default, and a once schedule takes no interval', () => {
    expect(checkScheduleRequest({ ...typed, perRunCap: '' }, CADENCE)).toMatchObject({ perRunCap: null, intervalMinutes: 5 });
    expect(checkScheduleRequest({ ...typed, repeat: 'once', intervalMinutes: '' }, CADENCE)).toMatchObject({ intervalMinutes: null });
    expect(() => checkScheduleRequest({ ...typed, repeat: 'once' }, CADENCE)).toThrow('agents.schedule.interval_invalid');
  });

  it('offers only subjects it consumes', () => {
    expect(checkTriggerRequest({ subject: 'trade.fill.settled', perRunCap: '0.1', ask: 'TEST' }).subject).toBe('trade.fill.settled');
    expect(() => checkTriggerRequest({ subject: 'identity.kyc.approved', perRunCap: '0.1', ask: 'TEST' })).toThrow(
      'agents.trigger_subject_invalid',
    );
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('own agent schedules and triggers (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 8,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-own-automation-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');
  let lockConn: Awaited<ReturnType<typeof sql.reserve>>;

  function people() {
    const table = parseRoutingTable({
      routes: [
        {
          task: OWN_RUN_TASK,
          providerId: 'primary',
          model: 'reasoning-md',
          maxOutputTokens: 2048,
          price: { inputPerMillion: '1', outputPerMillion: '5' },
        },
      ],
    });
    const provider = new MockModelProvider({ id: 'primary' });
    const ledger = new MemoryLedger();
    const gateway = new ModelGateway([provider], table);
    const meter = new UsageMeter(sql, ledger, { assetId: 'USDT', windowMinutes: 60 });
    const runtime = new AgentRuntime(sql, gateway, meter, new MemoryEventBus('svc-agents'), {
      feeAssetId: 'USDT',
      meteringEnabled: true,
      spend: new UserSpendStore(sql),
      funds: { available: async () => 100n * 10n ** 18n },
    });
    const router = createAgentsRouter({ runtime, gateway, meter, feeAssetId: 'USDT', sql, ownCadence: CADENCE });
    const deps: AutoRunDeps = { sql, runtime, cadence: CADENCE, task: OWN_RUN_TASK, guardrailOf: ownGuardrail };
    return { person: router.createCaller(callerFor(USER)), other: router.createCaller(callerFor(OTHER)), deps, provider };
  }
  type Person = ReturnType<typeof people>['person'];

  async function agent(person: Person, { limits = true } = {}) {
    const { id } = await person.own.create({ template: 'service-starter', createKey: `auto:${Math.random()}` });
    await person.own.save({ id, name: 'TEST helper', instructions: '', tools: [], perSessionCap: '1' });
    if (limits) await person.own.limits.set({ id, perCall: '0.012', perSession: '0.02', perPeriod: '5' });
    return id;
  }

  const completions = async () =>
    (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agents.agent_actions WHERE kind = 'completion' AND status = 'executed'`)[0]!
      .n;

  beforeAll(async () => {
    lockConn = await sql.reserve();
    await lockConn`select pg_advisory_lock(842671)`;
    try {
      for (const migration of migrations) await sql.unsafe(migration);
    } finally {
      await lockConn`select pg_advisory_unlock(842671)`;
    }
  }, 120_000);

  beforeEach(async () => {
    await lockConn`select pg_advisory_lock(842671)`;
    await sql`
      TRUNCATE agents.own_agent_trigger_deliveries, agents.own_agent_auto_runs, agents.own_agent_triggers, agents.own_agent_schedules,
               agents.own_agent_session_versions, agents.own_agent_limits, agents.own_agents, agents.spend_reservations,
               agents.think_claims, agents.usage_records, agents.usage_windows, agents.agent_actions, agents.agent_sessions
      RESTART IDENTITY CASCADE
    `;
  });

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  describe('schedules through the service (J-agents-07 #1 #2 #4)', () => {
    it('refuses a repeating schedule with the interval blank and stores none (#1)', async () => {
      const { person } = people();
      const id = await agent(person);
      await expect(
        person.own.schedules.create({
          id,
          createKey: 'sched:blank:1',
          repeat: 'repeat',
          intervalMinutes: '',
          perRunCap: '0.1',
          ask: 'TEST',
        }),
      ).rejects.toThrow('agents.schedule.min_interval_unset');
      expect((await person.own.schedules.list({ id })).schedules).toEqual([]);
    });

    it('two workers waking together make one run of the occurrence; a blank cap per run skips with the reason (#2)', async () => {
      const { person, deps } = people();
      const id = await agent(person);
      const capped = await person.own.schedules.create({
        id,
        createKey: 'sched:capped:1',
        repeat: 'repeat',
        intervalMinutes: '60',
        perRunCap: '0.1',
        ask: 'TEST check',
      });
      const blank = await person.own.schedules.create({
        id,
        createKey: 'sched:blank:2',
        repeat: 'once',
        intervalMinutes: '',
        perRunCap: '',
        ask: 'TEST',
      });
      expect(blank.perRunCap).toBeNull();
      // The same create key again is the same schedule.
      expect(
        (
          await person.own.schedules.create({
            id,
            createKey: 'sched:capped:1',
            repeat: 'repeat',
            intervalMinutes: '60',
            perRunCap: '0.1',
            ask: 'TEST check',
          })
        ).id,
      ).toBe(capped.id);

      await tickSchedules(deps, 2);
      await tickSchedules(deps, 2); // nothing is due again for an hour
      const { schedules } = await person.own.schedules.list({ id });
      const ran = schedules.find((s) => s.id === capped.id)!;
      expect(ran).toMatchObject({ state: 'active' });
      expect(ran.recent).toHaveLength(1);
      expect(ran.recent[0]).toMatchObject({
        ordinal: 1,
        state: 'ran',
        runs: 1,
        wakes: 2,
        runKey: scheduleRunKey(capped.id, 1),
        code: null,
      });
      expect(Date.parse(ran.nextDueAt!)).toBeGreaterThan(Date.now() + 59 * 60_000);
      const skipped = schedules.find((s) => s.id === blank.id)!;
      expect(skipped).toMatchObject({ state: 'completed', nextDueAt: null });
      expect(skipped.recent).toEqual([
        expect.objectContaining({
          state: 'skipped',
          code: 'agents.schedule_blocked',
          reasonCode: 'agents.schedule.cap_per_run_unset',
          runs: 0,
          sessionId: null,
        }),
      ]);
      expect(await completions()).toBe(1);
      // Another person reads the agent as not found.
      await expect(people().other.own.schedules.list({ id })).rejects.toThrow('agents.own.not_found');
    });

    it('skips with the person’s caps for the agent unset, and runs nothing', async () => {
      const { person, deps } = people();
      const id = await agent(person, { limits: false });
      await person.own.schedules.create({
        id,
        createKey: 'sched:nolimits:1',
        repeat: 'once',
        intervalMinutes: '',
        perRunCap: '0.1',
        ask: 'TEST',
      });
      await tickSchedules(deps, 1);
      const [schedule] = (await person.own.schedules.list({ id })).schedules;
      expect(schedule!.recent[0]).toMatchObject({
        state: 'skipped',
        code: 'agents.schedule_blocked',
        reasonCode: 'agents.spend.cap_unset',
      });
      expect(await completions()).toBe(0);
    });

    it('resumes a run a crash left claimed once, never twice', async () => {
      const { person, deps } = people();
      const id = await agent(person);
      const schedule = await person.own.schedules.create({
        id,
        createKey: 'sched:crash:1',
        repeat: 'once',
        intervalMinutes: '',
        perRunCap: '0.1',
        ask: 'TEST',
      });
      await tickSchedules(deps, 1);
      expect(await completions()).toBe(1);
      // As if the process stopped after the engine call and before the row was settled: claimed, its lease long gone.
      await sql`UPDATE agents.own_agent_auto_runs SET state = 'claimed', updated_at = now() - interval '1 hour'`;
      await tickSchedules(deps, 2);
      const [after] = (await person.own.schedules.list({ id })).schedules;
      expect(after!.id).toBe(schedule.id);
      expect(after!.recent).toEqual([expect.objectContaining({ state: 'ran', runs: 1 })]);
      expect(await completions()).toBe(1);
    });

    it('a cancelled schedule has no next occurrence and none runs when it would have been due (#4)', async () => {
      const { person, deps } = people();
      const id = await agent(person);
      const schedule = await person.own.schedules.create({
        id,
        createKey: 'sched:cancel:1',
        repeat: 'repeat',
        intervalMinutes: '1',
        perRunCap: '0.1',
        ask: 'TEST',
      });
      await tickSchedules(deps, 1);
      // Its next occurrence is due now, and it is cancelled before any worker wakes.
      await sql`UPDATE agents.own_agent_schedules SET next_due_at = now() - interval '1 second'`;
      const cancelled = await person.own.schedules.cancel({ id, scheduleId: schedule.id });
      expect(cancelled).toMatchObject({ state: 'cancelled', nextDueAt: null });
      await tickSchedules(deps, 2);
      expect((await person.own.schedules.list({ id })).schedules[0]!.recent).toHaveLength(1);
      expect(await completions()).toBe(1);
    });
  });

  describe('triggers through the service (J-agents-07 #3)', () => {
    it('the same event id twice is one run; a restart does not repeat it', async () => {
      const { person, deps } = people();
      const id = await agent(person);
      const trigger = await person.own.triggers.create({
        id,
        createKey: 'trigger:1',
        subject: 'trade.fill.settled',
        perRunCap: '0.1',
        ask: 'TEST',
      });
      const event = { subject: 'trade.fill.settled', userId: USER, eventId: 'fill-1' };
      expect(await deliverTriggerEvent(deps, { ...event, envelopeId: 'env-1' })).toBe(1);
      expect(await deliverTriggerEvent(deps, { ...event, envelopeId: 'env-2' })).toBe(0);
      // A new process, as after a restart: the seen-set is the table.
      expect(await deliverTriggerEvent(people().deps, { ...event, envelopeId: 'env-3' })).toBe(0);
      // Another person's event never runs this person's trigger.
      expect(await deliverTriggerEvent(deps, { ...event, userId: OTHER, envelopeId: 'env-4' })).toBe(0);
      const [listed] = await person.own.triggers.list({ id });
      expect(listed!.id).toBe(trigger.id);
      expect(listed!.runs).toEqual([expect.objectContaining({ eventId: 'fill-1', state: 'ran', runs: 1 })]);
      expect(listed!.deliveries.map((d) => [d.envelopeId, d.redelivered]).sort()).toEqual([
        ['env-1', false],
        ['env-2', true],
        ['env-3', true],
      ]);
      expect(await completions()).toBe(1);
      await expect(
        person.own.triggers.create({ id, createKey: 'trigger:2', subject: 'identity.kyc.approved', perRunCap: '0.1', ask: 'TEST' }),
      ).rejects.toThrow('agents.trigger_subject_invalid');
    });
  });
}
