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
import { parseRoutingTable, unpricedTable } from '../gateway/routing.js';
import { UsageMeter } from '../metering/meter.js';
import { MockModelProvider } from '../providers/mock.js';
import { createAgentsRouter, type AgentsRouterDeps } from '../router.js';
import { AgentRuntime } from '../runtime.js';
import { RunTransitionError } from './machine.js';
import { RUN_LEASE_MS, runRecorded } from './record.js';
import { createRunStore, type RunStore } from './store.js';

/**
 * The run entity on real Postgres, through the agents router, with the real runtime and the real meter
 * (AG-sessions-01, ENGINE RS-1 to RS-4). The ledger is `MemoryLedger`, the reference the conformance suite proves equal
 * to svc-ledger; the engine is the deterministic mock. A person starts every run; an API key only reads it (owner decision 2026-10-29).
 */

const URL = process.env.TEST_DATABASE_URL_AGENTS ?? 'postgres://svc_agents:svc_agents@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const USER = '31313131-3131-4131-8131-313131313131';
const OTHER = '32323232-3232-4232-8232-323232323232';
const KEY_ID = '33333333-3333-4333-8333-333333333333';
const SECRET = 'an-agents-run-entity-db-test-secret-32';
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
  ],
});
const PROBE = {
  agentId: 'probe',
  version: 1,
  capacityMode: 'confirm_each',
  tools: [{ name: 'trade.quote', module: 'trade', mode: 'read' }],
  limits: {
    maxActionsPerSession: 20,
    maxOutputTokensPerCall: 64,
    maxSpendPerSession: null,
    allowedModules: ['trade'],
    allowedTasks: ['plan'],
  },
};

const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });

