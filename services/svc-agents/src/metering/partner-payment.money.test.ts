import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import {
  MemoryLedger,
  chargeReceivable,
  formatAmount,
  houseFees,
  parseAmount,
  partnerReserve,
  recipes,
  userAvailable,
  type Amount,
} from '@intafaced/ledger-client';
import type { AgentsUsagePaymentCollect, AgentsUsagePaymentRead } from '@intafaced/contracts';
import { ModelGateway } from '../gateway/gateway.js';
import { parseRoutingTable } from '../gateway/routing.js';
import { MockModelProvider } from '../providers/mock.js';
import { AgentRuntime } from '../runtime.js';
import type { UsagePaymentPort } from '../payment/usage-payment.js';
import { UsageMeter } from './meter.js';

/**
 * J-agents-01, the launch money model (OWNER 226; docs/adr/2026-11-10-launch-money-model.md): a sealed usage window of a
 * person whose money their partner holds is earned once in our ledger as owed by them, paid once by their partner under
 * the window's key, and collected once against the partner's payment id. Nothing touches a customer balance in our
 * book. A refusal leaves it owed; a crash after any step resumes to the same amount and the same keys.
 */
const URL = process.env.TEST_DATABASE_URL_AGENTS ?? 'postgres://svc_agents:svc_agents@localhost:5433/intafaced_test';
const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const USER = '33333333-3333-4333-8333-333333333333';
const BUSINESS = '44444444-4444-4444-8444-444444444444';
const ASSET = 'USDT';
const TABLE = parseRoutingTable({
  routes: [
    {
      task: 'plan',
      providerId: 'primary',
      model: 'reasoning-lg',
      maxOutputTokens: 256,
      price: { inputPerMillion: '3', outputPerMillion: '15' },
    },
  ],
});
const AGENT = {
  agentId: 'probe-pay',
  version: 1,
  capacityMode: 'confirm_each',
  tools: [],
  limits: { maxActionsPerSession: 20, maxOutputTokensPerCall: 256, maxSpendPerSession: null, allowedModules: [], allowedTasks: ['plan'] },
};
const MESSAGES = [{ role: 'user' as const, content: 'TEST' }];

