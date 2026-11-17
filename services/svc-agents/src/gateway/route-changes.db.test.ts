import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, router, signPrincipalHeader } from '@intafaced/contracts';
import { assertTestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import { ModelGateway } from './gateway.js';
import { readRouteOverrides, RouteChangeStore, routeDeskProcedures, RouteTableSync } from './route-changes.js';
import { parseRoutingTable } from './routing.js';

const URL = process.env.TEST_DATABASE_URL_AGENTS ?? 'postgres://svc_agents:svc_agents@localhost:5433/intafaced_test';
const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const SECRET = 'an-agents-route-changes-test-secret-32';
const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
const FOUNDER_A = '44444444-4444-4444-8444-444444444444';
const FOUNDER_B = '66666666-6666-4666-8666-666666666666';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';

function ctxOf(userId: string, scopes: string[]) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '55555555-5555-4555-8555-555555555555',
    scopes,
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-routes',
  });
}

const configured = parseRoutingTable({
  routes: [
    {
      task: 'index.embed',
      providerId: 'primary',
      model: 'embed-sm',
      maxOutputTokens: 1,
      price: { inputPerMillion: '0.1', outputPerMillion: '0' },
      capability: 'embed',
    },
    {
      task: 'own.run',
      providerId: 'primary',
      model: 'reasoning-md',
      maxOutputTokens: 2048,
      price: { inputPerMillion: '1', outputPerMillion: '5' },
    },
  ],
});

