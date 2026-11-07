import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { assertTestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { ModelGateway } from '../gateway/gateway.js';
import { parseRoutingTable } from '../gateway/routing.js';
import { UsageMeter } from '../metering/meter.js';
import { MockModelProvider } from '../providers/mock.js';
import { createAgentsRouter } from '../router.js';
import { AgentRuntime } from '../runtime.js';

/**
 * What my agents did (J-agents-13) on real Postgres, through the agents router: the dashboard, a run's trace, the
 * filtered log with its count and whole export, and usage by agent, user and task. The invariant: every figure equals
 * the stored rows it reads, spend is the sum of sealed windows, and test runs stay out unless asked for.
 */

const URL = process.env.TEST_DATABASE_URL_AGENTS ?? 'postgres://svc_agents:svc_agents@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const USER = '41414141-4141-4141-8141-414141414141';
const OTHER = '42424242-4242-4242-8242-424242424242';
const SECRET = 'an-agents-review-db-test-secret-32chars';
const MESSAGES = [{ role: 'user' as const, content: 'TEST: summarise my plan' }];
const TABLE = parseRoutingTable({
  routes: [
    {
      task: 'plan',
      providerId: 'primary',
      model: 'reasoning-lg',
      maxOutputTokens: 64,
      price: { inputPerMillion: '3', outputPerMillion: '15' },
    },
    {
      task: 'other',
      providerId: 'primary',
      model: 'reasoning-lg',
      maxOutputTokens: 64,
      price: { inputPerMillion: '3', outputPerMillion: '15' },
    },
  ],
});
const PROBE = {
  agentId: 'probe',
  version: 1,
  capacityMode: 'confirm_each',
  tools: [{ name: 'trade.quote', module: 'trade', mode: 'read' }],
  limits: {
    maxActionsPerSession: 1000,
    maxOutputTokensPerCall: 64,
    maxSpendPerSession: null,
    allowedModules: ['trade'],
    allowedTasks: ['plan'],
  },
};

const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
function signed(userId: string) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '43434343-4343-4343-8343-434343434343',
    scopes: ['agents:read', 'agents:execute'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-review',
  });
}