/** A stand-in for svc-bank's door over the TEST partner: one payment per key, with switches for its refusals. */
function partnerDoor(start: Amount) {
  let balance = start;
  const payments = new Map<string, { id: string; amount: Amount }>();
  const state = {
    heldBy: 'partner' as AgentsUsagePaymentRead['heldBy'],
    refuse: null as Extract<AgentsUsagePaymentCollect, { ok: false }>['reason'] | null,
    loseNextReply: false,
    readFails: false,
    collects: 0,
    /** The business each read and collect named, in order (undefined: the person pays). */
    businesses: [] as Array<string | undefined>,
  };
  const port: UsagePaymentPort = {
    async read(_userId, _assetId, businessId) {
      state.businesses.push(businessId);
      if (state.readFails) throw new Error('svc-bank did not answer');
      return state.heldBy === 'partner'
        ? { heldBy: 'partner', label: 'TEST partner bank', available: formatAmount(balance), asOf: new Date().toISOString() }
        : { heldBy: state.heldBy };
    },
    async collect({ amount, chargeKey, businessId }) {
      state.collects += 1;
      state.businesses.push(businessId);
      const prior = payments.get(chargeKey);
      if (!prior) {
        if (state.refuse) return { ok: false, reason: state.refuse };
        if (balance < amount) return { ok: false, reason: 'insufficient_funds' };
        balance -= amount;
        payments.set(chargeKey, { id: `test-partner-move-${payments.size + 1}`, amount });
      }
      if (state.loseNextReply) {
        state.loseNextReply = false;
        return { ok: false, reason: 'reply_lost' };
      }
      const made = payments.get(chargeKey)!;
      return {
        ok: true,
        paymentId: made.id,
        partnerId: 'test',
        label: 'TEST partner bank',
        amount: formatAmount(made.amount),
        paidAt: new Date().toISOString(),
      };
    },
  };
  return { port, state, balance: () => balance, payments };
}

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('svc-agents partner payment (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 4,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-partner-pay-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');
  let lockConn: Awaited<ReturnType<typeof sql.reserve>>;

  describe('a usage window paid by the person’s partner (J-agents-01, launch money model)', () => {
    let ledger: MemoryLedger;
    let door: ReturnType<typeof partnerDoor>;
    let runtime: AgentRuntime;
    let meter: UsageMeter;
    const meterOf = () => meter;

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
        TRUNCATE agents.team_sessions, agents.spend_reservations, agents.spend_limit_requests, agents.user_spend_limits, agents.think_claims, agents.agent_place_intents, agents.usage_records, agents.usage_windows, agents.agent_actions, agents.agent_sessions, agents.agent_definitions
        RESTART IDENTITY CASCADE
      `;
      ledger = new MemoryLedger();
      door = partnerDoor(parseAmount('10'));
      meter = new UsageMeter(sql, ledger, { assetId: ASSET, windowMinutes: 60, payment: door.port });
      runtime = new AgentRuntime(
        sql,
        new ModelGateway([new MockModelProvider({ id: 'primary' })], TABLE),
        meter,
        new MemoryEventBus('svc-agents'),
        {
          feeAssetId: ASSET,
          meteringEnabled: true,
        },
      );
      await runtime.registerAgent(AGENT);
    }, 30_000);

    afterEach(async () => {
      await lockConn`select pg_advisory_unlock(842671)`;
    });

    afterAll(async () => {
      lockConn.release();
      await sql.end({ timeout: 5 });
    });

    const ran = async (requestId = 'r-1') => {
      const session = await runtime.openSession({ userId: USER, agentId: AGENT.agentId });
      const call = await runtime.think({ sessionId: session.id, requestId, task: 'plan', messages: MESSAGES });
      return { session, windowId: call.windowId! };
    };
    const figure = async (ref: Parameters<MemoryLedger['balance']>[0]) => (await ledger.balance(ref)).amount;
    const windowRow = async (sessionId: string) =>
      (
        await sql<Array<{ charge_tx_id: string | null; paid_by: string | null; payment_ref: string | null; payment_label: string | null }>>`
        SELECT charge_tx_id, paid_by, payment_ref, payment_label FROM agents.usage_windows WHERE session_id = ${sessionId}
      `
      )[0]!;

    it('earns once, is paid once by the partner and collected once, however many times it is settled', async () => {
      const { session, windowId } = await ran();
      const first = await runtime.settleWindow(session.id, windowId);
      const again = await runtime.settleWindow(session.id, windowId);
      const amount = first.amount;
      expect(amount > 0n).toBe(true);
      expect(first.settled).toBe(true);
      expect(again.settled).toBe(false);
      expect(again.amount).toBe(amount);

      // The partner moved the window's cost out of the person's balance there, once.
      expect(door.balance()).toBe(parseAmount('10') - amount);
      expect(door.payments.size).toBe(1);
      // Our ledger: revenue up by the cost; what the person owes back to zero; our money at the partner up by the cost.
      expect(await figure(houseFees('agents', ASSET))).toBe(amount);
      expect(await figure(chargeReceivable('agents', USER, ASSET))).toBe(0n);
      expect(await figure(partnerReserve('test', ASSET))).toBe(-amount);
      // No customer balance in our book: the person has nothing here, before or after.
      expect(await figure(userAvailable(USER, ASSET))).toBe(0n);
      // Two posts on two facts: earned, then collected. Nothing else.
      expect(ledger.journal().map((t) => t.reason)).toEqual(['charge.earned', 'charge.collected']);
      expect(ledger.reconcile()).toEqual({ ok: true });

      const row = await windowRow(session.id);
      expect(row).toEqual({
        charge_tx_id: expect.any(String),
        paid_by: 'partner',
        payment_ref: 'test-partner-move-1',
        payment_label: 'TEST partner bank',
      });
    });

    it('a partner refusal leaves the window earned and owed, and the next settle collects it once', async () => {
      const { session, windowId } = await ran();
      door.state.refuse = 'partner_unavailable';
      await expect(runtime.settleWindow(session.id, windowId)).rejects.toMatchObject({
        code: 'agents.window_unpaid',
        reason: 'partner_unavailable',
      });
      const amount = await meterOf().pendingCost(session.id, windowId);
      expect(await figure(chargeReceivable('agents', USER, ASSET))).toBe(-amount);
      expect(door.balance()).toBe(parseAmount('10'));
      expect((await windowRow(session.id)).charge_tx_id).toBeNull();

      door.state.refuse = null;
      const paid = await runtime.settleWindow(session.id, windowId);
      expect(paid.settled).toBe(true);
      expect(door.balance()).toBe(parseAmount('10') - amount);
      expect(await figure(chargeReceivable('agents', USER, ASSET))).toBe(0n);
      expect(ledger.journal().map((t) => t.reason)).toEqual(['charge.earned', 'charge.collected']);
    });

    it('too little at the partner refuses by name and moves nothing; the window stays owed', async () => {
      door = partnerDoor(0n);
      meter = new UsageMeter(sql, ledger, { assetId: ASSET, windowMinutes: 60, payment: door.port });
      runtime = new AgentRuntime(
        sql,
        new ModelGateway([new MockModelProvider({ id: 'primary' })], TABLE),
        meter,
        new MemoryEventBus('svc-agents'),
        {
          feeAssetId: ASSET,
          meteringEnabled: true,
        },
      );
      const { session, windowId } = await ran();
      await expect(runtime.settleWindow(session.id, windowId)).rejects.toMatchObject({
        code: 'agents.window_unpaid',
        reason: 'insufficient_funds',
      });
      expect(door.payments.size).toBe(0);
      expect(ledger.journal().map((t) => t.reason)).toEqual(['charge.earned']);
    });

    it('an owed window counts before the next run and keeps the session open on close, refused agents.window_unpaid', async () => {
      const { session, windowId } = await ran();
      door.state.refuse = 'insufficient_funds';
      await expect(runtime.closeSettled(session.id)).rejects.toMatchObject({ code: 'agents.window_unpaid' });
      const cost = await meter.pendingCost(session.id, windowId);
      expect(await runtime.retryUnpaidWindows(USER)).toBe(cost);
      door.state.refuse = null;
      expect(await runtime.retryUnpaidWindows(USER)).toBe(0n);
      const closed = await runtime.closeSettled(session.id);
      expect(closed.status).toBe('closed');
      expect(door.payments.size).toBe(1);
    });

    it('a lost partner answer is asked again under the same key: one payment, one collect', async () => {
      const { session, windowId } = await ran();
      door.state.loseNextReply = true;
      await expect(runtime.settleWindow(session.id, windowId)).rejects.toMatchObject({
        code: 'agents.window_unpaid',
        reason: 'reply_lost',
      });
      const done = await runtime.settleWindow(session.id, windowId);
      expect(done.settled).toBe(true);
      expect(door.payments.size).toBe(1);
      expect(door.balance()).toBe(parseAmount('10') - done.amount);
      expect(ledger.journal().map((t) => t.reason)).toEqual(['charge.earned', 'charge.collected']);
    });

    it('a crash after the collect posted and before the window recorded it resumes to the same posts, nothing twice', async () => {
      const { session, windowId } = await ran();
      await runtime.settleWindow(session.id, windowId);
      // The state a process death after the collect and before the UPDATE leaves: posted, not recorded.
      await sql`UPDATE agents.usage_windows SET charge_tx_id = NULL, paid_by = NULL, payment_ref = NULL, payment_label = NULL WHERE session_id = ${session.id}`;
      const resumed = await runtime.settleWindow(session.id, windowId);
      expect(resumed.settled).toBe(true);
      expect(door.payments.size).toBe(1);
      expect(ledger.journal().map((t) => t.reason)).toEqual(['charge.earned', 'charge.collected']);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('with no payment method the window is earned and owed, and nothing is asked of a partner', async () => {
      door.state.heldBy = 'none';
      const { session, windowId } = await ran();
      await expect(runtime.settleWindow(session.id, windowId)).rejects.toMatchObject({
        code: 'agents.window_unpaid',
        reason: 'no_payment_method',
      });
      expect(door.state.collects).toBe(0);
      expect(await figure(chargeReceivable('agents', USER, ASSET))).toBe(-(await meterOf().pendingCost(session.id, windowId)));
    });

    it('an unread payment method posts nothing and the window stays sealed and unpaid', async () => {
      const { session, windowId } = await ran();
      door.state.readFails = true;
      await expect(runtime.settleWindow(session.id, windowId)).rejects.toThrow('svc-bank did not answer');
      expect(ledger.journal()).toHaveLength(0);
      expect((await windowRow(session.id)).charge_tx_id).toBeNull();
    });

    it('on the custodial layer the window is the ledger fee charge, as before', async () => {
      door.state.heldBy = 'ledger';
      await ledger.post(
        recipes.deposit({ userId: USER, assetId: ASSET, amount: parseAmount('5'), rail: 'test', railRef: 'partner-pay-test-fund' }),
      );
      const { session, windowId } = await ran();
      const result = await runtime.settleWindow(session.id, windowId);
      expect(result.settled).toBe(true);
      expect(door.state.collects).toBe(0);
      expect(
        ledger
          .journal()
          .map((t) => t.reason)
          .slice(1),
      ).toEqual(['agents.usage.metered']);
      expect((await windowRow(session.id)).paid_by).toBe('ledger');
    });

    /** A run on a business team session of USER's (J-agents-11): the business pays. */
    const ranForTeam = async () => {
      const made = await ran('team-r-1');
      await sql`
        INSERT INTO agents.team_sessions (session_id, business_id, member_user_id, own_agent_id)
        VALUES (${made.session.id}, ${BUSINESS}, ${USER}, 'own-test')
      `;
      return made;
    };
    const owedByBusiness = async (sessionId: string) =>
      (
        await sql<Array<{ owed_by_business: string | null }>>`
        SELECT owed_by_business FROM agents.usage_windows WHERE session_id = ${sessionId}
      `
      )[0]!.owed_by_business;

    it('a team run is owed by the business, naming the member, and collected once from the business’s payment method (J-agents-11)', async () => {
      const { session, windowId } = await ranForTeam();
      const first = await runtime.settleWindow(session.id, windowId);
      const again = await runtime.settleWindow(session.id, windowId);
      const amount = first.amount;
      expect(amount > 0n).toBe(true);
      expect(again.settled).toBe(false);
      // svc-bank was asked for the business's payment method, never the member's.
      // One read and one collect; the second settle finds the window paid and asks nothing.
      expect(door.state.businesses).toEqual([BUSINESS, BUSINESS]);
      expect(door.payments.size).toBe(1);
      expect(door.balance()).toBe(parseAmount('10') - amount);
      // Earned once as owed by the business, naming the member; the member owes nothing and holds nothing here.
      const [earned, collected] = ledger.journal();
      expect(earned).toMatchObject({ reason: 'charge.earned', meta: { userId: BUSINESS, memberUserId: USER } });
      expect(collected).toMatchObject({ reason: 'charge.collected', meta: { userId: BUSINESS, paymentId: 'test-partner-move-1' } });
      expect(ledger.journal()).toHaveLength(2);
      expect(await figure(houseFees('agents', ASSET))).toBe(amount);
      expect(await figure(chargeReceivable('agents', BUSINESS, ASSET))).toBe(0n);
      expect(await figure(chargeReceivable('agents', USER, ASSET))).toBe(0n);
      expect(await figure(userAvailable(USER, ASSET))).toBe(0n);
      expect(await figure(partnerReserve('test', ASSET))).toBe(-amount);
      expect(ledger.reconcile()).toEqual({ ok: true });
      expect(await owedByBusiness(session.id)).toBe(BUSINESS);
      expect((await windowRow(session.id)).paid_by).toBe('partner');
    });

    it('a team window the business cannot pay stays owed by the business, and the next settle collects it once', async () => {
      const { session, windowId } = await ranForTeam();
      door.state.refuse = 'insufficient_funds';
      await expect(runtime.settleWindow(session.id, windowId)).rejects.toMatchObject({
        code: 'agents.window_unpaid',
        reason: 'insufficient_funds',
      });
      const amount = await meterOf().pendingCost(session.id, windowId);
      expect(await figure(chargeReceivable('agents', BUSINESS, ASSET))).toBe(-amount);
      expect(await figure(chargeReceivable('agents', USER, ASSET))).toBe(0n);
      expect(await owedByBusiness(session.id)).toBe(BUSINESS);
      expect(door.balance()).toBe(parseAmount('10'));
      door.state.refuse = null;
      expect((await runtime.settleWindow(session.id, windowId)).settled).toBe(true);
      expect(await figure(chargeReceivable('agents', BUSINESS, ASSET))).toBe(0n);
      expect(ledger.journal().map((t) => t.reason)).toEqual(['charge.earned', 'charge.collected']);
    });

    it('on the custodial layer a team run is the member’s fee charge, as before, and owed by no business', async () => {
      door.state.heldBy = 'ledger';
      await ledger.post(
        recipes.deposit({ userId: USER, assetId: ASSET, amount: parseAmount('5'), rail: 'test', railRef: 'partner-pay-team-fund' }),
      );
      const { session, windowId } = await ranForTeam();
      expect((await runtime.settleWindow(session.id, windowId)).settled).toBe(true);
      expect(door.state.collects).toBe(0);
      expect(
        ledger
          .journal()
          .map((t) => t.reason)
          .slice(1),
      ).toEqual(['agents.usage.metered']);
      expect(await owedByBusiness(session.id)).toBeNull();
    });
  });
}
