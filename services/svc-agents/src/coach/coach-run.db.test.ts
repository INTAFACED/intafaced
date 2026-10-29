import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { MockModelProvider } from '../providers/mock.js';
import { MemoryEventBus } from '@intafaced/events';
import { LedgerError, MemoryLedger, formatAmount, houseFees, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { serialiseGuardrail } from '../fleet/guardrails.js';
import { ModelGateway } from '../gateway/gateway.js';
import { parseRoutingTable } from '../gateway/routing.js';
import { UsageMeter } from '../metering/meter.js';
import { AgentRuntime } from '../runtime.js';
import { COACH_TASK, coachAgentGuardrail, createCoachRunStore, runCoachAnswer, type CoachRunDeps } from './coach-run.js';

/**
 * The Coach run on real Postgres, the real runtime and the real meter (RC-agents-02). The ledger is `MemoryLedger`, the
 * reference the conformance suite proves equal to svc-ledger. The properties pinned here live in the database: one
 * stored answer per (person, request id), one charge per usage window on its own charge key, and a posting freeze that
 * leaves the charge unpaid on its row rather than dropping it.
 *
 * The Coach guardrail is registered here with a TEST cap so the route can carry a TEST price: the shipped guardrail
 * caps at 0, and a free route would settle nothing the ledger could refuse.
 */

const URL = process.env.TEST_DATABASE_URL_AGENTS ?? 'postgres://svc_agents:svc_agents@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const USER = '66666666-6666-4666-8666-666666666666';
const SPINE = [
  { slug: 'foundations-risk-first', title: 'Risk first' },
  { slug: 'foundations-position-sizing', title: 'Position sizing without inventing numbers' },
  { slug: 'foundations-invalidation-first', title: 'Invalidation before entry' },
];
const ASK = 'TEST: why does position size matter more than entry?';
const TABLE = parseRoutingTable({
  routes: [
    {
      task: COACH_TASK,
      providerId: 'primary',
      model: 'test-engine',
      maxOutputTokens: 64,
      price: { inputPerMillion: '1000', outputPerMillion: '1000' },
    },
  ],
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('svc-agents coach run (Postgres unavailable — start docker compose)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 4,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-coach-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');

  let ledger: MemoryLedger;
  let gateway: ModelGateway;
  let runtime: AgentRuntime;
  let meter: UsageMeter;
  let frozen: boolean;
  let lockConn: Awaited<ReturnType<typeof sql.reserve>>;

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
      TRUNCATE agents.coach_runs, agents.think_claims, agents.usage_records, agents.usage_windows, agents.agent_actions,
               agents.agent_sessions, agents.agent_definitions
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    frozen = false;
    const post = ledger.post.bind(ledger);
    // The platform-wide posting freeze is svc-ledger's; the reference ledger refuses with the same code.
    ledger.post = (async (...args: Parameters<MemoryLedger['post']>) => {
      if (frozen) throw new LedgerError('Postings are frozen', 'ledger.frozen');
      return post(...args);
    }) as MemoryLedger['post'];
    gateway = new ModelGateway([new MockModelProvider({ id: 'primary' })], TABLE);
    meter = new UsageMeter(sql, ledger, { assetId: 'IFC', windowMinutes: 60 });
    runtime = new AgentRuntime(sql, gateway, meter, new MemoryEventBus('svc-agents'), {
      feeAssetId: 'IFC',
      meteringEnabled: true,
    });
    await runtime.registerAgent(serialiseGuardrail(coachAgentGuardrail({ maxSpendPerSession: '10' })));
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'IFC', amount: amt('100'), rail: 'test', railRef: 'coach:fund' }));
  }, 30_000);

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  function deps(store = createCoachRunStore(sql)): CoachRunDeps {
    return {
      runtime,
      gateway,
      store,
      feeAssetId: 'IFC',
      loadGrounding: async () => ({ items: SPINE, licensedLibraryImported: false }),
      metered: (sessionId, requestId) => meter.hasRequest(sessionId, requestId),
    };
  }

  const ask = (d: CoachRunDeps, requestId = 'coach:db:0001') =>
    runCoachAnswer(d, { userId: USER, requestId, question: ASK, lessonSlug: 'foundations-risk-first' });

  const house = async () => formatAmount((await ledger.balance(houseFees('agents', 'IFC'))).amount);
  const balance = async () => formatAmount((await ledger.balance(userAvailable(USER, 'IFC'))).amount);
  const windows = () =>
    sql<Array<{ charge_key: string | null; charged_amount: string | null; charge_tx_id: string | null }>>`
      SELECT charge_key, charged_amount::text, charge_tx_id FROM agents.usage_windows ORDER BY opened_at
    `;

  describe('svc-agents coach run on Postgres', () => {
    it('answers once, charges its window once, and a retry returns the stored answer without a second charge', async () => {
      const first = await ask(deps());
      expect(first).toMatchObject({ status: 'answered', charge: { state: 'settled' }, replayed: false });
      const billed = first.status === 'answered' && first.charge.state === 'settled' ? first.charge.billedAmount : '';
      const sessionId = first.status === 'answered' ? first.sessionId : '';
      expect(amt(billed) > 0n).toBe(true);
      expect(await house()).toBe(billed);
      expect(await balance()).toBe(formatAmount(amt('100') - amt(billed)));

      const again = await ask(deps());
      expect(again).toEqual({ ...first, replayed: true });
      expect(await house()).toBe(billed);
      const rows = await windows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.charged_amount).not.toBeNull();
      expect(formatAmount(amt(rows[0]!.charged_amount!))).toBe(billed);

      const stored = await sql<Array<{ run_key: string; status: string; billed_amount: string }>>`
        SELECT run_key, status, billed_amount::text FROM agents.coach_runs WHERE user_id = ${USER}
      `;
      expect(stored).toEqual([
        { run_key: `agents:run:${sessionId}:coach:db:0001`, status: 'answered', billed_amount: stored[0]!.billed_amount },
      ]);
      expect(formatAmount(amt(stored[0]!.billed_amount))).toBe(billed);
    });

    it('a crash after the engine ran neither double-bills nor drops the charge', async () => {
      const store = createCoachRunStore(sql);
      const crashing = { ...store, answer: async () => Promise.reject(new Error('crash before the answer was stored')) };
      await expect(ask(deps(crashing))).rejects.toThrow('crash before the answer was stored');
      expect(await house()).toBe('0');

      expect(await ask(deps())).toEqual({ status: 'refused', code: 'agents.request_id_replay' });
      const charged = await house();
      expect(amt(charged) > 0n).toBe(true);
      expect(await ask(deps())).toEqual({ status: 'refused', code: 'agents.request_id_replay' });
      expect(await house()).toBe(charged);

      const rows = await windows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.charge_tx_id).not.toBeNull();
      const usage = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM agents.usage_records`;
      expect(usage[0]!.n).toBe('1');
    });

    it('during a posting freeze the charge gets the ledger refusal and keeps its row; after the freeze it settles once', async () => {
      frozen = true;
      const first = await ask(deps());
      expect(first.status === 'answered' ? first.charge : null).toEqual({ state: 'unpaid', code: 'ledger.frozen' });
      expect(await house()).toBe('0');
      const held = await windows();
      expect(held).toHaveLength(1);
      expect(held[0]!.charge_tx_id).toBeNull();
      const row = await sql<Array<{ status: string; billed_amount: string | null }>>`
        SELECT status, billed_amount::text FROM agents.coach_runs WHERE user_id = ${USER}
      `;
      expect(row).toEqual([{ status: 'answered', billed_amount: null }]);

      frozen = false;
      const again = await ask(deps());
      expect(again.status === 'answered' ? again.charge.state : null).toBe('settled');
      const charged = await house();
      expect(amt(charged) > 0n).toBe(true);
      expect(again.status === 'answered' && again.charge.state === 'settled' ? again.charge.billedAmount : null).toBe(charged);
      await ask(deps());
      expect(await house()).toBe(charged);
      expect((await windows())[0]!.charge_tx_id).not.toBeNull();
    });
  });
}
