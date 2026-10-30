import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount, type Amount } from '@intafaced/ledger-client';
import { ModelGateway } from '../gateway/gateway.js';
import { parseRoutingTable } from '../gateway/routing.js';
import { UsageMeter } from '../metering/meter.js';
import { usageCost } from '../metering/pricing.js';
import { MockModelProvider } from '../providers/mock.js';
import { createAgentsRouter } from '../router.js';
import { AgentRuntime, estimateInputTokens } from '../runtime.js';
import { UserSpendStore } from '../spend/store.js';
import { OWN_RUN_TASK } from './routes.js';

/**
 * The soft usage alert and the monthly hard limit of a person's own agent, through the service's own routes on real
 * Postgres (J-agents-02): the alert is recorded and published once per agent and month on its business key and runs
 * go on after it; the hard limit refuses a new run with its code while a run already held finishes and is charged.
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
const SECRET = 'an-agents-own-usage-limits-test-secret-of-32-plus!';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
const PERSON = ['agents:read', 'agents:execute', 'identity:write'];

function callerFor(userId: string, scopes: string[], extra: { kid?: string } = {}) {
  const principal = {
    sub: userId,
    userId,
    sid: '55555555-5555-4555-8555-555555555555',
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...(extra.kid ? { kid: extra.kid } : {}),
  } as Principal;
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-own-usage-limits',
  });
}

const TABLE = parseRoutingTable({
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
const ASK = 'TEST question';
const INSTRUCTIONS = 'Answer TEST questions.';
/** The worst case of one run of the agent below: its instructions and the ask, at the route's output ceiling. */
const WORST: Amount = usageCost(
  { inputTokens: estimateInputTokens(INSTRUCTIONS, [{ content: ASK }]), outputTokens: 2048 },
  TABLE.routes[0]!.price!,
);

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('own agent runs (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 6,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-own-usage-limits-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');
  let lockConn: Awaited<ReturnType<typeof sql.reserve>>;

  let balance: Amount;
  let calls: number;
  let delayMs: number;
  let bus: MemoryEventBus;
  /** Set to make the bus refuse the alert event, as a NATS fault would. */
  let busDown: boolean;

  function build() {
    const provider = new MockModelProvider({ id: 'primary', answerDelayMs: delayMs });
    const inner = new ModelGateway([provider], TABLE);
    const gateway = Object.create(inner) as ModelGateway;
    gateway.complete = async (task: string, request: Parameters<ModelGateway['complete']>[1]) => {
      calls += 1;
      return inner.complete(task, request);
    };
    const meter = new UsageMeter(sql, new MemoryLedger(), { assetId: 'USDT', windowMinutes: 60 });
    const faulty = Object.create(bus) as MemoryEventBus;
    faulty.publish = (async (name: string, payload: never, opts: never) => {
      if (busDown && name === 'agentUsageAlertCrossed') throw new Error('TEST bus down');
      return bus.publish(name as never, payload, opts);
    }) as MemoryEventBus['publish'];
    const runtime = new AgentRuntime(sql, gateway, meter, faulty, {
      feeAssetId: 'USDT',
      meteringEnabled: true,
      spend: new UserSpendStore(sql),
      funds: { available: async () => balance },
    });
    return createAgentsRouter({ runtime, gateway, meter, feeAssetId: 'USDT', sql });
  }

  const people = () => {
    const router = build();
    return {
      person: router.createCaller(callerFor(USER, PERSON)),
      other: router.createCaller(callerFor(OTHER, PERSON)),
      key: router.createCaller(callerFor(USER, PERSON, { kid: '66666666-6666-4666-8666-666666666666' })),
    };
  };

  async function agentWith(person: ReturnType<typeof people>['person'], cap: string | null = '1') {
    const { id } = await person.own.create({ template: 'service-starter', createKey: `usage:${Math.random()}` });
    await person.own.save({ id, name: 'TEST helper', instructions: INSTRUCTIONS, tools: ['support.kb.search'], perSessionCap: cap });
    return id;
  }

  const holds = async () =>
    (await sql<{ status: string }[]>`SELECT status FROM agents.spend_reservations WHERE user_id = ${USER} ORDER BY created_at`).map(
      (r) => r.status,
    );
  // Each hold's worst case, in the order the runs were held.
  const heldAmounts = async () =>
    (await sql<{ amount: string }[]>`SELECT amount::text FROM agents.spend_reservations WHERE user_id = ${USER} ORDER BY created_at`).map(
      (r) => parseAmount(r.amount),
    );
  const ownSessions = async () =>
    (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agents.agent_sessions WHERE agent_id LIKE 'own.%'`)[0]!.n;

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
      TRUNCATE agents.own_agent_usage_alerts, agents.own_agent_usage_limits, agents.own_agent_limits, agents.own_agents, agents.spend_reservations, agents.user_spend_limits, agents.think_claims,
               agents.usage_records, agents.usage_windows, agents.agent_actions, agents.agent_sessions
      RESTART IDENTITY CASCADE
    `;
    balance = 100n * 10n ** 18n;
    calls = 0;
    delayMs = 0;
    bus = new MemoryEventBus('svc-agents');
    busDown = false;
  });

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  const LIMITS = { perCall: '0.012', perSession: '0.1', perPeriod: '5' };
  /** Below the cost of any one run, so the first run crosses the alert and the second one meets the hard limit. */
  const TINY = '0.000000000000000001';
  const TINY2 = '0.000000000000000002';

  async function readyAgent(person: ReturnType<typeof people>['person']) {
    const id = await agentWith(person, '1');
    await person.own.limits.set({ id, ...LIMITS });
    const { sessionId } = await person.own.session.open({ id });
    return { id, sessionId };
  }

  const alertRows = async () =>
    sql<{ alert_key: string; month: string; published: boolean; spent: string }[]>`
      SELECT alert_key, month, published_at IS NOT NULL AS published, spent::text FROM agents.own_agent_usage_alerts ORDER BY created_at
    `;

  describe('own agent usage limits', () => {
    it('reads nothing set; stores, re-stores and clears the alert, the hard limit and the email choice', async () => {
      const { person } = people();
      const id = await agentWith(person, '1');
      const month = new Date().toISOString().slice(0, 7);
      const blank = {
        alertAt: null,
        hardLimit: null,
        email: false,
        month,
        spent: '0',
        alertCrossed: false,
        alert: null,
        hardLimitReached: false,
        hardLimitRoom: null,
        assetId: 'USDT',
      };
      expect(await person.own.usageLimits.get({ id })).toEqual(blank);
      const set = await person.own.usageLimits.set({ id, alertAt: '0.5', hardLimit: '2', email: true });
      expect(set).toEqual({ ...blank, alertAt: '0.5', hardLimit: '2', hardLimitRoom: '2', email: true });
      expect(await person.own.usageLimits.set({ id, alertAt: '0.5', hardLimit: '2', email: true })).toEqual(set);
      expect(await person.own.usageLimits.get({ id })).toEqual(set);
      expect(await person.own.usageLimits.set({ id, alertAt: ' ', hardLimit: null, email: false })).toEqual(blank);
    });

    it('refuses an invalid amount, zero, and an alert at or above the hard limit with their codes; the stored values stay', async () => {
      const { person, other } = people();
      const id = await agentWith(person, '1');
      const stored = await person.own.usageLimits.set({ id, alertAt: '0.5', hardLimit: '2', email: false });
      for (const bad of [
        { alertAt: 'lots', hardLimit: '2', code: 'agents.usage.limit_invalid' },
        { alertAt: '0', hardLimit: '2', code: 'agents.usage.limit_invalid' },
        { alertAt: '0.5', hardLimit: '-1', code: 'agents.usage.limit_invalid' },
        { alertAt: '2', hardLimit: '2', code: 'agents.usage.alert_above_limit' },
        { alertAt: '3', hardLimit: '2', code: 'agents.usage.alert_above_limit' },
      ]) {
        await expect(person.own.usageLimits.set({ id, alertAt: bad.alertAt, hardLimit: bad.hardLimit, email: true })).rejects.toMatchObject(
          {
            code: 'BAD_REQUEST',
            message: bad.code,
          },
        );
      }
      await expect(other.own.usageLimits.get({ id })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'agents.own.not_found' });
      await expect(other.own.usageLimits.set({ id, alertAt: null, hardLimit: null, email: false })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(await person.own.usageLimits.get({ id })).toEqual(stored);
    });

    it('records and publishes the alert once per agent and month on its business key; runs go on after it', async () => {
      const { person } = people();
      const { id, sessionId } = await readyAgent(person);
      await person.own.usageLimits.set({ id, alertAt: TINY, hardLimit: null, email: true });
      const first = await person.own.run({ id, sessionId, requestId: 'usage-alert-1', ask: ASK });
      const second = await person.own.run({ id, sessionId, requestId: 'usage-alert-2', ask: ASK });
      const third = await person.own.run({ id, sessionId, requestId: 'usage-alert-3', ask: ASK });
      expect(calls).toBe(3);
      const month = new Date().toISOString().slice(0, 7);
      const key = `agents.usage_alert:${id}:${month}`;
      expect((await alertRows()).map((r) => ({ ...r, spent: formatAmount(parseAmount(r.spent)) }))).toEqual([
        { alert_key: key, month, published: true, spent: first.cost },
      ]);
      const emitted = bus.emitted('agentUsageAlertCrossed');
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.idempotencyKey).toBe(key);
      expect(emitted[0]!.payload).toEqual({
        alertKey: key,
        userId: USER,
        agentId: id,
        month,
        alertAt: TINY,
        spent: first.cost,
        assetId: 'USDT',
        email: true,
      });
      const view = await person.own.usageLimits.get({ id });
      expect(view.alertCrossed).toBe(true);
      // The one record: written by the run that crossed, with that run's spend, and never rewritten by the later runs.
      expect(view.alert).toEqual({ key, spent: first.cost });
      expect(parseAmount(view.spent)).toBe(parseAmount(first.cost) + parseAmount(second.cost) + parseAmount(third.cost));
      expect(bus.emitted('agentUsageAlertCrossed')).toHaveLength(1);
    });

    it('a bus fault never fails the charged run; the alert stays recorded and is published once on the next read', async () => {
      const { person } = people();
      const { id, sessionId } = await readyAgent(person);
      await person.own.usageLimits.set({ id, alertAt: TINY, hardLimit: null, email: false });
      busDown = true;
      const ran = await person.own.run({ id, sessionId, requestId: 'usage-bus-down', ask: ASK });
      expect(parseAmount(ran.cost)).toBeGreaterThan(0n);
      expect(await alertRows()).toEqual([expect.objectContaining({ published: false })]);
      expect(bus.emitted('agentUsageAlertCrossed')).toHaveLength(0);
      // Still down: the read answers and the alert waits.
      expect((await person.own.usageLimits.get({ id })).alertCrossed).toBe(true);
      busDown = false;
      await person.own.usageLimits.get({ id });
      await person.own.usageLimits.get({ id });
      expect(await alertRows()).toEqual([expect.objectContaining({ published: true })]);
      expect(bus.emitted('agentUsageAlertCrossed')).toHaveLength(1);
    });

    it('a crash after the publish and before it is marked publishes again under the same key, never a second alert', async () => {
      const { person } = people();
      const { id, sessionId } = await readyAgent(person);
      await person.own.usageLimits.set({ id, alertAt: TINY, hardLimit: null, email: false });
      await person.own.run({ id, sessionId, requestId: 'usage-crash', ask: ASK });
      await sql`UPDATE agents.own_agent_usage_alerts SET published_at = NULL`;
      await person.own.usageLimits.get({ id });
      const keys = bus.emitted('agentUsageAlertCrossed').map((e) => e.idempotencyKey);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(1);
      expect(await alertRows()).toHaveLength(1);
    });

    it('admits a run only when its worst case fits under the hard limit: the month never passes it, and a refusal bills 0', async () => {
      const { person } = people();
      const { id, sessionId } = await readyAgent(person);
      await person.own.usageLimits.set({ id, alertAt: null, hardLimit: '1', email: false });
      const first = await person.own.run({ id, sessionId, requestId: 'usage-hard-1', ask: ASK });
      const [worst] = await heldAmounts();
      const spent = parseAmount(first.cost);
      // One unit short of room for the next run's worst case: refused before the engine, nothing held.
      const short = formatAmount(spent + worst! - 1n);
      await person.own.usageLimits.set({ id, alertAt: null, hardLimit: short, email: false });
      // Not reached, with one unit less room than the run needs: the page shows the room, and the run does not fit.
      expect(await person.own.usageLimits.get({ id })).toMatchObject({
        hardLimitReached: false,
        hardLimitRoom: formatAmount(worst! - 1n),
        spent: first.cost,
      });
      await expect(person.own.run({ id, sessionId, requestId: 'usage-hard-2', ask: ASK })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'agents.usage.hard_limit_reached',
      });
      expect(calls).toBe(1);
      expect(await holds()).toEqual(['committed']);
      const runs = await person.own.runs({ id, limit: 10 });
      expect(runs.map((r) => [r.status, r.refusalCode, r.status === 'refused' ? r.cost : 'charged'])).toEqual([
        ['refused', 'agents.usage.hard_limit_reached', '0'],
        ['executed', null, 'charged'],
      ]);
      // A new session of the same agent is refused too: the limit is the agent's month, not the session's.
      const again = await person.own.session.open({ id });
      await expect(person.own.run({ id, sessionId: again.sessionId, requestId: 'usage-hard-3', ask: ASK })).rejects.toMatchObject({
        message: 'agents.usage.hard_limit_reached',
      });
      // Exactly room for the worst case: admitted, and what it costs keeps the month at or under the limit.
      const exact = spent + worst!;
      await person.own.usageLimits.set({ id, alertAt: null, hardLimit: formatAmount(exact), email: false });
      await person.own.run({ id, sessionId, requestId: 'usage-hard-4', ask: ASK });
      expect(calls).toBe(2);
      expect(parseAmount((await person.own.usageLimits.get({ id })).spent)).toBeLessThanOrEqual(exact);
    });

    it('a run over the per-call cap is refused for that cap, not the hard limit, even with no room left under it', async () => {
      const { person } = people();
      const { id, sessionId } = await readyAgent(person);
      await person.own.limits.set({ id, ...LIMITS, perCall: '0.01' });
      await person.own.usageLimits.set({ id, alertAt: null, hardLimit: TINY, email: false });
      await expect(person.own.run({ id, sessionId, requestId: 'usage-order-1', ask: ASK })).rejects.toMatchObject({
        message: 'agents.spend.cap_exceeded',
      });
      expect(calls).toBe(0);
    });

    it('a run already held when the limit is reached finishes and is charged; the next one is refused', async () => {
      delayMs = 400;
      const { person } = people();
      const { id, sessionId } = await readyAgent(person);
      await person.own.usageLimits.set({ id, alertAt: TINY, hardLimit: '1', email: false });
      const inFlight = person.own.run({ id, sessionId, requestId: 'usage-flight-a', ask: ASK });
      await vi.waitFor(async () => expect(await holds()).toEqual(['held']), { timeout: 2_000, interval: 20 });
      // The limit drops below what the held run will cost while the engine is still answering it.
      await person.own.usageLimits.set({ id, alertAt: TINY, hardLimit: TINY2, email: false });
      await expect(inFlight).resolves.toBeDefined();
      expect(await holds()).toEqual(['committed']);
      delayMs = 0;
      await expect(person.own.run({ id, sessionId, requestId: 'usage-flight-c', ask: ASK })).rejects.toMatchObject({
        message: 'agents.usage.hard_limit_reached',
      });
      expect(calls).toBe(1);
      expect(await holds()).toEqual(['committed']);
      expect(await alertRows()).toHaveLength(1);
      expect(bus.emitted('agentUsageAlertCrossed')).toHaveLength(1);
    });

    it('two runs started together at the limit: held runs count at their worst case, so exactly one is admitted', async () => {
      delayMs = 400;
      const { person } = people();
      const { id, sessionId } = await readyAgent(person);
      const warm = await person.own.run({ id, sessionId, requestId: 'usage-pair-warm', ask: ASK });
      const [worst] = await heldAmounts();
      // Room for one more worst case, not two: whichever is held first counts at its worst case against the other.
      const room = formatAmount(parseAmount(warm.cost) + 2n * worst! - 1n);
      await person.own.usageLimits.set({ id, alertAt: TINY, hardLimit: room, email: false });
      const results = await Promise.allSettled([
        person.own.run({ id, sessionId, requestId: 'usage-pair-a', ask: ASK }),
        person.own.run({ id, sessionId, requestId: 'usage-pair-b', ask: ASK }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toMatchObject({ message: 'agents.usage.hard_limit_reached' });
      expect(calls).toBe(2);
      expect(await holds()).toEqual(['committed', 'committed']);
    });

    it('an agent with no usage limits set is never refused by them and records no alert', async () => {
      const { person } = people();
      const { id, sessionId } = await readyAgent(person);
      await person.own.run({ id, sessionId, requestId: 'usage-none-1', ask: ASK });
      await person.own.run({ id, sessionId, requestId: 'usage-none-2', ask: ASK });
      expect(calls).toBe(2);
      expect(await alertRows()).toEqual([]);
      expect(bus.emitted('agentUsageAlertCrossed')).toHaveLength(0);
    });

    it('invariant: at most one alert per agent and month, and every published alert carries its own row’s key', async () => {
      const { person } = people();
      const a = await readyAgent(person);
      const b = await readyAgent(person);
      await person.own.usageLimits.set({ id: a.id, alertAt: TINY, hardLimit: null, email: false });
      await person.own.usageLimits.set({ id: b.id, alertAt: TINY, hardLimit: null, email: false });
      for (let i = 0; i < 3; i += 1) {
        await person.own.run({ id: a.id, sessionId: a.sessionId, requestId: `invariant-a-${i}`, ask: ASK });
        await person.own.run({ id: b.id, sessionId: b.sessionId, requestId: `invariant-b-${i}`, ask: ASK });
      }
      const [dupes] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM (
          SELECT agent_id, month FROM agents.own_agent_usage_alerts GROUP BY agent_id, month HAVING count(*) > 1
        ) d
      `;
      expect(dupes!.n).toBe(0);
      const rows = await alertRows();
      expect(rows).toHaveLength(2);
      expect(
        bus
          .emitted('agentUsageAlertCrossed')
          .map((e) => e.idempotencyKey)
          .sort(),
      ).toEqual(rows.map((r) => r.alert_key).sort());
    });
  });
}
