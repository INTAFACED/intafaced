import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import {
  formatAmount,
  houseFees,
  InsufficientFundsError,
  LedgerError,
  MemoryLedger,
  parseAmount,
  recipes,
  userAvailable,
  type Amount,
} from '@intafaced/ledger-client';
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
 * A usage window the ledger could not charge (J-agents-02 #5), through the service's own routes on real Postgres and a
 * ledger that holds real balances: the session stays open with the window unpaid on its charge key; the next run is
 * refused before the engine unless the owner's overage grace covers what is owed (blank grace never does); and once
 * funds are back the window is retried on that same key and charged once.
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
const SECRET = 'an-agents-own-unpaid-test-secret-of-32-plus-chars!';
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
    id: 'req-own-unpaid',
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
  describe.skip('own agent unpaid windows (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 6,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-own-unpaid-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');
  let lockConn: Awaited<ReturnType<typeof sql.reserve>>;

  let ledger: MemoryLedger;
  /** When set, the ledger fails every fee charge with this fault (a ledger that is down, not one refusing for funds). */
  let chargeFault: Error | null;
  let grace: Amount | null;
  let calls: number;

  function build() {
    const provider = new MockModelProvider({ id: 'primary' });
    const inner = new ModelGateway([provider], TABLE);
    const gateway = Object.create(inner) as ModelGateway;
    gateway.complete = async (task: string, request: Parameters<ModelGateway['complete']>[1]) => {
      calls += 1;
      return inner.complete(task, request);
    };
    const book = Object.create(ledger) as MemoryLedger;
    book.post = async (request) => {
      if (chargeFault && request.idempotencyKey.startsWith('fee:agents:')) throw chargeFault;
      return ledger.post(request);
    };
    const meter = new UsageMeter(sql, book, { assetId: 'USDT', windowMinutes: 60 });
    const runtime = new AgentRuntime(sql, gateway, meter, new MemoryEventBus('svc-agents'), {
      feeAssetId: 'USDT',
      meteringEnabled: true,
      spend: new UserSpendStore(sql),
      funds: { available: async (userId, assetId) => (await ledger.balance(userAvailable(userId, assetId))).amount },
      overageGrace: grace,
    });
    return createAgentsRouter({ runtime, gateway, meter, feeAssetId: 'USDT', sql });
  }

  const units = (amount: string) => parseAmount(amount);
  const balanceOf = async () => (await ledger.balance(userAvailable(USER, 'USDT'))).amount;
  const houseFeesNow = async () => (await ledger.balance(houseFees('agents', 'USDT'))).amount;
  const holds = async () =>
    (await sql<{ status: string }[]>`SELECT status FROM agents.spend_reservations WHERE user_id = ${USER} ORDER BY created_at`).map(
      (r) => r.status,
    );
  const sessionStatus = async (id: string) =>
    (await sql<{ status: string }[]>`SELECT status FROM agents.agent_sessions WHERE id = ${id}`)[0]!.status;

  /** Funds the person, builds their agent with caps, opens a session and runs it once. Returns what one run cost. */
  async function ranOnce(fundWith = '1') {
    await ledger.post(
      recipes.deposit({ userId: USER, assetId: 'USDT', amount: units(fundWith), rail: 'test', railRef: `own-unpaid:${Math.random()}` }),
    );
    const person = build().createCaller(callerFor(USER, PERSON));
    const { id } = await person.own.create({ template: 'service-starter', createKey: `unpaid:${Math.random()}` });
    await person.own.save({ id, name: 'TEST helper', instructions: INSTRUCTIONS, tools: ['support.kb.search'], perSessionCap: '1' });
    await person.own.limits.set({ id, perCall: '0.012', perSession: '0.5', perPeriod: '5' });
    const { sessionId } = await person.own.session.open({ id });
    const ran = await person.own.run({ id, sessionId, requestId: 'unpaid-run-1', ask: ASK });
    return { person, id, sessionId, cost: units(ran.cost) };
  }

  /** Holds all but `leave` of the person's available balance for a TEST withdrawal, through the ledger's own recipe. */
  async function withdrawAllBut(leave: Amount) {
    const hold = { userId: USER, assetId: 'USDT', amount: (await balanceOf()) - leave, rail: 'test', withdrawalId: 'unpaid-w1' };
    await ledger.post(recipes.withdrawHold(hold));
    return () => ledger.post(recipes.withdrawReverse(hold));
  }

  /** Closes the session while the person cannot pay its window: the close is refused and the window stays unpaid. */
  async function closeUnpaid(person: Awaited<ReturnType<typeof ranOnce>>['person'], id: string, sessionId: string, cost: Amount) {
    const giveBack = await withdrawAllBut(cost - 1n);
    await expect(person.own.session.close({ id, sessionId })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'agents.window_unpaid',
    });
    return giveBack;
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
    chargeFault = null;
    grace = null;
    calls = 0;
  });

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  describe('a usage window the ledger could not charge', () => {
    it('keeps the session open and the window unpaid on its charge key; nothing moves', async () => {
      const { person, id, sessionId, cost } = await ranOnce();
      await closeUnpaid(person, id, sessionId, cost);
      expect(await sessionStatus(sessionId)).toBe('open');
      const [window] = await person.own.usage({ id, limit: 10 });
      expect(window).toMatchObject({ sessionId, state: 'unpaid', amount: formatAmount(cost), assetId: 'USDT' });
      expect(window!.chargeKey).toBe(`agent.usage:${sessionId}:${window!.windowId}`);
      expect(await ledger.getTxByKey(`fee:agents:${window!.chargeKey}`)).toBeNull();
      expect(await balanceOf()).toBe(cost - 1n);
      expect(await houseFeesNow()).toBe(0n);
    });

    it('with the grace blank, the next run refuses agents.overage_grace_unset before the engine: no claim, no hold, bills 0', async () => {
      const { person, id, sessionId, cost } = await ranOnce();
      // The Limits page reads the grace as blank: it is not set, and none is assumed.
      expect((await person.own.limits.get({ id })).overageGrace).toBeNull();
      await closeUnpaid(person, id, sessionId, cost);
      const before = await holds();
      const { sessionId: next } = await person.own.session.open({ id });
      await expect(person.own.run({ id, sessionId: next, requestId: 'unpaid-run-2', ask: ASK })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'agents.overage_grace_unset',
      });
      expect(calls).toBe(1);
      expect(await holds()).toEqual(before);
      expect(await sql`SELECT 1 FROM agents.think_claims WHERE session_id = ${next}`).toHaveLength(0);
      const [refused] = await person.own.runs({ id, limit: 1 });
      expect(refused).toMatchObject({ sessionId: next, status: 'refused', refusalCode: 'agents.overage_grace_unset', cost: '0' });
      // The refusal names what is owed; the retry it made was refused for funds, so nothing moved.
      const [row] = await sql<{ params: Record<string, string> }[]>`
        SELECT user_message_params AS params FROM agents.agent_actions WHERE session_id = ${next} AND status = 'refused'
      `;
      expect(row!.params).toEqual({ owed: formatAmount(cost), asset: 'USDT' });
      expect(await balanceOf()).toBe(cost - 1n);
      expect(await houseFeesNow()).toBe(0n);
    });

    it('with funds back, the next run retries the window on its same charge key first, charges it once, then runs', async () => {
      const { person, id, sessionId, cost } = await ranOnce();
      const giveBack = await closeUnpaid(person, id, sessionId, cost);
      const [unpaid] = await person.own.usage({ id, limit: 10 });
      await giveBack();
      const funded = await balanceOf();
      const { sessionId: next } = await person.own.session.open({ id });
      const ran = await person.own.run({ id, sessionId: next, requestId: 'unpaid-run-2', ask: ASK });
      expect(calls).toBe(2);
      const charge = await ledger.getTxByKey(`fee:agents:${unpaid!.chargeKey}`);
      expect(charge).not.toBeNull();
      expect(await balanceOf()).toBe(funded - cost);
      expect(await houseFeesNow()).toBe(cost);
      const windows = await person.own.usage({ id, limit: 10 });
      expect(windows.find((w) => w.sessionId === sessionId)).toMatchObject({ state: 'settled', chargeKey: unpaid!.chargeKey });
      // Closing both sessions charges the new run's window, and nothing of the first again.
      await person.own.session.close({ id, sessionId });
      await person.own.session.close({ id, sessionId: next });
      expect(await balanceOf()).toBe(funded - cost - units(ran.cost));
      expect(await houseFeesNow()).toBe(cost + units(ran.cost));
      expect(await sessionStatus(sessionId)).toBe('closed');
    });

    it('with funds back, closing again retries on the same charge key and closes; a third close charges nothing more', async () => {
      const { person, id, sessionId, cost } = await ranOnce();
      const giveBack = await closeUnpaid(person, id, sessionId, cost);
      await giveBack();
      const funded = await balanceOf();
      const closed = await person.own.session.close({ id, sessionId });
      expect(closed).toMatchObject({ sessionId, status: 'closed' });
      expect(await balanceOf()).toBe(funded - cost);
      await expect(person.own.session.close({ id, sessionId })).resolves.toMatchObject({ status: 'closed' });
      expect(await balanceOf()).toBe(funded - cost);
      expect(await houseFeesNow()).toBe(cost);
    });

    it('with a grace that covers what is owed, the next run is admitted and the window stays unpaid', async () => {
      const { person, id, sessionId, cost } = await ranOnce();
      grace = cost;
      const giveBack = await closeUnpaid(person, id, sessionId, cost);
      // Funds back for the new run's worst case, while the ledger still refuses the old window's charge for funds (as it
      // would for a balance that covers a worst case but not that window): the grace is what admits the run.
      await giveBack();
      chargeFault = new InsufficientFundsError('', 'USDT', formatAmount(cost), '0');
      const graced = build().createCaller(callerFor(USER, PERSON));
      const { sessionId: next } = await graced.own.session.open({ id });
      await expect(graced.own.run({ id, sessionId: next, requestId: 'unpaid-run-2', ask: ASK })).resolves.toMatchObject({
        assetId: 'USDT',
      });
      expect(calls).toBe(2);
      expect((await graced.own.usage({ id, limit: 10 })).find((w) => w.sessionId === sessionId)).toMatchObject({ state: 'unpaid' });
      expect(await houseFeesNow()).toBe(0n);
    });

    it('with a grace below what is owed, the next run refuses agents.window_unpaid naming what is owed and the grace', async () => {
      const { person, id, sessionId, cost } = await ranOnce();
      grace = cost - 1n;
      await closeUnpaid(person, id, sessionId, cost);
      const graced = build().createCaller(callerFor(USER, PERSON));
      expect((await graced.own.limits.get({ id })).overageGrace).toBe(formatAmount(cost - 1n));
      const { sessionId: next } = await graced.own.session.open({ id });
      await expect(graced.own.run({ id, sessionId: next, requestId: 'unpaid-run-2', ask: ASK })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'agents.window_unpaid',
      });
      expect(calls).toBe(1);
      const [row] = await sql<{ params: Record<string, string> }[]>`
        SELECT user_message_params AS params FROM agents.agent_actions WHERE session_id = ${next} AND status = 'refused'
      `;
      expect(row!.params).toEqual({ owed: formatAmount(cost), grace: formatAmount(cost - 1n), asset: 'USDT' });
    });

    it('a ledger fault other than funds on the retry is thrown: no run starts and the window is not counted as paid', async () => {
      const { person, id, sessionId, cost } = await ranOnce();
      const giveBack = await closeUnpaid(person, id, sessionId, cost);
      await giveBack();
      chargeFault = new LedgerError('TEST ledger down', 'ledger.unavailable');
      const faulty = build().createCaller(callerFor(USER, PERSON));
      const { sessionId: next } = await faulty.own.session.open({ id });
      await expect(faulty.own.run({ id, sessionId: next, requestId: 'unpaid-run-2', ask: ASK })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
      expect(calls).toBe(1);
      expect((await faulty.own.usage({ id, limit: 10 })).find((w) => w.sessionId === sessionId)).toMatchObject({ state: 'unpaid' });
      expect(await houseFeesNow()).toBe(0n);
    });

    it('a run in a session whose current window is sealed refuses agents.window_sealed before the engine', async () => {
      const { person, id, sessionId, cost } = await ranOnce();
      grace = cost;
      await closeUnpaid(person, id, sessionId, cost);
      const graced = build().createCaller(callerFor(USER, PERSON));
      await expect(graced.own.run({ id, sessionId, requestId: 'unpaid-run-2', ask: ASK })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'agents.window_sealed',
      });
      expect(calls).toBe(1);
      expect(await sql`SELECT 1 FROM agents.think_claims WHERE session_id = ${sessionId} AND request_id = 'unpaid-run-2'`).toHaveLength(0);
    });
  });
}