// Runs unconditionally: CI provides the database, and without one this suite fails rather than skips.
{
  const sql = postgres(URL, {
    max: 4,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-review-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');

  let ledger: MemoryLedger;
  let runtime: AgentRuntime;
  let meter: UsageMeter;
  let gateway: ModelGateway;
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
      TRUNCATE agents.agent_run_events, agents.agent_runs, agents.think_claims, agents.usage_records, agents.usage_windows,
               agents.agent_log_reads, agents.agent_actions, agents.agent_sessions, agents.agent_definitions, agents.own_agent_test_runs, agents.own_agents
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    gateway = new ModelGateway([new MockModelProvider({ id: 'primary' })], TABLE);
    meter = new UsageMeter(sql, ledger, { assetId: 'IFC', windowMinutes: 60 });
    runtime = new AgentRuntime(sql, gateway, meter, new MemoryEventBus('svc-agents'), { feeAssetId: 'IFC', meteringEnabled: true });
    await runtime.registerAgent(PROBE);
    for (const userId of [USER, OTHER])
      await ledger.post(recipes.deposit({ userId, assetId: 'IFC', amount: amt('1000'), rail: 'test', railRef: `review:fund:${userId}` }));
  }, 30_000);

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  const caller = (userId = USER) => createAgentsRouter({ runtime, gateway, meter, feeAssetId: 'IFC', sql }).createCaller(signed(userId));
  const today = () => new Date().toISOString().slice(0, 10);

  /** A session with one completed run and `refusals` refused requests, closed so its window is sealed and settled. */
  async function ranSession(userId = USER, refusals = 2) {
    const person = caller(userId);
    const session = await person.session.open({ agentId: 'probe' });
    const ran = await person.run.complete({
      sessionId: session.id,
      requestId: `review:${session.id}:ok`,
      task: 'plan',
      messages: MESSAGES,
    });
    for (let n = 0; n < refusals; n += 1)
      await expect(
        person.run.complete({ sessionId: session.id, requestId: `review:${session.id}:no:${n}`, task: 'other', messages: MESSAGES }),
      ).rejects.toThrow('agents.refused.task_not_allowed');
    await person.session.close({ sessionId: session.id });
    return { session, ran };
  }

  async function testRun(userId = USER) {
    const [agent] = await sql<Array<{ id: string }>>`
      INSERT INTO agents.own_agents (owner_id, template, name, create_key) VALUES (${userId}, 'blank', 'TEST helper', ${`review:${userId}`})
      RETURNING id::text
    `;
    await sql`
      INSERT INTO agents.own_agent_test_runs (agent_id, owner_id, request_id, request_key, kind, tool, input_json, checks_json, effect_json)
      VALUES (${agent!.id}, ${userId}, 'r1', ${`agents:test-run:${agent!.id}:r1`}, 'dry_run', 'trade.quote', '{}', '[]', '{}')
    `;
  }

  const storedCounts = async (userId = USER) => {
    const rows = await sql<Array<{ status: string; n: number }>>`
      SELECT status, count(*)::int AS n FROM agents.agent_actions WHERE user_id = ${userId} GROUP BY status
    `;
    return Object.fromEntries(rows.map((row) => [row.status, row.n])) as Record<string, number>;
  };
  const sealedSum = async (userId = USER) =>
    (
      await sql<Array<{ total: string }>>`
        SELECT coalesce(sum(w.charged_amount), 0)::text AS total FROM agents.usage_windows w
          JOIN agents.agent_sessions s ON s.id = w.session_id WHERE s.user_id = ${userId} AND w.sealed_at IS NOT NULL
      `
    )[0]!.total;

  describe('svc-agents review reads on Postgres (J-agents-13)', () => {
    it('the dashboard equals the stored rows, spend is the sum of sealed windows, and test runs stay out unless asked for', async () => {
      await ranSession(USER, 3);
      await ranSession(USER, 1);
      await ranSession(OTHER, 5);
      await testRun();
      const counts = await storedCounts();
      const live = await caller().analytics.summary({ from: today(), to: today() });
      expect(live.includesTest).toBe(false);
      expect(live.totals).toMatchObject({
        sessions: 2,
        actions: (counts.executed ?? 0) + (counts.refused ?? 0) + (counts.failed ?? 0),
        executed: counts.executed ?? 0,
        refused: 4,
        failed: counts.failed ?? 0,
        testRuns: null,
      });
      expect(live.days).toHaveLength(1);
      expect(live.days[0]).toMatchObject({ day: today(), ...live.totals });
      expect(live.totals.spend).toHaveLength(1);
      expect(amt(live.totals.spend[0]!.amount)).toBe(amt(await sealedSum()));
      expect(amt(live.totals.spend[0]!.amount) > 0n).toBe(true);

      const withTest = await caller().analytics.summary({ from: today(), to: today(), includeTest: true });
      expect(withTest.totals.testRuns).toBe(1);
      expect({ ...withTest.totals, testRuns: null }).toEqual(live.totals);
    });

    it('a blank or bad range refuses by name and reads nothing; a range with nothing in it is empty, not invented', async () => {
      await expect(caller().analytics.summary({ to: today() })).rejects.toThrow('agents.refused.analytics_from_unset');
      await expect(caller().analytics.summary({ from: today(), to: ' ' })).rejects.toThrow('agents.refused.analytics_to_unset');
      await expect(caller().analytics.summary({ from: '2026-02-30', to: today() })).rejects.toThrow(
        'agents.refused.analytics_range_invalid',
      );
      await expect(caller().analytics.summary({ from: today(), to: '2020-01-01' })).rejects.toThrow(
        'agents.refused.analytics_range_invalid',
      );
      await ranSession();
      const empty = await caller().analytics.summary({ from: '2020-01-01', to: '2020-01-02' });
      expect(empty.days).toEqual([]);
      expect(empty.totals).toMatchObject({ sessions: 0, actions: 0, spend: [] });
    });

    it('a run trace is the run’s timed events and its engine call with tokens and cost; another person’s session is not found', async () => {
      const { session, ran } = await ranSession();
      const trace = await caller().run.trace({ sessionId: session.id, requestId: `review:${session.id}:ok` });
      expect(trace.plan.map((step) => step.state)).toEqual(['admitted', 'running', 'completed']);
      expect(trace.plan.at(-1)!.tookMs).toBeNull();
      for (const [index, step] of trace.plan.slice(0, -1).entries())
        expect(step.tookMs).toBe(Date.parse(trace.plan[index + 1]!.startedAt) - Date.parse(step.startedAt));
      expect(trace.calls).toHaveLength(1);
      expect(trace.calls[0]).toMatchObject({ kind: 'completion', status: 'executed', task: 'plan', cost: ran.cost });
      expect(trace.calls[0]!.tookMs).toBeGreaterThanOrEqual(0);
      expect(trace.cost).toBe(ran.cost);
      await expect(caller(OTHER).run.trace({ sessionId: session.id, requestId: `review:${session.id}:ok` })).rejects.toThrow();
      await expect(caller().run.trace({ sessionId: session.id, requestId: 'review:none' })).rejects.toThrow('agents.run_not_found');
    });

    it('the log filters by outcome, counts every row, and exports the whole filtered log past one page', async () => {
      await ranSession(USER, 7);
      await ranSession(OTHER, 2);
      const counts = await storedCounts();
      const all = (counts.executed ?? 0) + (counts.refused ?? 0) + (counts.failed ?? 0);
      expect((await caller().log.count({})).total).toBe(all);
      expect((await caller().log.count({ outcome: 'refused' })).total).toBe(7);
      const refused = await caller().log.mine({ limit: 500, outcome: 'refused' });
      expect(refused).toHaveLength(7);
      expect(refused.every((row) => row.status === 'refused' && row.refusalCode === 'agents.task_not_allowed')).toBe(true);

      // Pages of 3: every row once, newest first, the same filter, and a null cursor at the end.
      const read = async (outcome?: 'refused') => {
        const rows = [];
        let cursor: string | undefined;
        for (;;) {
          const page = await caller().log.export({ limit: 3, ...(outcome ? { outcome } : {}), ...(cursor ? { cursor } : {}) });
          rows.push(...page.rows);
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        return rows;
      };
      const exported = await read();
      expect(exported).toHaveLength(all);
      expect(new Set(exported.map((row) => row.id)).size).toBe(all);
      expect(exported.every((row) => row.agentId === 'probe')).toBe(true);
      const exportedRefused = await read('refused');
      expect(exportedRefused.map((row) => row.id).sort()).toEqual(refused.map((row) => row.id).sort());
      // The export's last page writes its one audit row; the same request id again writes no second.
      const audit = async () =>
        sql<Array<{ kind: string; row_count: number; filter: Record<string, string> }>>`
          SELECT kind, row_count, filter FROM agents.agent_log_reads WHERE business_key = ${`agents:logexport:${USER}:review-export-1`}
        `;
      for (let attempt = 0; attempt < 2; attempt += 1)
        await caller().log.export({ limit: 500, outcome: 'refused', requestId: 'review-export-1', format: 'json' });
      expect(await audit()).toEqual([{ kind: 'export', row_count: 7, filter: { outcome: 'refused', format: 'json' } }]);
      await caller().log.export({ limit: 3, requestId: 'review-export-2' });
      expect(
        (await sql`SELECT 1 FROM agents.agent_log_reads WHERE business_key = ${`agents:logexport:${USER}:review-export-2`}`).length,
      ).toBe(0);
      await expect(caller().log.export({})).rejects.toThrow('agents.refused.log_mine_limit_unset');
      await expect(caller().log.export({ limit: 3, cursor: 'not-a-cursor' })).rejects.toThrow('agents.refused.cursor_invalid');
    });

    it('usage by agent, user and task each add up to the sealed windows', async () => {
      await ranSession();
      await ranSession();
      await ranSession(OTHER);
      const usage = await caller().usage.summary({ limit: 500 });
      const total = amt(await sealedSum());
      const add = (rows: { amount: string }[]) => rows.reduce((sum, row) => sum + amt(row.amount), 0n);
      expect(usage.windowCount).toBe(2);
      expect(add(usage.windows)).toBe(total);
      expect(usage.total).toEqual([{ assetId: 'IFC', amount: usage.total[0]!.amount }]);
      expect(amt(usage.total[0]!.amount)).toBe(total);
      for (const rows of [usage.byAgent, usage.byUser, usage.byTask]) expect(add(rows)).toBe(total);
      expect(usage.byUser).toEqual([expect.objectContaining({ key: USER, windows: 2 })]);
      expect(usage.byTask).toEqual([expect.objectContaining({ key: 'plan', windows: 2 })]);
      expect(usage.windows.every((row) => row.state === 'settled')).toBe(true);
      // A page smaller than the windows still totals all of them.
      const page = await caller().usage.summary({ limit: 1 });
      expect(page.windows).toHaveLength(1);
      expect(amt(page.total[0]!.amount)).toBe(total);
    });
  });
}