/** A signed-in person (`agents:execute`) or, with `kid`, an API key that holds only the scopes given. */
function signed(userId: string, scopes: string[], kid?: string) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '34343434-3434-4434-8434-343434343434',
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...(kid ? { kid } : {}),
  } as Principal);
  return edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-runs',
  });
}

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('svc-agents run entity (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 4,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-runs-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');

  let ledger: MemoryLedger;
  let provider: MockModelProvider;
  let gateway: ModelGateway;
  let meter: UsageMeter;
  let runtime: AgentRuntime;
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
               agents.agent_actions, agents.agent_sessions, agents.agent_definitions
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    provider = new MockModelProvider({ id: 'primary' });
    gateway = new ModelGateway([provider], TABLE);
    meter = new UsageMeter(sql, ledger, { assetId: 'IFC', windowMinutes: 60 });
    runtime = new AgentRuntime(sql, gateway, meter, new MemoryEventBus('svc-agents'), { feeAssetId: 'IFC', meteringEnabled: true });
    await runtime.registerAgent(PROBE);
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'IFC', amount: amt('1000'), rail: 'test', railRef: 'runs:fund' }));
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
    ...overrides,
  });
  const person = (overrides: Partial<AgentsRouterDeps> = {}) =>
    createAgentsRouter(deps(overrides)).createCaller(signed(USER, ['agents:read', 'agents:execute']));
  const key = (userId = USER, scopes = ['agents:read']) => createAgentsRouter(deps()).createCaller(signed(userId, scopes, KEY_ID));
  const complete = (caller: ReturnType<typeof person>, sessionId: string, requestId: string) =>
    caller.run.complete({ sessionId, requestId, task: 'plan', messages: MESSAGES });

  const stored = async (runId: string) => {
    const [row] = await sql<Array<{ state: string; reply: string | null; cost: string | null; metered: boolean | null }>>`
      SELECT state, reply, cost::text, metered FROM agents.agent_runs WHERE id = ${runId}
    `;
    return row;
  };
  const trail = async (runId: string) =>
    sql<Array<{ sequence: number; state: string; code: string | null }>>`
      SELECT sequence, state, code FROM agents.agent_run_events WHERE run_id = ${runId} ORDER BY sequence
    `;
  const usageCount = async () => (await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM agents.usage_records`)[0]!.n;
  const runCount = async () => (await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM agents.agent_runs`)[0]!.n;
  const house = async () => formatAmount((await ledger.balance(houseFees('agents', 'IFC'))).amount);
  const balance = async () => formatAmount((await ledger.balance(userAvailable(USER, 'IFC'))).amount);
  const runIdOf = async (requestId: string) =>
    (await sql<Array<{ id: string }>>`SELECT id FROM agents.agent_runs WHERE request_id = ${requestId}`)[0]!.id;

  describe('svc-agents run entity on Postgres', () => {
    it('a person run is stored completed with its reply, metered cost and three events; the row is written before the engine runs', async () => {
      let seenBeforeEngine: Array<{ state: string }> = [];
      const watched = Object.create(runtime) as AgentRuntime;
      watched.think = async (input) => {
        seenBeforeEngine = await sql<Array<{ state: string }>>`SELECT state FROM agents.agent_runs`;
        return runtime.think(input);
      };
      const caller = person({ runtime: watched });
      const session = await caller.session.open({ agentId: 'probe' });
      const ran = await complete(caller, session.id, 'runs:db:complete');

      expect(seenBeforeEngine).toEqual([{ state: 'running' }]);
      expect(ran.metered).toBe(true);
      expect(amt(ran.cost) > 0n).toBe(true);
      expect(await stored(ran.runId)).toEqual({ state: 'completed', reply: ran.text, cost: expect.any(String), metered: true });
      expect(formatAmount(amt((await stored(ran.runId))!.cost!))).toBe(ran.cost);
      expect(await trail(ran.runId)).toEqual([
        { sequence: 1, state: 'admitted', code: null },
        { sequence: 2, state: 'running', code: null },
        { sequence: 3, state: 'completed', code: null },
      ]);
      const [keyRow] = await sql<Array<{ run_key: string; session_id: string; user_id: string }>>`
        SELECT run_key, session_id, user_id FROM agents.agent_runs WHERE id = ${ran.runId}
      `;
      expect(keyRow).toEqual({ run_key: `agents:run:${session.id}:runs:db:complete`, session_id: session.id, user_id: USER });
    });

    it('an API key with agents:read reads the person-started run: list, get and events paged by cursor; no prompt text', async () => {
      const caller = person();
      const session = await caller.session.open({ agentId: 'probe' });
      const ran = await complete(caller, session.id, 'runs:db:read');
      const reader = key();

      const mine = await reader.session.mine({ limit: 10 });
      expect(mine.items.map((item) => item.id)).toEqual([session.id]);
      expect(await reader.run.list({ sessionId: session.id, limit: 10 })).toEqual([
        { runId: ran.runId, requestId: 'runs:db:read', state: 'completed', createdAt: expect.any(String) },
      ]);

      const got = await reader.run.get({ runId: ran.runId });
      expect(got).toEqual({
        runId: ran.runId,
        sessionId: session.id,
        agentId: 'probe',
        requestId: 'runs:db:read',
        task: 'plan',
        state: 'completed',
        reply: ran.text,
        cost: ran.cost,
        assetId: 'IFC',
        metered: true,
        refusalCodes: [],
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(JSON.stringify(got)).not.toContain(MESSAGES[0]!.content);

      const page1 = await reader.run.events({ runId: ran.runId, limit: 2 });
      expect(page1).toEqual({
        events: [
          { id: `${ran.runId}:1`, sequence: 1, state: 'admitted', code: null, occurredAt: expect.any(String) },
          { id: `${ran.runId}:2`, sequence: 2, state: 'running', code: null, occurredAt: expect.any(String) },
        ],
        cursor: '2',
      });
      const page2 = await reader.run.events({ runId: ran.runId, cursor: page1.cursor, limit: 2 });
      expect(page2).toEqual({
        events: [{ id: `${ran.runId}:3`, sequence: 3, state: 'completed', code: null, occurredAt: expect.any(String) }],
        cursor: '3',
      });
      expect(await reader.run.events({ runId: ran.runId, cursor: page2.cursor, limit: 2 })).toEqual({ events: [], cursor: '3' });
    });

    it('session.events from a cursor: only the session’s later actions, only for the caller', async () => {
      const caller = person();
      const session = await caller.session.open({ agentId: 'probe' });
      const elsewhere = await caller.session.open({ agentId: 'probe' });
      const first = await complete(caller, session.id, 'runs:db:events:1');
      await complete(caller, elsewhere.id, 'runs:db:events:elsewhere');
      const next = await complete(caller, session.id, 'runs:db:events:2');
      const reader = key();

      const page1 = await reader.session.events({ sessionId: session.id, limit: 1 });
      expect(page1.events.map((e) => [e.sequence, e.kind, e.status, e.sessionId])).toEqual([[0, 'session_open', 'executed', session.id]]);
      expect(page1.cursor).toBe('0');
      const page2 = await reader.session.events({ sessionId: session.id, cursor: '0', limit: 10 });
      expect(page2.events.map((e) => [e.sequence, e.kind, e.status, e.sessionId])).toEqual([
        [1, 'completion', 'executed', session.id],
        [2, 'completion', 'executed', session.id],
      ]);
      expect(page2.events.map((e) => e.cost)).toEqual([first.cost, next.cost]);
      expect(page2.cursor).toBe('2');
      expect(await reader.session.events({ sessionId: session.id, cursor: '2', limit: 10 })).toEqual({ events: [], cursor: '2' });

      // A later action is the only thing the saved cursor returns, and it is this session's, not the other one's.
      const later = await complete(caller, session.id, 'runs:db:events:3');
      const page3 = await reader.session.events({ sessionId: session.id, cursor: '2', limit: 10 });
      expect(page3.events.map((e) => [e.sequence, e.kind, e.sessionId])).toEqual([[3, 'completion', session.id]]);
      expect(page3.events[0]!.cost).toBe(later.cost);
      expect(page3.cursor).toBe('3');
      // The same actions as the owner's own session log, by id.
      const log = await caller.session.log({ sessionId: session.id, limit: 50 });
      expect([...page1.events, ...page2.events, ...page3.events].map((e) => e.id)).toEqual(log.map((e) => e.id));
      expect(JSON.stringify(page3)).not.toContain(MESSAGES[0]!.content);

      await expect(key(OTHER).session.events({ sessionId: session.id, limit: 10 })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'agents.refused.session_closed',
      });
      await expect(key(USER, ['trade:read']).session.events({ sessionId: session.id, limit: 10 })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(reader.session.events({ sessionId: session.id, cursor: 'x', limit: 10 })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'agents.refused.cursor_invalid',
      });
    });

    it('reads stay the owner’s: another person’s key gets agents.run_not_found, a key without agents:read is forbidden, a bad cursor is typed', async () => {
      const caller = person();
      const session = await caller.session.open({ agentId: 'probe' });
      const ran = await complete(caller, session.id, 'runs:db:owner');

      await expect(key(OTHER).run.get({ runId: ran.runId })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'agents.run_not_found' });
      await expect(key(OTHER).run.events({ runId: ran.runId, limit: 5 })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'agents.run_not_found',
      });
      await expect(key(OTHER).run.list({ sessionId: session.id, limit: 10 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(key(USER, ['trade:read']).run.get({ runId: ran.runId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(key().run.events({ runId: ran.runId, cursor: '-1', limit: 5 })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'agents.refused.cursor_invalid',
      });
      await expect(key().run.events({ runId: ran.runId, cursor: '01', limit: 5 })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'agents.refused.cursor_invalid',
      });
      // A key never starts a run (owner decision 2026-10-29), and the refused start stores nothing.
      await expect(
        key(USER, ['agents:read', 'agents:execute']).run.complete({
          sessionId: session.id,
          requestId: 'runs:db:by-key',
          task: 'plan',
          messages: MESSAGES,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await runCount()).toBe('1');
      expect(await stored(ran.runId)).toMatchObject({ state: 'completed', reply: ran.text });
    });

    it('the same metered request id twice is one run and one usage record; the repeat is refused as a replay and changes nothing', async () => {
      const caller = person();
      const session = await caller.session.open({ agentId: 'probe' });
      const ran = await complete(caller, session.id, 'runs:db:replay');
      const charged = await balance();

      await expect(complete(caller, session.id, 'runs:db:replay')).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'agents.error.request_id_replay',
      });
      expect(await usageCount()).toBe('1');
      expect(await runCount()).toBe('1');
      expect(await balance()).toBe(charged);
      expect(await stored(ran.runId)).toMatchObject({ state: 'completed', reply: ran.text });
      expect((await trail(ran.runId)).map((event) => event.state)).toEqual(['admitted', 'running', 'completed']);
    });

    it('an unpriced route is refused with agents.price_unset, bills nothing, and the run reads refused with that code', async () => {
      const unpriced = new ModelGateway([provider], unpricedTable(TABLE));
      const rt = new AgentRuntime(sql, unpriced, meter, new MemoryEventBus('svc-agents'), { feeAssetId: 'IFC', meteringEnabled: true });
      const caller = person({ runtime: rt, gateway: unpriced });
      const session = await caller.session.open({ agentId: 'probe' });

      await expect(complete(caller, session.id, 'runs:db:unpriced')).rejects.toMatchObject({ message: 'agents.refused.price_unset' });
      const runId = await runIdOf('runs:db:unpriced');
      const got = await key().run.get({ runId });
      expect(got).toMatchObject({ state: 'refused', reply: null, cost: null, refusalCodes: ['agents.price_unset'] });
      expect(await usageCount()).toBe('0');
      expect(await house()).toBe('0');
      expect(await balance()).toBe('1000');
      expect(await trail(runId)).toEqual([
        { sequence: 1, state: 'admitted', code: null },
        { sequence: 2, state: 'running', code: null },
        { sequence: 3, state: 'refused', code: 'agents.price_unset' },
      ]);
    });

    it('an engine that does not answer leaves the run failed and unbilled; the same request id then completes the same run', async () => {
      const caller = person();
      const session = await caller.session.open({ agentId: 'probe' });
      provider.breakWith(new ProviderError('upstream is down', 'primary', true, 503));
      await expect(complete(caller, session.id, 'runs:db:engine')).rejects.toBeDefined();
      const runId = await runIdOf('runs:db:engine');
      expect(await stored(runId)).toEqual({ state: 'failed', reply: null, cost: null, metered: null });
      expect((await trail(runId)).at(-1)).toEqual({ sequence: 3, state: 'failed', code: 'agents.provider_unavailable' });
      expect(await usageCount()).toBe('0');
      expect(await balance()).toBe('1000');

      provider.repair();
      const retried = await complete(caller, session.id, 'runs:db:engine');
      expect(retried.runId).toBe(runId);
      expect(await stored(runId)).toMatchObject({ state: 'completed', reply: retried.text, metered: true });
      expect((await trail(runId)).map((event) => event.state)).toEqual(['admitted', 'running', 'failed', 'running', 'completed']);
      expect(await usageCount()).toBe('1');
      expect(await runCount()).toBe('1');
    });

    it('a crash after the row is written and before the engine: the retry continues the same run', async () => {
      const caller = person();
      const session = await caller.session.open({ agentId: 'probe' });
      const real = createRunStore(sql);
      const crashing: RunStore = { ...real, move: async () => Promise.reject(new Error('crash after admit')) };
      await expect(complete(person({ runStore: crashing }), session.id, 'runs:db:crash-admit')).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
      const runId = await runIdOf('runs:db:crash-admit');
      expect(await stored(runId)).toMatchObject({ state: 'admitted' });
      expect(await usageCount()).toBe('0');

      const retried = await complete(caller, session.id, 'runs:db:crash-admit');
      expect(retried.runId).toBe(runId);
      expect(await stored(runId)).toMatchObject({ state: 'completed', reply: retried.text });
      expect((await trail(runId)).map((event) => event.state)).toEqual(['admitted', 'running', 'completed']);
      expect(await usageCount()).toBe('1');
    });

    it('a crash after the engine answered: inside the lease the retry changes nothing; past it the retry adopts the run as completed and metered, billed once', async () => {
      const session = await runtime.openSession({ userId: USER, agentId: 'probe' });
      const real = createRunStore(sql);
      const lostMark: RunStore = {
        ...real,
        move: async (runId, to, outcome) =>
          to === 'completed' ? Promise.reject(new Error('crash before the run was marked')) : real.move(runId, to, outcome),
      };
      const input = {
        userId: USER,
        sessionId: session.id,
        agentId: 'probe',
        requestId: 'runs:db:crash-engine',
        task: 'plan',
        assetId: 'IFC',
      };
      const think = () => runtime.think({ sessionId: session.id, requestId: 'runs:db:crash-engine', task: 'plan', messages: MESSAGES });
      const first = await runRecorded(lostMark, input, think);
      expect(first.run.state).toBe('running');
      expect(await usageCount()).toBe('1');
      expect(await meter.hasRequest(session.id, 'runs:db:crash-engine')).toBe(true);
      // The usage sits in its open window; it is charged once when the window settles, never by the run.
      const charged = await balance();

      // Inside the lease the running run may be live: the runtime refuses the replay and the run is left alone.
      await expect(complete(person(), session.id, 'runs:db:crash-engine')).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'agents.error.request_id_replay',
      });
      expect(await stored(first.run.id)).toMatchObject({ state: 'running', reply: null });
      expect(await trail(first.run.id)).toHaveLength(2);

      const later = () => Date.now() + RUN_LEASE_MS + 1;
      await expect(runRecorded(real, input, think, later)).rejects.toMatchObject({ code: 'agents.request_id_replay' });
      // The call was charged once into the window, so the run is that charged call, never a refusal that billed nothing.
      expect(await stored(first.run.id)).toEqual({ state: 'completed', reply: '', cost: null, metered: true });
      expect((await trail(first.run.id)).at(-1)).toEqual({ sequence: 3, state: 'completed', code: 'agents.request_id_replay' });
      expect(await usageCount()).toBe('1');
      expect(await balance()).toBe(charged);
      expect((await key().run.get({ runId: first.run.id })).refusalCodes).toEqual([]);
      // Completed is final: a later retry is refused and the run stays as it is.
      await expect(runRecorded(real, input, think, later)).rejects.toMatchObject({ code: 'agents.request_id_replay' });
      expect(await trail(first.run.id)).toHaveLength(3);
      expect(await usageCount()).toBe('1');
    });

    it('a crash after the claim and before the meter: past the lease the replay ends the run refused, billed nothing', async () => {
      const session = await runtime.openSession({ userId: USER, agentId: 'probe' });
      const input = {
        userId: USER,
        sessionId: session.id,
        agentId: 'probe',
        requestId: 'runs:db:crash-claim',
        task: 'plan',
        assetId: 'IFC',
      };
      const real = createRunStore(sql);
      const before = await balance();
      // The process died inside the call: the claim committed, the engine never returned, nothing was metered.
      const died: RunStore = {
        ...real,
        move: async (runId, to, outcome) => (to === 'running' ? real.move(runId, to, outcome) : Promise.reject(new Error('died'))),
      };
      await expect(
        runRecorded(died, input, async () => {
          await meter.claimRequest(session.id, 'runs:db:crash-claim');
          throw new Error('died inside the engine call');
        }),
      ).rejects.toThrow('died inside the engine call');
      const think = () => runtime.think({ sessionId: session.id, requestId: 'runs:db:crash-claim', task: 'plan', messages: MESSAGES });
      const later = () => Date.now() + RUN_LEASE_MS + 1;
      await expect(runRecorded(real, input, think, later)).rejects.toMatchObject({ code: 'agents.request_id_replay' });
      const [run] = await sql<Array<{ id: string }>>`SELECT id FROM agents.agent_runs WHERE request_id = 'runs:db:crash-claim'`;
      expect(await stored(run!.id)).toEqual({ state: 'refused', reply: null, cost: null, metered: null });
      expect((await trail(run!.id)).at(-1)).toEqual({ sequence: 3, state: 'refused', code: 'agents.request_id_replay' });
      expect(await usageCount()).toBe('0');
      expect(await balance()).toBe(before);
    });

    it('a move RS-2 does not allow is agents.run_transition_invalid and leaves the run as it was', async () => {
      const caller = person();
      const session = await caller.session.open({ agentId: 'probe' });
      const ran = await complete(caller, session.id, 'runs:db:final');
      const store = createRunStore(sql);

      await expect(store.move(ran.runId, 'running')).rejects.toBeInstanceOf(RunTransitionError);
      await expect(store.move(ran.runId, 'admitted')).rejects.toMatchObject({
        code: 'agents.run_transition_invalid',
        from: 'completed',
        to: 'admitted',
      });
      expect(await stored(ran.runId)).toMatchObject({ state: 'completed', reply: ran.text });
      expect(await trail(ran.runId)).toHaveLength(3);

      // Two retries racing for one resumable run: the one that read it stale is refused before the engine runs.
      const stale: RunStore = {
        ...store,
        admit: async (input) => {
          const found = await store.admit(input);
          return { ...found, run: { ...found.run, state: 'admitted' } };
        },
      };
      await expect(complete(person({ runStore: stale }), session.id, 'runs:db:final')).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'agents.run_transition_invalid',
      });
      expect(await usageCount()).toBe('1');
      expect(await stored(ran.runId)).toMatchObject({ state: 'completed', reply: ran.text });
      expect(await trail(ran.runId)).toHaveLength(3);
    });

    it('one request id names one request: a retry asking another task is agents.request_id_replay and runs nothing', async () => {
      const session = await runtime.openSession({ userId: USER, agentId: 'probe' });
      const real = createRunStore(sql);
      const crashing: RunStore = { ...real, move: async () => Promise.reject(new Error('crash after admit')) };
      const input = {
        userId: USER,
        sessionId: session.id,
        agentId: 'probe',
        requestId: 'runs:db:other-task',
        task: 'plan',
        assetId: 'IFC',
      };
      let calls = 0;
      const think = () => {
        calls += 1;
        return runtime.think({ sessionId: session.id, requestId: input.requestId, task: input.task, messages: MESSAGES });
      };
      await expect(runRecorded(crashing, input, think)).rejects.toThrow('crash after admit');
      const runId = await runIdOf(input.requestId);

      await expect(runRecorded(real, { ...input, task: 'summary' }, think)).rejects.toMatchObject({
        code: 'agents.request_id_replay',
        userMessageKey: 'agents.error.request_id_replay',
      });
      expect(calls).toBe(0);
      expect(await stored(runId)).toMatchObject({ state: 'admitted', reply: null });
      expect(await trail(runId)).toEqual([{ sequence: 1, state: 'admitted', code: null }]);
      expect(await usageCount()).toBe('0');
    });

    it('two retries racing for a running run past its lease: the one that loses the take-over is refused before the engine runs', async () => {
      const session = await runtime.openSession({ userId: USER, agentId: 'probe' });
      const real = createRunStore(sql);
      const stuck: RunStore = {
        ...real,
        move: async (runId, to, outcome) => (to === 'running' ? real.move(runId, to, outcome) : Promise.reject(new Error('crash mid-run'))),
      };
      const input = { userId: USER, sessionId: session.id, agentId: 'probe', requestId: 'runs:db:lost-race', task: 'plan', assetId: 'IFC' };
      await expect(runRecorded(stuck, input, () => Promise.reject(new Error('crash mid-run')))).rejects.toThrow('crash mid-run');
      const runId = await runIdOf(input.requestId);
      expect(await stored(runId)).toMatchObject({ state: 'running' });

      let calls = 0;
      const think = () => {
        calls += 1;
        return runtime.think({ sessionId: session.id, requestId: input.requestId, task: input.task, messages: MESSAGES });
      };
      const lost: RunStore = { ...real, takeOver: async () => null };
      const later = () => Date.now() + RUN_LEASE_MS + 1;
      await expect(runRecorded(lost, input, think, later)).rejects.toMatchObject({
        code: 'agents.run_transition_invalid',
        from: 'running',
        to: 'running',
      });
      expect(calls).toBe(0);
      expect(await stored(runId)).toMatchObject({ state: 'running', reply: null });
      expect(await trail(runId)).toHaveLength(2);
      expect(await usageCount()).toBe('0');
    });
  });
}
