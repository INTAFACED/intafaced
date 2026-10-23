import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { AgentError } from '../errors.js';
import { createAgentsRouter } from '../router.js';
import type { AgentsRouterDeps } from '../router.js';
import { UserSpendStore } from './store.js';

const URL = process.env.TEST_DATABASE_URL_AGENTS ?? 'postgres://svc_agents:svc_agents@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const OTHER_SESSION = '44444444-4444-4444-8444-444444444444';
const SECRET = 'an-agents-spend-limit-test-secret';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });

function callerFor(scopes: string[], extra: { kid?: string; sub_account?: string } = {}) {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '55555555-5555-4555-8555-555555555555',
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...(extra.kid ? { kid: extra.kid } : {}),
    ...(extra.sub_account ? { sub_account: extra.sub_account } : {}),
  } as Principal;
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-spend',
  });
}

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('user spend limits (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 4,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-spend-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');
  for (const migration of migrations) await sql.unsafe(migration);
  const store = new UserSpendStore(sql);

  const caps = {
    userId: USER,
    assetId: 'IFC',
    perCall: '2',
    perSession: '3',
    perPeriod: '4',
    period: 'week' as const,
    idempotencyKey: 'set-caps',
  };

  beforeEach(async () => {
    await sql`
      TRUNCATE agents.spend_reservations, agents.spend_limit_requests, agents.user_spend_limits, agents.agent_sessions
      RESTART IDENTITY CASCADE
    `;
    await sql`
      INSERT INTO agents.agent_sessions (id, user_id, agent_id, guardrail, guardrail_version)
      VALUES
        (${SESSION}, ${USER}, 'probe', ${sql.json({ limits: { maxSpendPerSession: null } })}, 1),
        (${OTHER_SESSION}, ${OTHER}, 'probe', ${sql.json({ limits: {} })}, 1)
    `;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it('reads an unset limit as null, never as zero', async () => {
    expect(await store.get(USER)).toBeNull();
  });

  it('stores an explicit zero and replays the same request as one write', async () => {
    const first = await store.set({ ...caps, perCall: '0', perSession: '0.0', perPeriod: '0' });
    expect(first.replayed).toBe(false);
    expect(first.limits).toMatchObject({ perCall: '0', perSession: '0', perPeriod: '0', assetId: 'IFC', period: 'week' });
    const again = await store.set({ ...caps, perCall: '0.00', perSession: '0', perPeriod: '0.0' });
    expect(again.replayed).toBe(true);
    expect(again.limits.perCall).toBe('0');
    const rows = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM agents.user_spend_limits WHERE user_id = ${USER}`;
    expect(rows[0]?.n).toBe('1');
    const writes = await sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM agents.spend_limit_requests WHERE user_id = ${USER}
    `;
    expect(writes[0]?.n).toBe('1');
  });

  it('refuses the same key with a different body and leaves the stored cap', async () => {
    await store.set(caps);
    await expect(store.set({ ...caps, perCall: '9' })).rejects.toMatchObject({ code: 'agents.spend_idempotency_conflict' });
    expect(await store.get(USER)).toMatchObject({ perCall: '2' });
  });

  it('two identical concurrent sets leave one row', async () => {
    const [a, b] = await Promise.all([store.set(caps), store.set(caps)]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    const rows = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM agents.user_spend_limits`;
    expect(rows[0]?.n).toBe('1');
  });

  it('refuses a reservation above the per-call cap and writes nothing', async () => {
    await store.set(caps);
    await expect(
      store.reserve({
        userId: USER,
        sessionId: SESSION,
        reservationKey: 'too-big',
        assetId: 'IFC',
        amount: '2.01',
        now: new Date('2026-10-23T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'agents.spend_limit' });
    const rows = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM agents.spend_reservations`;
    expect(rows[0]?.n).toBe('0');
  });

  it('refuses another user session and a different asset without converting', async () => {
    await store.set(caps);
    await expect(
      store.reserve({ userId: USER, sessionId: OTHER_SESSION, reservationKey: 'k', assetId: 'IFC', amount: '1' }),
    ).rejects.toMatchObject({ code: 'agents.session_not_found' });
    await expect(
      store.reserve({ userId: USER, sessionId: SESSION, reservationKey: 'k', assetId: 'OTHER', amount: '1' }),
    ).rejects.toMatchObject({ code: 'agents.spend_limit_invalid' });
  });

  it('counts a previous week against the session cap but not the new week', async () => {
    await store.set({ ...caps, perCall: '5', perSession: '5', perPeriod: '5' });
    const lastWeek = await store.reserve({
      userId: USER,
      sessionId: SESSION,
      reservationKey: 'last',
      assetId: 'IFC',
      amount: '5',
      now: new Date('2026-10-18T12:00:00Z'),
    });
    expect(lastWeek.status).toBe('held');
    await expect(
      store.reserve({
        userId: USER,
        sessionId: SESSION,
        reservationKey: 'this',
        assetId: 'IFC',
        amount: '1',
        now: new Date('2026-10-23T12:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'agents.spend_limit', userMessageParams: { scope: 'session' } });
    await store.release({ userId: USER, reservationKey: 'last' });
    const again = await store.reserve({
      userId: USER,
      sessionId: SESSION,
      reservationKey: 'this',
      assetId: 'IFC',
      amount: '5',
      now: new Date('2026-10-23T12:00:00Z'),
    });
    expect(again.status).toBe('held');
    expect(again.replayed).toBe(false);
  });

  it('commits once, replays the same amount, and refuses a higher actual', async () => {
    await store.set(caps);
    await store.reserve({ userId: USER, sessionId: SESSION, reservationKey: 'hold', assetId: 'IFC', amount: '2' });
    const committed = await store.commit({ userId: USER, reservationKey: 'hold', amount: '1.25' });
    expect(committed).toMatchObject({ status: 'committed', committedAmount: '1.25', amount: '2', replayed: false });
    const replay = await store.commit({ userId: USER, reservationKey: 'hold', amount: '1.250' });
    expect(replay.replayed).toBe(true);
    expect(replay.committedAmount).toBe('1.25');
    await expect(store.commit({ userId: USER, reservationKey: 'hold', amount: '1' })).rejects.toMatchObject({
      code: 'agents.spend_reservation_conflict',
    });
    await expect(store.release({ userId: USER, reservationKey: 'hold' })).rejects.toMatchObject({
      code: 'agents.spend_reservation_closed',
    });
  });

  it('two identical concurrent reservations leave one hold', async () => {
    await store.set(caps);
    const input = {
      userId: USER,
      sessionId: SESSION,
      reservationKey: 'same',
      assetId: 'IFC',
      amount: '1',
      now: new Date('2026-10-23T12:00:00Z'),
    };
    const [a, b] = await Promise.all([store.reserve(input), store.reserve(input)]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    const rows = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM agents.spend_reservations`;
    expect(rows[0]?.n).toBe('1');
  });

  it('a blank reservation amount refuses and does not insert', async () => {
    await store.set(caps);
    await expect(
      store.reserve({ userId: USER, sessionId: SESSION, reservationKey: 'blank', assetId: 'IFC', amount: ' ' }),
    ).rejects.toBeInstanceOf(AgentError);
    const rows = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM agents.spend_reservations`;
    expect(rows[0]?.n).toBe('0');
  });

  it('the door refuses a blank cap for the caller and does not read another user', async () => {
    const deps = {
      runtime: {} as AgentsRouterDeps['runtime'],
      gateway: { routingTable: { routes: [] } } as unknown as AgentsRouterDeps['gateway'],
      meter: {} as AgentsRouterDeps['meter'],
      feeAssetId: 'IFC',
      sql,
    };
    const caller = createAgentsRouter(deps).createCaller(callerFor(['agents:read', 'identity:write']));
    await expect(
      caller.spend.limits.set({ idempotencyKey: 'door', assetId: 'IFC', perCall: '', perSession: '1', perPeriod: '1', period: 'day' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { code: 'agents.spend_limit_unset' },
    });
    expect(await caller.spend.limits.get()).toEqual({ limits: null });
    await caller.spend.limits.set({
      idempotencyKey: 'door-2',
      assetId: 'IFC',
      perCall: '1',
      perSession: '1',
      perPeriod: '1',
      period: 'day',
    });
    expect(await caller.spend.limits.get()).toMatchObject({
      limits: { perCall: '1', perSession: '1', perPeriod: '1', period: 'day', assetId: 'IFC' },
    });
    expect(await store.get(OTHER)).toBeNull();
  });

  it('an agents:execute caller without the user session cannot set a limit, and there is no public release', async () => {
    const deps = {
      runtime: {} as AgentsRouterDeps['runtime'],
      gateway: { routingTable: { routes: [] } } as unknown as AgentsRouterDeps['gateway'],
      meter: {} as AgentsRouterDeps['meter'],
      feeAssetId: 'IFC',
      sql,
    };
    const router = createAgentsRouter(deps);
    const person = router.createCaller(callerFor(['agents:read', 'identity:write']));
    await person.spend.limits.set({
      idempotencyKey: 'person-cap',
      assetId: 'IFC',
      perCall: '1',
      perSession: '1',
      perPeriod: '1',
      period: 'day',
    });
    const raise = {
      idempotencyKey: 'agent-raise',
      assetId: 'IFC',
      perCall: '9',
      perSession: '9',
      perPeriod: '9',
      period: 'day' as const,
    };
    const executeOnly = router.createCaller(callerFor(['agents:execute']));
    await expect(executeOnly.spend.limits.set(raise)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const withRead = router.createCaller(callerFor(['agents:execute', 'agents:read']));
    await expect(withRead.spend.limits.set(raise)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const delegated = router.createCaller(
      callerFor(['agents:read', 'identity:write', 'agents:execute'], { kid: '66666666-6666-4666-8666-666666666666' }),
    );
    await expect(delegated.spend.limits.set(raise)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await person.spend.limits.get()).toMatchObject({
      limits: { perCall: '1', perSession: '1', perPeriod: '1', period: 'day', assetId: 'IFC' },
    });
    expect('release' in person.spend).toBe(false);
    expect('reserve' in person.spend).toBe(false);
    expect('commit' in person.spend).toBe(false);
  });
}
