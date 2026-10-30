import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { houseFees, MemoryLedger, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { render } from '../copy.js';
import { ModelGateway } from '../gateway/gateway.js';
import { parseRoutingTable, unpricedTable } from '../gateway/routing.js';
import { UsageMeter } from '../metering/meter.js';
import { MockModelProvider } from '../providers/mock.js';
import { createAgentsRouter } from '../router.js';
import { AgentRuntime, RefusedError } from '../runtime.js';
import { UserSpendStore } from '../spend/store.js';
import { OWN_RUN_TASK } from './routes.js';

/**
 * Usage by agent, day and task (J-agents-02 #7), through the service's own routes on real Postgres and a ledger that
 * holds real balances: each row is the exact sum of the sealed windows it covers, per agent and only the person's own;
 * and a blank rate refuses the run with the rate named, before the engine, so nothing runs free.
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
const SECRET = 'an-agents-own-usage-day-test-secret-of-32-plus-chars!';
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
    id: 'req-own-usage-day',
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

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('own agent usage by day (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 6,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-own-usage-day-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');
  let lockConn: Awaited<ReturnType<typeof sql.reserve>>;

  let ledger: MemoryLedger;
  let calls: number;
  let table: typeof TABLE;

  function build() {
    const provider = new MockModelProvider({ id: 'primary' });
    const inner = new ModelGateway([provider], table);
    const gateway = Object.create(inner) as ModelGateway;
    gateway.complete = async (task: string, request: Parameters<ModelGateway['complete']>[1]) => {
      calls += 1;
      return inner.complete(task, request);
    };
    const meter = new UsageMeter(sql, ledger, { assetId: 'USDT', windowMinutes: 60 });
    const runtime = new AgentRuntime(sql, gateway, meter, new MemoryEventBus('svc-agents'), {
      feeAssetId: 'USDT',
      meteringEnabled: true,
      spend: new UserSpendStore(sql),
      funds: { available: async (userId, assetId) => (await ledger.balance(userAvailable(userId, assetId))).amount },
    });
    return createAgentsRouter({ runtime, gateway, meter, feeAssetId: 'USDT', sql });
  }

  const units = (amount: string) => parseAmount(amount);
  const balanceOf = async (userId = USER) => (await ledger.balance(userAvailable(userId, 'USDT'))).amount;
  const houseFeesNow = async () => (await ledger.balance(houseFees('agents', 'USDT'))).amount;
  const sum = (amounts: readonly string[]) => amounts.reduce((total, amount) => total + units(amount), 0n);

  async function fund(userId: string) {
    await ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount: units('1'), rail: 'test', railRef: `own-usage-day:${userId}` }));
  }

  /** Builds one of the person's agents with caps. */
  async function agentOf(userId: string, name: string) {
    const person = build().createCaller(callerFor(userId, PERSON));
    const { id } = await person.own.create({ template: 'service-starter', createKey: `usage-day:${userId}:${name}` });
    await person.own.save({ id, name, instructions: 'Answer TEST questions.', tools: ['support.kb.search'], perSessionCap: '1' });
    await person.own.limits.set({ id, perCall: '0.012', perSession: '0.5', perPeriod: '5' });
    return { person, id };
  }

  /** Opens a session of the agent, runs it `runs` times and, unless told not to, closes it so its window seals. */
  async function session(userId: string, id: string, runs: number, close = true) {
    const person = build().createCaller(callerFor(userId, PERSON));
    const { sessionId } = await person.own.session.open({ id });
    for (let n = 0; n < runs; n += 1) await person.own.run({ id, sessionId, requestId: `${sessionId}:run-${n}`, ask: ASK });
    if (close) await person.own.session.close({ id, sessionId });
    return sessionId;
  }

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
    ledger = new MemoryLedger();
    calls = 0;
    table = TABLE;
  });

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  describe('usage by agent, day and task', () => {
    it("gives each agent's rows the exact sum of its sealed windows, by UTC day and task, for every agent the person built", async () => {
      await fund(USER);
      const first = await agentOf(USER, 'TEST first');
      const second = await agentOf(USER, 'TEST second');
      await session(USER, first.id, 2);
      await session(USER, first.id, 1);
      await session(USER, second.id, 1);

      const rows = await first.person.own.usageByDay();
      expect(new Set(rows.map((row) => row.agentId))).toEqual(new Set([first.id, second.id]));
      for (const agent of [first, second]) {
        const windows = await agent.person.own.usage({ id: agent.id, limit: 50 });
        const mine = rows.filter((row) => row.agentId === agent.id);
        expect(windows.every((w) => w.state === 'settled')).toBe(true);
        expect(sum(mine.map((row) => row.amount))).toBe(sum(windows.map((w) => w.amount!)));
        expect(mine.reduce((total, row) => total + row.windows, 0)).toBe(windows.length);
        for (const row of mine) {
          expect(row).toMatchObject({ task: OWN_RUN_TASK, assetId: 'USDT' });
          expect(windows.some((w) => w.windowId.startsWith(row.day))).toBe(true);
        }
      }
      expect(rows.find((row) => row.agentId === second.id)).toMatchObject({ agentName: 'TEST second', windows: 1 });
      // What the rows add up to is what the ledger charged, no more and no less.
      expect(sum(rows.map((row) => row.amount))).toBe(await houseFeesNow());
      expect(await balanceOf()).toBe(units('1') - (await houseFeesNow()));
    });

    it('leaves out a window that is still open: it has no amount until it seals', async () => {
      await fund(USER);
      const { person, id } = await agentOf(USER, 'TEST open');
      await session(USER, id, 1, false);
      expect(await person.own.usageByDay()).toEqual([]);
      expect((await person.own.usage({ id, limit: 10 }))[0]).toMatchObject({ state: 'open', amount: null });
    });

    it('counts a sealed window the ledger could not charge at its sealed amount, apart from what the ledger took', async () => {
      await fund(USER);
      const paid = await agentOf(USER, 'TEST paid');
      await session(USER, paid.id, 1);
      const charged = await houseFeesNow();
      expect(charged).toBeGreaterThan(0n);

      const owes = await agentOf(USER, 'TEST owes');
      const sessionId = await session(USER, owes.id, 1, false);
      const [open] = await owes.person.own.usage({ id: owes.id, limit: 10 });
      // The person holds all but a sliver for a TEST withdrawal, so the close cannot charge the window.
      const hold = { userId: USER, assetId: 'USDT', amount: (await balanceOf()) - 1n, rail: 'test', withdrawalId: 'usage-day-w1' };
      await ledger.post(recipes.withdrawHold(hold));
      await expect(owes.person.own.session.close({ id: owes.id, sessionId })).rejects.toMatchObject({ message: 'agents.window_unpaid' });
      const [unpaid] = await owes.person.own.usage({ id: owes.id, limit: 10 });
      expect(unpaid).toMatchObject({ windowId: open!.windowId, state: 'unpaid' });

      const rows = await owes.person.own.usageByDay();
      const owed = rows.filter((row) => row.agentId === owes.id);
      expect(owed).toHaveLength(1);
      expect(owed[0]).toMatchObject({ windows: 1, amount: unpaid!.amount, assetId: 'USDT' });
      // The house took only the paid agent's window; the unpaid one is owed, not charged.
      expect(await houseFeesNow()).toBe(charged);
      expect(sum(rows.filter((row) => row.agentId === paid.id).map((row) => row.amount))).toBe(charged);
    });

    it("never shows another person's usage", async () => {
      await fund(USER);
      await fund(OTHER);
      const mine = await agentOf(USER, 'TEST mine');
      const theirs = await agentOf(OTHER, 'TEST theirs');
      await session(USER, mine.id, 1);
      await session(OTHER, theirs.id, 1);
      expect((await mine.person.own.usageByDay()).map((row) => row.agentId)).toEqual([mine.id]);
      expect((await theirs.person.own.usageByDay()).map((row) => row.agentId)).toEqual([theirs.id]);
    });

    it('answers only the signed-in person, never a key', async () => {
      const key = build().createCaller(callerFor(USER, PERSON, { kid: 'key-1' }));
      await expect(key.own.usageByDay()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('a blank rate', () => {
    it('refuses the run with the rate named, before the engine; nothing is charged and nothing runs free', async () => {
      await fund(USER);
      table = unpricedTable(TABLE);
      const { person, id } = await agentOf(USER, 'TEST unpriced');
      const { sessionId } = await person.own.session.open({ id });
      const before = await balanceOf();

      const err = await person.own.run({ id, sessionId, requestId: 'blank-rate-1', ask: ASK }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'FORBIDDEN', message: 'agents.price_unset' });
      const refusal = ((err as { cause?: unknown }).cause as RefusedError).refusal;
      // The customer room's refusal copy names this task as `own.run` (agent-builder-copy.ts); it stays that name.
      expect(OWN_RUN_TASK).toBe('own.run');
      expect(refusal.userMessageParams).toEqual({ task: OWN_RUN_TASK });
      expect(render(refusal.userMessageKey as Parameters<typeof render>[0], refusal.userMessageParams)).toContain(`“${OWN_RUN_TASK}”`);
      expect(calls).toBe(0);

      expect(await person.own.runs({ id, limit: 10 })).toEqual([
        expect.objectContaining({ status: 'refused', refusalCode: 'agents.price_unset', cost: '0' }),
      ]);
      await person.own.session.close({ id, sessionId });
      expect(await person.own.usageByDay()).toEqual([]);
      expect(await balanceOf()).toBe(before);
      expect(await houseFeesNow()).toBe(0n);
    });
  });
}
