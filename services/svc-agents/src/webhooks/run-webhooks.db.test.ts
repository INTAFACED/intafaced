import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, resolveTestDatabaseUrl } from '@intafaced/db';
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { ModelGateway } from '../gateway/gateway.js';
import { parseRoutingTable, unpricedTable } from '../gateway/routing.js';
import { UsageMeter } from '../metering/meter.js';
import { MockModelProvider } from '../providers/mock.js';
import { createAgentsRouter, type AgentsRouterDeps } from '../router.js';
import { AgentRuntime } from '../runtime.js';
import { advanceSessionRuns } from '../runs/background.js';
import { MemorySelfFreezeRead } from '../own/self-freeze.js';
import { RunWebhooks } from './run-webhooks.js';
import type { PinnedPostRequest } from './webhook-pinned-post.js';

/**
 * The run webhooks on real Postgres, through the agents router (J-agents-12 #5): a key with agents:read registers an
 * endpoint; each run the person then ends in their own session (a room run completed or refused, a background run) is
 * delivered once, signed; nothing else is. The transport is a recorder, so what was posted is read exactly; the ledger is
 * `MemoryLedger` and the engine the deterministic mock.
 */

// Its own database, made from the migrations (createTestDatabase): no other test file's rows reach these tests.
const URL = resolveTestDatabaseUrl(undefined, 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test');
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const USER = '51515151-5151-4151-8151-515151515151';
const OTHER = '52525252-5252-4252-8252-525252525252';
const KEY_ID = '53535353-5353-4353-8353-535353535353';
const ENDPOINT = '54545454-5454-4454-8454-545454545454';
const SECRET = 'an-agents-run-webhooks-db-test-secret-32';
const ASK = 'TEST: my private prompt';
const MESSAGES = [{ role: 'user' as const, content: ASK }];
const HOOK = 'http://127.0.0.1:9/agents-hook';
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

/** A signed-in person, or with `kid` an API key holding only `scopes`. */
function signed(userId: string, scopes: string[], kid?: string) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '55555555-5555-4555-8555-555555555555',
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
    id: 'req-webhooks',
  });
}

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('svc-agents run webhooks (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db = await createTestDatabase({ service: 'agents', url: URL, migrations });
  const sql = db.sql;

  let ledger: MemoryLedger;
  let provider: MockModelProvider;
  let gateway: ModelGateway;
  let meter: UsageMeter;
  let runtime: AgentRuntime;
  let posts: PinnedPostRequest[];
  let answer: number;
  let hooks: RunWebhooks;

  beforeEach(async () => {
    await sql`
      TRUNCATE agents.run_webhook_deliveries, agents.run_webhook_endpoints, agents.session_background_run_steps,
               agents.session_background_runs, agents.agent_run_events, agents.agent_runs, agents.think_claims,
               agents.usage_records, agents.usage_windows, agents.agent_actions, agents.agent_sessions, agents.agent_definitions
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    provider = new MockModelProvider({ id: 'primary' });
    gateway = new ModelGateway([provider], TABLE);
    meter = new UsageMeter(sql, ledger, { assetId: 'IFC', windowMinutes: 60 });
    runtime = new AgentRuntime(sql, gateway, meter, new MemoryEventBus('svc-agents'), { feeAssetId: 'IFC', meteringEnabled: true });
    await runtime.registerAgent(PROBE);
    for (const userId of [USER, OTHER]) {
      await ledger.post(recipes.deposit({ userId, assetId: 'IFC', amount: amt('1000'), rail: 'test', railRef: `webhooks:fund:${userId}` }));
    }
    posts = [];
    answer = 200;
    hooks = new RunWebhooks(sql, {
      allowLocalHttp: true,
      transport: async (req) => {
        posts.push(req);
        return { status: answer };
      },
    });
  }, 30_000);

  afterAll(async () => {
    await db.drop();
  });

  const deps = (overrides: Partial<AgentsRouterDeps> = {}): AgentsRouterDeps => ({
    runtime,
    gateway,
    meter,
    feeAssetId: 'IFC',
    sql,
    runWebhooks: hooks,
    sessionRuns: { maxSteps: 10, stepMs: 1000 },
    selfFreeze: new MemorySelfFreezeRead(),
    ...overrides,
  });
  const person = (userId = USER, overrides: Partial<AgentsRouterDeps> = {}) =>
    createAgentsRouter(deps(overrides)).createCaller(signed(userId, ['agents:read', 'agents:execute']));
  const key = (userId = USER, scopes = ['agents:read']) => createAgentsRouter(deps()).createCaller(signed(userId, scopes, KEY_ID));
  const roomRun = async (userId: string, requestId: string, overrides: Partial<AgentsRouterDeps> = {}) => {
    const me = person(userId, overrides);
    const session = await me.session.open({ agentId: 'probe' });
    return { session, ran: await me.run.complete({ sessionId: session.id, requestId, task: 'plan', messages: MESSAGES }) };
  };
  const posted = () => posts.map((p) => JSON.parse(p.body) as Record<string, unknown>);

  describe('svc-agents run webhooks on Postgres', { timeout: 20_000 }, () => {
    it('a key with agents:read registers once: the secret is shown on the register that made it; a key without the scope is refused', async () => {
      const made = await key().webhook.register({ endpointId: ENDPOINT, url: HOOK });
      expect(made).toEqual({
        id: ENDPOINT,
        url: HOOK,
        createdAt: expect.any(String),
        secret: expect.stringMatching(/^whsec_[0-9a-f]{64}$/),
      });
      // The same register again is the same endpoint, and the secret is never shown again.
      expect(await key().webhook.register({ endpointId: ENDPOINT, url: HOOK })).toEqual({ ...made, secret: null });
      expect(await key().webhook.list({ limit: 10 })).toEqual([{ ...made, secret: null }]);
      // The same id for another address, or from someone else, is refused and tells nothing about the endpoint.
      await expect(key().webhook.register({ endpointId: ENDPOINT, url: 'http://127.0.0.1:9/other' })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'agents.webhook_endpoint_conflict',
      });
      await expect(key(OTHER).webhook.register({ endpointId: ENDPOINT, url: HOOK })).rejects.toMatchObject({
        message: 'agents.webhook_endpoint_conflict',
      });
      expect(await key(OTHER).webhook.list({ limit: 10 })).toEqual([]);
      // A private or plain-http outside address is refused before anything is stored.
      for (const url of ['http://hooks.example.com/x', 'https://10.0.0.5/x', 'https://svc-ledger/x']) {
        await expect(key().webhook.register({ endpointId: OTHER, url })).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: 'agents.webhook_url_invalid',
        });
      }
      await expect(key(USER, ['trade:read']).webhook.register({ endpointId: OTHER, url: HOOK })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Scope "agents:read" is required',
      });
      await expect(key(USER, ['trade:read']).webhook.list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await sql`SELECT id FROM agents.run_webhook_endpoints`).length).toBe(1);
    });

    it('a key cannot start a run: it reads the run is the person’s own, and nothing is stored', async () => {
      const session = await person().session.open({ agentId: 'probe' });
      for (const scopes of [['agents:read'], ['agents:read', 'agents:execute']]) {
        await expect(key(USER, scopes).session.open({ agentId: 'probe' })).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: 'agents.execute_person_only',
        });
        await expect(
          key(USER, scopes).run.background.start({
            sessionId: session.id,
            requestId: 'webhooks:db:by-key',
            task: 'plan',
            ask: ASK,
            steps: 1,
            notice: 'inapp',
          }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'agents.execute_person_only' });
      }
      expect((await sql`SELECT id FROM agents.session_background_runs`).length).toBe(0);
      expect((await sql`SELECT id FROM agents.agent_runs`).length).toBe(0);
    });

    it('each run the person ends after registering is delivered once, signed, with no prompt; earlier runs and other people’s are not', async () => {
      await roomRun(USER, 'webhooks:db:before');
      const { secret } = await key().webhook.register({ endpointId: ENDPOINT, url: HOOK });
      const { session, ran } = await roomRun(USER, 'webhooks:db:after');
      await roomRun(OTHER, 'webhooks:db:other');
      // A refused run (the route has no rate) ends too, and is delivered with its code.
      const unpriced = new ModelGateway([provider], unpricedTable(TABLE));
      const rt = new AgentRuntime(sql, unpriced, meter, new MemoryEventBus('svc-agents'), { feeAssetId: 'IFC', meteringEnabled: true });
      await expect(roomRun(USER, 'webhooks:db:refused', { runtime: rt, gateway: unpriced })).rejects.toMatchObject({
        message: 'agents.refused.price_unset',
      });
      const [refused] = await sql<Array<{ id: string; session_id: string }>>`
        SELECT id::text AS id, session_id::text AS session_id FROM agents.agent_runs WHERE request_id = 'webhooks:db:refused'
      `;

      expect(await hooks.drain()).toBe(2);
      expect(await hooks.drain()).toBe(0);
      expect(posted()).toEqual([
        {
          id: `agents.run.finished:${ran.runId}:3`,
          type: 'agents.run.finished',
          kind: 'run',
          runId: ran.runId,
          sessionId: session.id,
          agentId: 'probe',
          state: 'completed',
          reply: ran.text,
          cost: ran.cost,
          assetId: 'IFC',
          refusalCodes: [],
        },
        {
          id: `agents.run.finished:${refused!.id}:3`,
          type: 'agents.run.finished',
          kind: 'run',
          runId: refused!.id,
          sessionId: refused!.session_id,
          agentId: 'probe',
          state: 'refused',
          reply: null,
          cost: null,
          assetId: null,
          refusalCodes: ['agents.price_unset'],
        },
      ]);
      for (const post of posts) {
        expect(post.url.toString()).toBe(HOOK);
        expect(post.body).not.toContain(ASK);
        const event = (JSON.parse(post.body) as { id: string }).id;
        expect(post.headers['x-intafaced-event-id']).toBe(event);
        expect(post.headers['idempotency-key']).toBe(event);
        const signature = createHmac('sha256', secret!).update(`${post.headers['x-intafaced-timestamp']}.${post.body}`).digest('hex');
        expect(post.headers['x-intafaced-signature']).toBe(`v1=${signature}`);
      }
      const read = await key().webhook.deliveries({ limit: 50 });
      expect(
        read.map(({ runId, kind, runState, state, attempts, lastStatus }) => ({ runId, kind, runState, state, attempts, lastStatus })),
      ).toEqual([
        { runId: ran.runId, kind: 'run', runState: 'completed', state: 'delivered', attempts: 1, lastStatus: 200 },
        { runId: refused!.id, kind: 'run', runState: 'refused', state: 'delivered', attempts: 1, lastStatus: 200 },
      ]);
      expect(await key().webhook.deliveries({ runId: ran.runId, limit: 50 })).toEqual([read[0]]);
      expect(await key(OTHER).webhook.deliveries({ limit: 50 })).toEqual([]);
    });

    it('a background run is delivered once when it completes, with its last reply and summed cost', async () => {
      await key().webhook.register({ endpointId: ENDPOINT, url: HOOK });
      const me = person();
      const session = await me.session.open({ agentId: 'probe' });
      const run = await me.run.background.start({
        sessionId: session.id,
        requestId: 'webhooks:db:bg',
        task: 'plan',
        ask: ASK,
        steps: 2,
        notice: 'inapp',
      });
      for (let i = 0; i < 6; i++) await advanceSessionRuns(sql, runtime, 0, 50, 'IFC');
      const done = await me.run.background.get({ runId: run.runId });
      expect(done.state).toBe('completed');
      expect(await hooks.drain()).toBe(1);
      const sum = done.steps.reduce((total, s) => total + amt(s.cost!), 0n);
      expect(posted()).toEqual([
        {
          id: `agents.background_run.finished:${run.runId}:1`,
          type: 'agents.run.finished',
          kind: 'background',
          runId: run.runId,
          sessionId: session.id,
          agentId: 'probe',
          state: 'completed',
          reply: done.reply,
          cost: expect.any(String),
          assetId: 'IFC',
          refusalCodes: [],
        },
      ]);
      expect(amt(posted()[0]!.cost as string)).toBe(sum);
      expect(posts[0]!.body).not.toContain(ASK);
      // More ticks end nothing again.
      await advanceSessionRuns(sql, runtime, 0, 50, 'IFC');
      expect(await hooks.drain()).toBe(0);
    });

    it('an endpoint that does not take the post is marked failed with its answer, once; the run itself is unchanged', async () => {
      await key().webhook.register({ endpointId: ENDPOINT, url: HOOK });
      answer = 500;
      const { ran } = await roomRun(USER, 'webhooks:db:fails');
      expect(await hooks.drain()).toBe(1);
      expect(await hooks.drain()).toBe(0);
      expect(await key().webhook.deliveries({ limit: 50 })).toMatchObject([
        { runId: ran.runId, state: 'failed', attempts: 1, lastStatus: 500 },
      ]);
      expect((await key().run.get({ runId: ran.runId })).state).toBe('completed');
    });

    it('with no webhooks wired every webhook call refuses by name', async () => {
      const bare = createAgentsRouter(deps({ runWebhooks: null })).createCaller(signed(USER, ['agents:read'], KEY_ID));
      await expect(bare.webhook.list({ limit: 10 })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'agents.webhooks_unwired',
      });
    });
  });
}
