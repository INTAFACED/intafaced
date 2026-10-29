import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { createAgentsRouter, type AgentsRouterDeps } from '../router.js';

const URL = process.env.TEST_DATABASE_URL_AGENTS ?? 'postgres://svc_agents:svc_agents@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SECRET = 'an-agents-own-agent-test-secret-of-32-plus-chars';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });

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
    id: 'req-own',
  });
}

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('own agents (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 4,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-own-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');
  const router = createAgentsRouter({
    runtime: {} as AgentsRouterDeps['runtime'],
    gateway: { routingTable: { routes: [] } } as unknown as AgentsRouterDeps['gateway'],
    meter: {} as AgentsRouterDeps['meter'],
    feeAssetId: 'IFC',
    sql,
  });
  const person = router.createCaller(callerFor(USER, ['agents:read', 'identity:write']));
  const other = router.createCaller(callerFor(OTHER, ['agents:read', 'identity:write']));
  const balance = async () => (await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM agents.usage_windows`)[0]!.n;

  beforeAll(async () => {
    const lock = await sql.reserve();
    await lock`select pg_advisory_lock(842671)`;
    try {
      for (const migration of migrations) await sql.unsafe(migration);
    } finally {
      await lock`select pg_advisory_unlock(842671)`;
      lock.release();
    }
  }, 120_000);

  beforeEach(async () => {
    await sql`TRUNCATE agents.own_agents`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it('creates a draft from the service starter with its tools and no cap; a retried create is the same draft, a new one the next', async () => {
    const before = await balance();
    const first = await person.own.create({ template: 'service-starter', createKey: 'picker:one' });
    expect(first).toMatchObject({ state: 'draft', version: 1, perSessionCap: null, name: '' });
    expect(first.tools).toEqual(['support.kb.search', 'support.ticket.read', 'identity.account.read']);
    expect(first.findings.map((f) => f.code)).toEqual(['agents.spend.cap_unset', 'agents.own.name_unset']);
    expect((await person.own.create({ template: 'service-starter', createKey: 'picker:one' })).id).toBe(first.id);
    const second = await person.own.create({ template: 'service-starter', createKey: 'picker:two' });
    expect(second.id).not.toBe(first.id);
    expect((await person.own.list({ limit: 10 })).map((a) => a.id)).toEqual([second.id, first.id]);
    // Building an agent moves no value.
    expect(await balance()).toBe(before);
  });

  it('saves the name, instructions, tools and cap; the cap clears its finding', async () => {
    const { id } = await person.own.create({ template: 'service-starter', createKey: 'picker:save' });
    const saved = await person.own.save({
      id,
      name: 'TEST helper',
      instructions: 'Answer TEST questions.',
      tools: ['trade.quote'],
      perSessionCap: '1',
    });
    expect(saved).toMatchObject({ name: 'TEST helper', tools: ['trade.quote'], perSessionCap: '1', findings: [] });
    expect(await person.own.get({ id })).toMatchObject({ name: 'TEST helper', perSessionCap: '1' });
  });

  it('refuses a money tool and a reserved name with their codes, and stores nothing from the refused save', async () => {
    const { id } = await person.own.create({ template: 'service-starter', createKey: 'picker:refuse' });
    const base = { id, name: 'TEST helper', instructions: '', tools: [] as string[], perSessionCap: null };
    await expect(person.own.save({ ...base, tools: ['ledger.transfer'] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'agents.own.money_tool',
    });
    await expect(person.own.save({ ...base, name: 'sessions' })).rejects.toMatchObject({ message: 'agents.own.reserved_name' });
    expect(await person.own.get({ id })).toMatchObject({
      name: '',
      tools: ['support.kb.search', 'support.ticket.read', 'identity.account.read'],
    });
  });

  it('never reads or writes another person’s agent, and a delegated token cannot build', async () => {
    const { id } = await person.own.create({ template: 'blank', createKey: 'picker:mine' });
    await expect(other.own.get({ id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(other.own.save({ id, name: 'x', instructions: '', tools: [], perSessionCap: null })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await other.own.list({ limit: 10 })).toEqual([]);
    await expect(other.own.get({ id: 'not-a-uuid' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const delegated = router.createCaller(
      callerFor(USER, ['agents:read', 'identity:write'], { kid: '66666666-6666-4666-8666-666666666666' }),
    );
    await expect(delegated.own.create({ template: 'blank', createKey: 'picker:delegated' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(delegated.own.list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(delegated.own.get({ id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const readOnly = router.createCaller(callerFor(USER, ['agents:read']));
    await expect(readOnly.own.create({ template: 'blank', createKey: 'picker:read' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a template it does not offer', async () => {
    await expect(person.own.create({ template: 'trader', createKey: 'picker:bad' })).rejects.toMatchObject({
      message: 'agents.own.template_unknown',
    });
  });
}
