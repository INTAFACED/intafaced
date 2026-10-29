import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
 * A person's own agent, run through the service's own routes on real Postgres (AG-spend-01): the caps they set for it
 * hold every run before the engine is called, a refused run bills 0 and leaves no hold, and two runs at once whose
 * worst cases together pass a cap admit exactly one.
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
const SECRET = 'an-agents-own-run-test-secret-of-32-plus-chars!';
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
    id: 'req-own-run',
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
  { inputTokens: estimateInputTokens(INSTRUCTIONS, [{ role: 'user', content: ASK }]), outputTokens: 2048 },
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
    connection: { search_path: 'agents,public', application_name: 'svc-agents-own-run-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');
  let lockConn: Awaited<ReturnType<typeof sql.reserve>>;

  let balance: Amount | null;
  let calls: number;
  let delayMs: number;

  function build() {
    const provider = new MockModelProvider({ id: 'primary', answerDelayMs: delayMs });
    const inner = new ModelGateway([provider], TABLE);
    const gateway = Object.create(inner) as ModelGateway;
    gateway.complete = async (task: string, request: Parameters<ModelGateway['complete']>[1]) => {
      calls += 1;
      return inner.complete(task, request);
    };
    const meter = new UsageMeter(sql, new MemoryLedger(), { assetId: 'USDT', windowMinutes: 60 });
    const runtime = new AgentRuntime(sql, gateway, meter, new MemoryEventBus('svc-agents'), {
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
    const { id } = await person.own.create({ template: 'service-starter', createKey: `run:${Math.random()}` });
    await person.own.save({ id, name: 'TEST helper', instructions: INSTRUCTIONS, tools: ['support.kb.search'], perSessionCap: cap });
    return id;
  }

  const holds = async () =>
    (await sql<{ status: string }[]>`SELECT status FROM agents.spend_reservations WHERE user_id = ${USER} ORDER BY created_at`).map(
      (r) => r.status,
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
      TRUNCATE agents.own_agent_limits, agents.own_agents, agents.spend_reservations, agents.user_spend_limits, agents.think_claims,
               agents.usage_records, agents.usage_windows, agents.agent_actions, agents.agent_sessions
      RESTART IDENTITY CASCADE
    `;
    balance = 100n * 10n ** 18n;
    calls = 0;
    delayMs = 0;
  });

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  describe('own agent limits', () => {
    it('reads no limits until set; stores all three and the lower of the person’s per-session value and the agent’s cap applies', async () => {
      const { person } = people();
      const id = await agentWith(person, '1');
      expect(await person.own.limits.get({ id })).toEqual({
        limits: null,
        agentCap: '1',
        effectivePerSession: null,
        overageGrace: null,
        assetId: 'USDT',
      });
      const set = await person.own.limits.set({ id, perCall: '0.012', perSession: '0.02', perPeriod: '5' });
      expect(set).toEqual({
        limits: { perCall: '0.012', perSession: '0.02', perPeriod: '5', period: 'month' },
        agentCap: '1',
        effectivePerSession: '0.02',
        overageGrace: null,
        assetId: 'USDT',
      });
      // Saving the same values again is the same row.
      expect(await person.own.limits.set({ id, perCall: '0.012', perSession: '0.02', perPeriod: '5' })).toEqual(set);
      expect(await person.own.limits.get({ id })).toEqual(set);
      // The agent's own cap lowered below the person's value: the lower one applies.
      await person.own.save({ id, name: 'TEST helper', instructions: INSTRUCTIONS, tools: [], perSessionCap: '0.015' });
      expect((await person.own.limits.get({ id })).effectivePerSession).toBe('0.015');
    });

    it('refuses a blank, an invalid and an above-cap value with their codes, and the stored caps are unchanged', async () => {
      const { person } = people();
      const id = await agentWith(person, '1');
      const stored = await person.own.limits.set({ id, perCall: '0.012', perSession: '0.02', perPeriod: '5' });
      await expect(person.own.limits.set({ id, perCall: ' ', perSession: '0.02', perPeriod: '5' })).rejects.toMatchObject({
        message: 'agents.spend.cap_unset',
      });
      await expect(person.own.limits.set({ id, perCall: '0.012', perSession: null, perPeriod: '5' })).rejects.toMatchObject({
        message: 'agents.spend.cap_unset',
      });
      await expect(person.own.limits.set({ id, perCall: '0.012', perSession: '0.02', perPeriod: 'lots' })).rejects.toMatchObject({
        message: 'agents.own.cap_invalid',
      });
      await expect(person.own.limits.set({ id, perCall: '-1', perSession: '0.02', perPeriod: '5' })).rejects.toMatchObject({
        message: 'agents.own.cap_invalid',
      });
      await expect(person.own.limits.set({ id, perCall: '0.012', perSession: '3', perPeriod: '5' })).rejects.toMatchObject({
        message: 'agents.spend.above_agent_cap',
      });
      await expect(person.own.limits.set({ id, perCall: '2', perSession: '0.02', perPeriod: '5' })).rejects.toMatchObject({
        message: 'agents.spend.above_agent_cap',
      });
      await expect(person.own.limits.set({ id, perCall: '0.03', perSession: '0.02', perPeriod: '5' })).rejects.toMatchObject({
        message: 'agents.spend.per_call_above_session',
      });
      expect(await person.own.limits.get({ id })).toEqual(stored);
    });

    it('refuses limits for an agent with no cap of its own, and another person’s agent reads as not found', async () => {
      const { person, other } = people();
      const capless = await agentWith(person, null);
      await expect(person.own.limits.set({ id: capless, perCall: '0.01', perSession: '0.02', perPeriod: '5' })).rejects.toMatchObject({
        message: 'agents.spend.cap_unset',
      });
      expect((await person.own.limits.get({ id: capless })).limits).toBeNull();
      const id = await agentWith(person, '1');
      await expect(other.own.limits.get({ id })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'agents.own.not_found' });
      await expect(other.own.limits.set({ id, perCall: '0.01', perSession: '0.02', perPeriod: '5' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect((await person.own.limits.get({ id })).limits).toBeNull();
    });
  });

  describe('own agent sessions and runs', () => {
    it('refuses a session while no cap is stored, and no session or run exists', async () => {
      const { person } = people();
      const id = await agentWith(person, '1');
      await expect(person.own.session.open({ id })).rejects.toMatchObject({ message: 'agents.spend.cap_unset' });
      const capless = await agentWith(person, null);
      await expect(person.own.session.open({ id: capless })).rejects.toMatchObject({ message: 'agents.spend.cap_unset' });
      expect(await ownSessions()).toBe(0);
      expect(await person.own.runs({ id, limit: 10 })).toEqual([]);
    });

    it('opens only for the person with agents:execute, and binds the agent’s tools and the run task', async () => {
      const router = build();
      const reader = router.createCaller(callerFor(USER, ['agents:read', 'identity:write']));
      const { person } = people();
      const id = await agentWith(person, '1');
      await person.own.limits.set({ id, perCall: '0.012', perSession: '0.02', perPeriod: '5' });
      await expect(reader.own.session.open({ id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const opened = await person.own.session.open({ id });
      expect(opened.agentId).toBe(`own.${id}`);
      const [row] = await sql<
        { guardrail: { tools: Array<{ name: string; mode: string }>; limits: { allowedTasks: string[]; maxSpendPerSession: string } } }[]
      >`
        SELECT guardrail FROM agents.agent_sessions WHERE id = ${opened.sessionId}
      `;
      expect(row!.guardrail.tools.map((t) => [t.name, t.mode])).toEqual([['support.kb.search', 'read']]);
      expect(row!.guardrail.limits.allowedTasks).toEqual([OWN_RUN_TASK]);
      expect(row!.guardrail.limits.maxSpendPerSession).toBe('1');
    });

    it('admits a run under the caps with its exact cost; the same request id twice is one run and one charge', async () => {
      const { person } = people();
      const id = await agentWith(person, '1');
      await person.own.limits.set({ id, perCall: '0.012', perSession: '0.02', perPeriod: '5' });
      const { sessionId } = await person.own.session.open({ id });
      const ran = await person.own.run({ id, sessionId, requestId: 'own-run-1', ask: ASK });
      expect(ran.assetId).toBe('USDT');
      expect(parseAmount(ran.cost)).toBeGreaterThan(0n);
      expect(parseAmount(ran.cost)).toBeLessThanOrEqual(WORST);
      await expect(person.own.run({ id, sessionId, requestId: 'own-run-1', ask: ASK })).rejects.toMatchObject({
        message: 'agents.request_id_replay',
      });
      expect(calls).toBe(1);
      expect(await holds()).toEqual(['committed']);
      const runs = await person.own.runs({ id, limit: 10 });
      const executed = runs.filter((r) => r.status === 'executed');
      expect(executed).toHaveLength(1);
      expect(executed[0]!.cost).toBe(ran.cost);
    });

    it('refuses a run whose worst case passes the per-call cap before the engine: bills 0, holds nothing', async () => {
      const { person } = people();
      const id = await agentWith(person, '1');
      await person.own.limits.set({ id, perCall: formatAmount(WORST - 1n), perSession: '0.02', perPeriod: '5' });
      const { sessionId } = await person.own.session.open({ id });
      await expect(person.own.run({ id, sessionId, requestId: 'own-call', ask: ASK })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'agents.spend.cap_exceeded',
      });
      expect(calls).toBe(0);
      expect(await holds()).toEqual([]);
      expect(await person.own.runs({ id, limit: 10 })).toEqual([
        expect.objectContaining({ status: 'refused', refusalCode: 'agents.spend.cap_exceeded', cost: '0' }),
      ]);
    });

    it('two runs at once whose worst cases together pass the per-session cap: exactly one is admitted, the other bills 0', async () => {
      delayMs = 300;
      const { person } = people();
      const id = await agentWith(person, '1');
      await person.own.limits.set({ id, perCall: '0.012', perSession: formatAmount(WORST + WORST / 2n), perPeriod: '5' });
      const { sessionId } = await person.own.session.open({ id });
      const results = await Promise.allSettled([
        person.own.run({ id, sessionId, requestId: 'own-pair-a', ask: ASK }),
        person.own.run({ id, sessionId, requestId: 'own-pair-b', ask: ASK }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
      expect(refused.reason).toMatchObject({ message: 'agents.spend.cap_exceeded' });
      expect(calls).toBe(1);
      expect(await holds()).toEqual(['committed']);
      const runs = await person.own.runs({ id, limit: 10 });
      expect(runs.map((r) => r.status).sort()).toEqual(['executed', 'refused']);
      expect(runs.find((r) => r.status === 'refused')).toMatchObject({ refusalCode: 'agents.spend.cap_exceeded', cost: '0' });
    });

    it('counts every session of the agent this month against the per-month cap', async () => {
      const { person } = people();
      const id = await agentWith(person, '1');
      await person.own.limits.set({ id, perCall: '0.012', perSession: '0.02', perPeriod: '5' });
      const first = await person.own.session.open({ id });
      await person.own.run({ id, sessionId: first.sessionId, requestId: 'own-month-1', ask: ASK });
      const [spent] = await sql<
        { total: string }[]
      >`SELECT committed_amount::text AS total FROM agents.spend_reservations WHERE reservation_key = 'own-month-1'`;
      const used = parseAmount(spent!.total);
      expect(used).toBeGreaterThan(0n);
      // A fresh session has spent nothing, so one worst case fits the month only if the first session is not counted.
      const second = await person.own.session.open({ id });
      await person.own.limits.set({ id, perCall: '0.012', perSession: '0.02', perPeriod: formatAmount(used + WORST - 1n) });
      await expect(person.own.run({ id, sessionId: second.sessionId, requestId: 'own-month-2', ask: ASK })).rejects.toMatchObject({
        message: 'agents.spend.cap_exceeded',
      });
      expect(calls).toBe(1);
      expect(await holds()).toEqual(['committed']);
      await person.own.limits.set({ id, perCall: '0.012', perSession: '0.02', perPeriod: formatAmount(used + WORST) });
      await person.own.run({ id, sessionId: second.sessionId, requestId: 'own-month-3', ask: ASK });
      expect(calls).toBe(2);
    });

    it('applies the agent’s cap as it stands at run time, below the person’s per-session value', async () => {
      const { person } = people();
      const id = await agentWith(person, '1');
      await person.own.limits.set({ id, perCall: '0.012', perSession: '0.02', perPeriod: '5' });
      const { sessionId } = await person.own.session.open({ id });
      await person.own.save({
        id,
        name: 'TEST helper',
        instructions: INSTRUCTIONS,
        tools: ['support.kb.search'],
        perSessionCap: formatAmount(WORST - 1n),
      });
      await expect(person.own.run({ id, sessionId, requestId: 'own-live-cap', ask: ASK })).rejects.toMatchObject({
        message: 'agents.spend.cap_exceeded',
      });
      expect(calls).toBe(0);
      expect(await holds()).toEqual([]);
    });

    it('refuses a delegated key: it cannot set limits, open a session or run', async () => {
      const { person, key } = people();
      const id = await agentWith(person, '1');
      await expect(key.own.limits.set({ id, perCall: '0.012', perSession: '0.02', perPeriod: '5' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'A signed-in user session is required',
      });
      expect(await person.own.limits.get({ id })).toMatchObject({ limits: null });
      await person.own.limits.set({ id, perCall: '0.012', perSession: '0.02', perPeriod: '5' });
      await expect(key.own.session.open({ id })).rejects.toMatchObject({ code: 'FORBIDDEN', cause: { code: 'scope.interactive_only' } });
      expect(await ownSessions()).toBe(0);
      const { sessionId } = await person.own.session.open({ id });
      await expect(key.own.run({ id, sessionId, requestId: 'own-key', ask: ASK })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        cause: { code: 'scope.interactive_only' },
      });
      expect(calls).toBe(0);
      expect(await holds()).toEqual([]);
    });

    it('refuses a run the available balance cannot cover: funds insufficient, the engine never called, nothing billed or held', async () => {
      balance = WORST - 1n;
      const { person } = people();
      const id = await agentWith(person, '1');
      await person.own.limits.set({ id, perCall: '0.012', perSession: '0.02', perPeriod: '5' });
      const { sessionId } = await person.own.session.open({ id });
      await expect(person.own.run({ id, sessionId, requestId: 'own-poor', ask: ASK })).rejects.toMatchObject({
        message: 'agents.funds_insufficient',
      });
      expect(calls).toBe(0);
      expect(await holds()).toEqual([]);
      expect(await person.own.runs({ id, limit: 10 })).toEqual([
        expect.objectContaining({ status: 'refused', refusalCode: 'agents.funds_insufficient', cost: '0' }),
      ]);
    });

    it('refuses a run once the caps are cleared from under an open session', async () => {
      const { person } = people();
      const id = await agentWith(person, '1');
      await person.own.limits.set({ id, perCall: '0.012', perSession: '0.02', perPeriod: '5' });
      const { sessionId } = await person.own.session.open({ id });
      await sql`DELETE FROM agents.own_agent_limits WHERE agent_id = ${id}`;
      await expect(person.own.run({ id, sessionId, requestId: 'own-cleared', ask: ASK })).rejects.toMatchObject({
        message: 'agents.spend.cap_unset',
      });
      expect(calls).toBe(0);
      expect(await holds()).toEqual([]);
    });

    it('refuses another person’s session, a session of another agent, and a closed session', async () => {
      const { person, other } = people();
      const id = await agentWith(person, '1');
      const otherAgent = await agentWith(person, '1');
      await person.own.limits.set({ id, perCall: '0.012', perSession: '0.02', perPeriod: '5' });
      const { sessionId } = await person.own.session.open({ id });
      await expect(other.own.run({ id, sessionId, requestId: 'own-theirs', ask: ASK })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(person.own.run({ id: otherAgent, sessionId, requestId: 'own-mixed', ask: ASK })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'agents.session_not_found',
      });
      await sql`UPDATE agents.agent_sessions SET status = 'closed', closed_at = now() WHERE id = ${sessionId}`;
      await expect(person.own.run({ id, sessionId, requestId: 'own-closed', ask: ASK })).rejects.toMatchObject({
        message: 'agents.session_closed',
      });
      expect(calls).toBe(0);
      expect(await holds()).toEqual([]);
    });
  });
}