// Runs unconditionally: CI provides the database.
{
  const sql = postgres(URL, { max: 4, connection: { search_path: 'agents,public' }, onnotice: () => undefined });
  await assertTestDatabase(sql, 'svc-agents');
  let lock: Awaited<ReturnType<typeof sql.reserve>>;
  let now = new Date('2026-11-16T10:07:00.000Z');
  let gateway: ModelGateway;
  let sync: RouteTableSync;

  const caller = (userId: string, scopes = ['admin:read', 'admin:write']) => {
    const store = new RouteChangeStore({ sql, sync, windowMinutes: 15, now: () => now });
    return router(
      routeDeskProcedures({
        sql,
        gateway,
        store,
        sync,
        feeAssetId: 'USDC',
        routeEngine: () => ({ engine: 'sandbox', metered: true }),
        overrides: readRouteOverrides,
        now: () => now,
      }),
    ).createCaller(ctxOf(userId, scopes));
  };
  const row = async (task = 'index.embed') => (await caller(FOUNDER_A).desk()).routes.find((r) => r.task === task)!;
  let n = 0;
  const rid = () => `test-route-change-${++n}-${Date.now()}`;

  beforeAll(async () => {
    lock = await sql.reserve();
    await lock`select pg_advisory_lock(842671)`;
    try {
      for (const migration of migrations) await sql.unsafe(migration);
    } finally {
      await lock`select pg_advisory_unlock(842671)`;
    }
  }, 120_000);

  beforeEach(async () => {
    // The same lock every svc-agents database suite holds for one test at a time: they share the test database.
    await lock`select pg_advisory_lock(842671)`;
    await sql`TRUNCATE agents.route_change_audit, agents.route_overrides, agents.route_change_requests`;
    now = new Date('2026-11-16T10:07:00.000Z');
    gateway = new ModelGateway([], configured);
    sync = new RouteTableSync(sql, gateway, configured, () => now);
    await sync.refresh();
  });

  afterEach(async () => {
    sync.stop();
    await lock`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lock.release();
    await sql.end({ timeout: 5 });
  });

  describe('the routing table, changed by two founders (J-agents-20)', () => {
    it('#1 reads each task with its provider and model alias from configuration, and its rates', async () => {
      const desk = await caller(FOUNDER_A).desk();
      expect(desk.routes.map((r) => [r.task, r.providerId, r.model, r.providerSource, r.inputPerMillion, r.outputPerMillion])).toEqual([
        ['index.embed', 'primary', 'embed-sm', 'configuration', '0.1', '0'],
        ['own.run', 'primary', 'reasoning-md', 'configuration', '1', '5'],
      ]);
    });

    it('the desk refuses a customer session and a key', async () => {
      await expect(caller(CUSTOMER, ['agents:read']).desk()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('#2 one founder’s change stays pending, and the table does not move; they may withdraw it', async () => {
      const change = await caller(FOUNDER_A).propose({
        task: 'index.embed',
        maxOutputTokens: 2,
        inputPerMillion: '0.1',
        outputPerMillion: '0',
        requestId: rid(),
      });
      expect(change.status).toBe('pending');
      const r = await row();
      expect(r.maxOutputTokens).toBe(1);
      expect(r.pending).toMatchObject({ id: change.id, proposedBy: FOUNDER_A, maxOutputTokens: 2 });
      expect(gateway.routingTable.routes[0]!.maxOutputTokens).toBe(1);
      // A second change of the same task waits for the first to be decided.
      await expect(
        caller(FOUNDER_B).propose({
          task: 'index.embed',
          maxOutputTokens: 3,
          inputPerMillion: '0.1',
          outputPerMillion: '0',
          requestId: rid(),
        }),
      ).rejects.toMatchObject({ message: 'agents.route_change_pending' });
      // The same founder cannot confirm their own change; another founder cannot withdraw it.
      await expect(caller(FOUNDER_A).confirm({ changeId: change.id })).rejects.toMatchObject({
        message: 'agents.route_change_same_founder',
      });
      await expect(caller(FOUNDER_B).withdraw({ changeId: change.id })).rejects.toMatchObject({ message: 'agents.route_change_not_yours' });
      expect((await caller(FOUNDER_A).withdraw({ changeId: change.id })).status).toBe('withdrawn');
      expect((await row()).pending).toBeNull();
      await expect(caller(FOUNDER_B).confirm({ changeId: change.id })).rejects.toMatchObject({
        message: 'agents.route_change_not_pending',
      });
      expect(await readRouteOverrides(sql)).toEqual([]);
    });

    it('a retried proposal lands on the same row; the same request id for another change is refused', async () => {
      const requestId = rid();
      const input = { task: 'index.embed', maxOutputTokens: 2, inputPerMillion: '0.1', outputPerMillion: '0', requestId };
      const first = await caller(FOUNDER_A).propose(input);
      expect((await caller(FOUNDER_A).propose(input)).id).toBe(first.id);
      await expect(caller(FOUNDER_A).propose({ ...input, maxOutputTokens: 9 })).rejects.toMatchObject({
        message: 'agents.route_change_request_reused',
      });
      const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agents.route_change_audit WHERE action = 'propose'`;
      expect(count?.n).toBe(1);
    });

    it('#3 a second founder confirms: the table changes once, with one audit row naming both', async () => {
      const change = await caller(FOUNDER_A).propose({
        task: 'index.embed',
        maxOutputTokens: 2,
        inputPerMillion: '0.1',
        outputPerMillion: '0',
        requestId: rid(),
      });
      const applied = await caller(FOUNDER_B).confirm({ changeId: change.id });
      expect(applied).toMatchObject({ status: 'applied', proposedBy: FOUNDER_A, confirmedBy: FOUNDER_B });
      // Pressed again, it answers what was applied and changes nothing.
      expect((await caller(FOUNDER_B).confirm({ changeId: change.id })).status).toBe('applied');
      expect(gateway.routingTable.routes[0]!.maxOutputTokens).toBe(2);
      const r = await row();
      expect(r.maxOutputTokens).toBe(2);
      expect(r.lastChange).toMatchObject({ proposedBy: FOUNDER_A, confirmedBy: FOUNDER_B });
      const confirms = await sql<{ operator_id: string; proposed_by: string; before: unknown; after: unknown }[]>`
        SELECT operator_id, proposed_by, before, after FROM agents.route_change_audit WHERE action = 'confirm'
      `;
      expect(confirms).toEqual([
        {
          operator_id: FOUNDER_B,
          proposed_by: FOUNDER_A,
          before: { maxOutputTokens: 1, inputPerMillion: '0.1', outputPerMillion: '0' },
          after: { maxOutputTokens: 2, inputPerMillion: '0.1', outputPerMillion: '0' },
        },
      ]);
      // A restart reads the change again over the configured table.
      const restarted = new ModelGateway([], configured);
      await new RouteTableSync(sql, restarted, configured, () => now).refresh();
      expect(restarted.routingTable.routes[0]!.maxOutputTokens).toBe(2);
    });

    it('a rate change affects only future windows: the open window keeps the rate in force when it was confirmed', async () => {
      const change = await caller(FOUNDER_A).propose({
        task: 'own.run',
        maxOutputTokens: 2048,
        inputPerMillion: '2',
        outputPerMillion: '6',
        requestId: rid(),
      });
      await caller(FOUNDER_B).confirm({ changeId: change.id });
      const open = gateway.routingTable.routes.find((r) => r.task === 'own.run')!;
      expect(open.price).toEqual({ inputPerMillion: parseAmount('1'), outputPerMillion: parseAmount('5') });
      const r = await row('own.run');
      expect(r.inputPerMillion).toBe('1');
      expect(r.nextRate).toEqual({ inputPerMillion: '2', outputPerMillion: '6', from: '2026-11-16T10:15:00.000Z' });
      now = new Date('2026-11-16T10:15:00.000Z');
      await sync.refresh();
      const next = gateway.routingTable.routes.find((r) => r.task === 'own.run')!;
      expect(next.price).toEqual({ inputPerMillion: parseAmount('2'), outputPerMillion: parseAmount('6') });
    });

    it('blank rates make the route unpriced: its metered runs refuse agents.price_unset', async () => {
      const change = await caller(FOUNDER_A).propose({
        task: 'own.run',
        maxOutputTokens: 2048,
        inputPerMillion: null,
        outputPerMillion: null,
        requestId: rid(),
      });
      await caller(FOUNDER_B).confirm({ changeId: change.id });
      now = new Date('2026-11-16T10:15:00.000Z');
      await sync.refresh();
      expect(gateway.routingTable.routes.find((r) => r.task === 'own.run')!.price).toBeNull();
      expect((await row('own.run')).inputPerMillion).toBeNull();
    });

    it('refuses a change to no route, one rate without the other, and a change that changes nothing', async () => {
      const base = { maxOutputTokens: 2, inputPerMillion: '0.1', outputPerMillion: '0' };
      await expect(caller(FOUNDER_A).propose({ ...base, task: 'no.route', requestId: rid() })).rejects.toMatchObject({
        message: 'agents.route_not_found',
      });
      await expect(
        caller(FOUNDER_A).propose({ ...base, task: 'index.embed', outputPerMillion: null, requestId: rid() }),
      ).rejects.toMatchObject({ message: 'agents.route_change_invalid' });
      await expect(
        caller(FOUNDER_A).propose({ ...base, task: 'index.embed', maxOutputTokens: 1, inputPerMillion: '0.10', requestId: rid() }),
      ).rejects.toMatchObject({ message: 'agents.route_change_unchanged' });
    });
  });
}
