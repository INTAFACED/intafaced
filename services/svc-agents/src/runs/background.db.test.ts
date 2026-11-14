import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, houseFees, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { ProviderError } from '../errors.js';
import { ModelGateway } from '../gateway/gateway.js';
import { parseRoutingTable } from '../gateway/routing.js';
import { UsageMeter } from '../metering/meter.js';
import { MockModelProvider } from '../providers/mock.js';
import { createAgentsRouter, type AgentsRouterDeps } from '../router.js';
import { AgentRuntime, type ThinkInput } from '../runtime.js';
import { advanceSessionRuns, publishCompletedRuns, stepRequestId } from './background.js';

/**
 * A session's background runs on real Postgres, through the agents router, with the real runtime and meter
 * (AG-sessions-04, AG-control-01; J-agents-06). The ledger is `MemoryLedger`; the engine is the deterministic mock. The
 * ticker is called by hand with a step time of 0, so each call is one boundary: a step in flight makes its call, and a
 * running run starts its next step.
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
/** A person with no funds, so a stop's settlement is refused by the ledger. */
const UNFUNDED = '44444444-4444-4444-8444-444444444444';
const SECRET = 'an-agents-background-run-db-test-secret';
const TABLE = parseRoutingTable({
  routes: [
    {
      task: 'plan',
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
    maxActionsPerSession: 50,
    maxOutputTokensPerCall: 64,
    maxSpendPerSession: null,
    allowedModules: ['trade'],
    allowedTasks: ['plan'],
  },
};
const SETTINGS = { maxSteps: 10, stepMs: 1000 };

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
    id: 'req-background',
  });
}

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('svc-agents background runs (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 6,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-background-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');

  let ledger: MemoryLedger;
  let provider: MockModelProvider;
  let runtime: AgentRuntime;
  let gateway: ModelGateway;
  let meter: UsageMeter;
  let calls: ThinkInput[];
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
      TRUNCATE agents.session_background_run_steps, agents.session_background_runs, agents.think_claims, agents.usage_records,
               agents.usage_windows, agents.agent_actions, agents.agent_sessions, agents.agent_definitions
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    provider = new MockModelProvider({ id: 'primary' });
    gateway = new ModelGateway([provider], TABLE);
    meter = new UsageMeter(sql, ledger, { assetId: 'IFC', windowMinutes: 60 });
    const real = new AgentRuntime(sql, gateway, meter, new MemoryEventBus('svc-agents'), { feeAssetId: 'IFC', meteringEnabled: true });
    await real.registerAgent(PROBE);
    // Every engine call the run makes is seen, then made for real.
    calls = [];
    runtime = Object.create(real) as AgentRuntime;
    runtime.think = async (input) => {
      calls.push(input);
      return real.think(input);
    };
    for (const userId of [USER, OTHER]) {
      await ledger.post(
        recipes.deposit({ userId, assetId: 'IFC', amount: amt('1000'), rail: 'test', railRef: `background:fund:${userId}` }),
      );
    }
  }, 30_000);

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  const deps = (overrides: Partial<AgentsRouterDeps> = {}): AgentsRouterDeps => ({
    runtime,
    gateway,
    meter,
    feeAssetId: 'IFC',
    sql,
    sessionRuns: SETTINGS,
    ...overrides,
  });
  const as = (userId: string, overrides: Partial<AgentsRouterDeps> = {}) =>
    createAgentsRouter(deps(overrides)).createCaller(signed(userId));
  const tick = () => advanceSessionRuns(sql, runtime, 0);
  const begin = async (steps: number, requestId = 'background:db:run', notice: 'inapp' | 'email' = 'email') => {
    const me = as(USER);
    const session = await me.session.open({ agentId: 'probe' });
    const run = await me.run.background.start({
      sessionId: session.id,
      requestId,
      task: 'plan',
      ask: 'TEST: check each market',
      steps,
      notice,
    });
    return { me, session, run };
  };
  const usage = async () => (await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM agents.usage_records`)[0]!.n;
  const balance = async () => formatAmount((await ledger.balance(userAvailable(USER, 'IFC'))).amount);
  const house = async () => formatAmount((await ledger.balance(houseFees('agents', 'IFC'))).amount);

  // Each case makes a few dozen Postgres round trips under row locks; a loaded machine needs more than vitest's 5 s.
  describe('svc-agents background runs on Postgres', { timeout: 20_000 }, () => {
    it('a background run goes on without the caller, one metered call per step, completes, and is announced once', async () => {
      const { me, run } = await begin(2);
      expect(run).toMatchObject({ state: 'queued', stepsTotal: 2, notice: 'email', steps: [] });

      // The same request id again is that run; nothing new is made.
      const again = await me.run.background.start({
        sessionId: run.sessionId,
        requestId: 'background:db:run',
        task: 'plan',
        ask: 'TEST: other',
        steps: 2,
        notice: 'inapp',
      });
      expect(again.runId).toBe(run.runId);

      await tick();
      expect((await me.run.background.get({ runId: run.runId })).state).toBe('running');
      await tick();
      await tick();
      await tick();
      const done = await me.run.background.get({ runId: run.runId });
      expect(done.state).toBe('completed');
      expect(done.steps.map((s) => s.state)).toEqual(['done', 'done']);
      expect(done.reply).toBe(done.steps[1]!.reply);
      expect(done.reply).not.toBeNull();
      // One call per step, each under its own business key, each metered once.
      expect(calls.map((c) => c.requestId)).toEqual([stepRequestId(run.runId, 1), stepRequestId(run.runId, 2)]);
      expect(await usage()).toBe('2');
      // The second step goes on from the first one's stored reply.
      expect(calls[1]!.messages).toEqual([
        { role: 'user', content: 'TEST: check each market' },
        { role: 'assistant', content: done.steps[0]!.reply },
        { role: 'user', content: 'Go on with step 2 of 2.' },
      ]);

      const bus = new MemoryEventBus('svc-agents');
      expect(await publishCompletedRuns(sql, bus)).toBe(1);
      expect(await publishCompletedRuns(sql, bus)).toBe(0);
      expect(bus.published).toHaveLength(1);
      expect(bus.published[0]!.payload).toMatchObject({ runId: run.runId, userId: USER, notice: 'email', agentId: 'probe' });
    });

    it('a paused run starts no further step and refuses a new request with agents.run.paused; resumed, it goes on from the stored steps', async () => {
      const { me, run } = await begin(5);
      await tick(); // step 1 in flight
      await me.run.background.pause({ runId: run.runId });
      await tick(); // step 1's call finishes; no step 2
      await tick();
      await tick();
      const paused = await me.run.background.get({ runId: run.runId });
      expect(paused.state).toBe('paused');
      expect(paused.steps.map((s) => s.state)).toEqual(['done']);
      expect(calls).toHaveLength(1);
      await expect(me.run.background.askMore({ runId: run.runId, text: 'TEST: and the next one' })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'agents.run.paused',
      });

      const resumed = await me.run.background.resume({ runId: run.runId });
      expect(resumed.state).toBe('running');
      expect(resumed.resumedAt).not.toBeNull();
      await tick(); // step 2 in flight
      await tick(); // step 2 done, step 3 in flight
      const after = await me.run.background.get({ runId: run.runId });
      expect(after.steps.map((s) => s.state)).toEqual(['done', 'done', 'in_flight']);
      // Step 1 is never called again: step 2 is built on its stored reply.
      expect(calls.map((c) => c.requestId)).toEqual([stepRequestId(run.runId, 1), stepRequestId(run.runId, 2)]);
      expect(calls[1]!.messages[1]).toEqual({ role: 'assistant', content: paused.steps[0]!.reply });

      // Running, a follow-up is one more step whose messages carry it.
      const more = await me.run.background.askMore({ runId: run.runId, text: 'TEST: and the next one' });
      expect(more.stepsTotal).toBe(6);
      expect(more.followUps).toEqual(['TEST: and the next one']);
    });

    it('stop lets the call in flight finish and stores it, runs nothing more, settles the open windows once; a second stop returns the first result', async () => {
      const { me, run } = await begin(5);
      await tick(); // step 1 in flight
      await tick(); // step 1 done, step 2 in flight
      const before = await balance();

      const stopped = await me.run.background.stop({ runId: run.runId });
      expect(stopped.repeated).toBe(false);
      expect(stopped.run.state).toBe('stopped');
      expect(stopped.run.steps.map((s) => s.state)).toEqual(['done', 'done_after_stop']);
      expect(stopped.run.steps[1]!.reply).not.toBeNull();
      expect(calls).toHaveLength(2);
      const result = stopped.run.stop!;
      expect(result.unpaid).toBeNull();
      expect(result.settlements).toHaveLength(1);
      expect(result.settlements[0]!.settled).toBe(true);
      // The money invariant: what the person paid is what the house received, and it equals the stop's billed total,
      // which covers the two steps.
      const billed = amt(result.billed);
      expect(billed > 0n).toBe(true);
      expect(amt(before) - amt(await balance())).toBe(billed);
      expect(amt(await house())).toBe(billed);

      // Pressed again: the first result, nothing settled or charged again, nothing called.
      const twice = await me.run.background.stop({ runId: run.runId });
      expect(twice.repeated).toBe(true);
      expect(twice.run.stop).toEqual(result);
      expect(await balance()).toBe(formatAmount(amt(before) - billed));
      expect(await house()).toBe(formatAmount(billed));

      // Nothing further runs, and every metered call is one stored step.
      await tick();
      await tick();
      expect(calls).toHaveLength(2);
      expect(await usage()).toBe('2');
      expect((await me.run.background.get({ runId: run.runId })).steps).toHaveLength(2);
      // A stopped run takes no more changes.
      await expect(me.run.background.resume({ runId: run.runId })).rejects.toMatchObject({ code: 'CONFLICT', message: 'agents.run.ended' });
    });

    it('a stop whose window the ledger refuses for funds names it unpaid, charges nothing, and a second stop returns the same', async () => {
      const broke = as(UNFUNDED);
      const session = await broke.session.open({ agentId: 'probe' });
      const run = await broke.run.background.start({
        sessionId: session.id,
        requestId: 'background:db:unpaid',
        task: 'plan',
        ask: 'TEST: check each market',
        steps: 3,
        notice: 'inapp',
      });
      await tick(); // step 1 in flight
      await tick(); // step 1 done, step 2 in flight
      const stopped = await broke.run.background.stop({ runId: run.runId });
      expect(stopped.run.state).toBe('stopped');
      expect(stopped.run.steps.map((s) => s.state)).toEqual(['done', 'done_after_stop']);
      expect(stopped.run.stop).toMatchObject({ unpaid: 'agents.window_unpaid', billed: '0', settlements: [] });
      expect(await house()).toBe('0');
      const twice = await broke.run.background.stop({ runId: run.runId });
      expect(twice.repeated).toBe(true);
      expect(twice.run.stop).toEqual(stopped.run.stop);
      expect(await house()).toBe('0');
    });

    it('a follow-up never grows a run past the most steps allowed', async () => {
      const { me, run } = await begin(10, 'background:db:cap');
      await expect(me.run.background.askMore({ runId: run.runId, text: 'TEST: one more' })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'agents.session_run_steps_over',
      });
      expect((await me.run.background.get({ runId: run.runId })).stepsTotal).toBe(10);
    });

    it("another person's run id is not found for every read and change", async () => {
      const { run } = await begin(3);
      const stranger = as(OTHER);
      for (const call of [
        () => stranger.run.background.get({ runId: run.runId }),
        () => stranger.run.background.stop({ runId: run.runId }),
        () => stranger.run.background.pause({ runId: run.runId }),
        () => stranger.run.background.resume({ runId: run.runId }),
        () => stranger.run.background.askMore({ runId: run.runId, text: 'TEST' }),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'agents.run_not_found' });
      }
      // Starting on someone else's session is refused as not found too.
      await expect(
        stranger.run.background.start({
          sessionId: run.sessionId,
          requestId: 'background:db:theirs',
          task: 'plan',
          ask: 'TEST',
          steps: 1,
          notice: 'inapp',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const [row] = await sql<Array<{ state: string; stop_result: unknown }>>`
        SELECT state, stop_result FROM agents.session_background_runs WHERE id = ${run.runId}
      `;
      expect(row).toEqual({ state: 'queued', stop_result: null });
    });

    it('a refused call stores the step as refused and fails the run on its code; nothing is metered for it', async () => {
      const { me, run } = await begin(3);
      await tick(); // step 1 in flight
      provider.breakWith(new ProviderError('upstream is down', 'primary', true, 503));
      await tick();
      const failed = await me.run.background.get({ runId: run.runId });
      expect(failed.state).toBe('failed');
      expect(failed.failureCode).toEqual(expect.stringMatching(/^agents\./));
      expect(failed.steps.map((s) => s.state)).toEqual(['refused']);
      expect(await usage()).toBe('0');
      await tick();
      expect(calls).toHaveLength(1);
    });

    it('blank owner values refuse a new run by name, and a run longer than the most steps is refused', async () => {
      const me = as(USER, { sessionRuns: { maxSteps: null, stepMs: 1000 } });
      const session = await me.session.open({ agentId: 'probe' });
      const input = {
        sessionId: session.id,
        requestId: 'background:db:blank',
        task: 'plan',
        ask: 'TEST',
        steps: 1,
        notice: 'inapp' as const,
      };
      await expect(me.run.background.start(input)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'agents.session_run_unset',
      });
      await expect(as(USER).run.background.start({ ...input, steps: 11 })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'agents.session_run_steps_over',
      });
      expect((await sql`SELECT 1 FROM agents.session_background_runs`).length).toBe(0);
    });
  });
}
