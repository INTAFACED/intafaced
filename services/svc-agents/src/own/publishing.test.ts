import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, type Amount } from '@intafaced/ledger-client';
import { ModelGateway } from '../gateway/gateway.js';
import { parseRoutingTable } from '../gateway/routing.js';
import { UsageMeter } from '../metering/meter.js';
import { MockModelProvider } from '../providers/mock.js';
import { createAgentsRouter } from '../router.js';
import { AgentRuntime } from '../runtime.js';
import { UserSpendStore } from '../spend/store.js';
import { createFixtureSupportDesk } from '../support-agent/desk-port.js';
import { checkCoOwner, checkSurfaces, OWN_AGENT_CHILD_TABLES } from './publishing.js';
import { OWN_RUN_TASK } from './routes.js';

/**
 * Publishing, sharing and deleting a person's own agent (AG-builder-03; J-agents-03 #7, #8), through the service's own
 * routes on real Postgres: a published version never changes and an edit after it is the next version, a draft; a
 * publish moves only the surfaces chosen; a session keeps the version it opened on, and its runs read that version's
 * instructions; a forbidden surface refuses with its reason; a group is never a co-owner; a draft is deleted only
 * with the confirmation, and a published one never.
 */

const URL = process.env.TEST_DATABASE_URL_AGENTS ?? 'postgres://svc_agents:svc_agents@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrationFiles = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort();
const migrations = migrationFiles.map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const FROZEN = '33333333-3333-4333-8333-333333333333';
const SECRET = 'an-agents-own-publish-test-secret-of-32-plus-chars';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
const PERSON = ['agents:read', 'agents:execute', 'identity:write'];

function callerFor(userId: string, scopes: string[]) {
  const principal = {
    sub: userId,
    userId,
    sid: '55555555-5555-4555-8555-555555555555',
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-own-publish',
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
const V1 = 'Answer TEST questions.';
const V2 = 'Answer TEST questions, briefly.';
const CONFIRM = 'delete for good';

describe('own agent publishing policy', () => {
  it('a surface the policy forbids is refused with its reason; an unknown one is unknown', () => {
    expect(checkSurfaces(['my_agents', 'chat', 'my_agents'])).toEqual(['my_agents', 'chat']);
    expect(() => checkSurfaces(['public_catalogue'])).toThrow('agents.own.surface_not_reviewed');
    expect(() => checkSurfaces(['my_agents', 'public_catalogue'])).toThrow('agents.own.surface_not_reviewed');
    expect(() => checkSurfaces(['billboard'])).toThrow('agents.own.surface_unknown');
  });

  it('a co-owner is one person: a group, team or business is refused, and so is the owner', () => {
    for (const group of ['group:TEST-team', 'team:abc', 'Business:42', 'org:x']) {
      expect(() => checkCoOwner(USER, group)).toThrow('agents.own.co_owner_group');
    }
    expect(() => checkCoOwner(USER, USER.toUpperCase())).toThrow('agents.own.co_owner_self');
    expect(() => checkCoOwner(USER, 'TEST friend')).toThrow('agents.own.co_owner_invalid');
    expect(checkCoOwner(USER, ` ${OTHER.toUpperCase()} `)).toBe(OTHER);
  });

  it('a delete removes the rows of every table that refers to an own agent', () => {
    const referring = new Set<string>();
    for (const file of migrationFiles) {
      const text = readFileSync(join(drizzleDir, file), 'utf8');
      for (const match of text.matchAll(/CREATE TABLE IF NOT EXISTS "agents"\."(\w+)" \(([\s\S]*?)\n\);/g)) {
        if (/REFERENCES "agents"\."own_agents"/.test(match[2]!)) referring.add(match[1]!);
      }
    }
    expect([...referring].sort()).toEqual([...OWN_AGENT_CHILD_TABLES].sort());
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('own agent publishing (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 6,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-own-publish-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');
  let lockConn: Awaited<ReturnType<typeof sql.reserve>>;
  const systems: Array<string | undefined> = [];
  const balance: Amount = 100n * 10n ** 18n;

  function build() {
    const provider = new MockModelProvider({ id: 'primary' });
    const inner = new ModelGateway([provider], TABLE);
    const gateway = Object.create(inner) as ModelGateway;
    gateway.complete = async (task: string, request: Parameters<ModelGateway['complete']>[1]) => {
      systems.push(request.system);
      return inner.complete(task, request);
    };
    const meter = new UsageMeter(sql, new MemoryLedger(), { assetId: 'USDT', windowMinutes: 60 });
    const runtime = new AgentRuntime(sql, gateway, meter, new MemoryEventBus('svc-agents'), {
      feeAssetId: 'USDT',
      meteringEnabled: true,
      spend: new UserSpendStore(sql),
      funds: { available: async () => balance },
    });
    const supportDesk = createFixtureSupportDesk({
      accounts: [
        { userId: OTHER, status: 'active', kycTier: 'full' },
        { userId: FROZEN, status: 'frozen', kycTier: 'full' },
      ],
    });
    const router = createAgentsRouter({ runtime, gateway, meter, feeAssetId: 'USDT', sql, supportDesk });
    return { person: router.createCaller(callerFor(USER, PERSON)), other: router.createCaller(callerFor(OTHER, PERSON)) };
  }
  type Caller = ReturnType<typeof build>['person'];

  async function agentWith(person: Caller, cap: string | null = '1', name = 'TEST helper') {
    const { id } = await person.own.create({ template: 'service-starter', createKey: `publish:${Math.random()}` });
    await person.own.save({ id, name, instructions: V1, tools: ['support.kb.search'], perSessionCap: cap });
    return id;
  }
  const edit = (person: Caller, id: string, instructions: string) =>
    person.own.save({ id, name: 'TEST helper', instructions, tools: ['support.kb.search'], perSessionCap: '1' });

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
      TRUNCATE agents.own_agent_background_runs, agents.own_agent_surfaces, agents.own_agent_versions, agents.own_agent_co_owners, agents.own_agent_session_versions, agents.own_agent_limits,
               agents.own_agents, agents.spend_reservations, agents.user_spend_limits, agents.think_claims,
               agents.usage_records, agents.usage_windows, agents.agent_actions, agents.agent_sessions
      RESTART IDENTITY CASCADE
    `;
    systems.length = 0;
  });

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  describe('own agent publishing', () => {
    it('refuses a draft with a blocking finding, and a forbidden surface, publishing nothing', async () => {
      const { person } = build();
      const capless = await agentWith(person, null);
      await expect(person.own.publish({ id: capless, surfaces: ['my_agents'] })).rejects.toMatchObject({
        message: 'agents.spend.cap_unset',
      });
      const id = await agentWith(person);
      await expect(person.own.publish({ id, surfaces: ['my_agents', 'public_catalogue'] })).rejects.toMatchObject({
        message: 'agents.own.surface_not_reviewed',
      });
      for (const agent of [capless, id]) {
        const publication = await person.own.publication({ id: agent });
        expect(publication).toMatchObject({ version: 1, state: 'draft', versions: [] });
        expect(publication.surfaces.every((surface) => surface.version === null)).toBe(true);
      }
      expect((await person.own.publication({ id })).surfaces.find((s) => s.surface === 'public_catalogue')).toEqual({
        surface: 'public_catalogue',
        allowed: false,
        forbiddenCode: 'agents.own.surface_not_reviewed',
        version: null,
      });
    });

    it('version 1 never changes; the edit is version 2, a draft; republishing moves only the surface chosen', async () => {
      const { person } = build();
      const id = await agentWith(person);
      const first = await person.own.publish({ id, surfaces: ['my_agents'] });
      expect(first).toMatchObject({ version: 1, state: 'published' });
      expect(first.versions).toMatchObject([{ version: 1, instructions: V1, tools: ['support.kb.search'], perSessionCap: '1' }]);
      const surfaceOf = (p: typeof first, s: string) => p.surfaces.find((row) => row.surface === s)?.version;
      expect(surfaceOf(first, 'my_agents')).toBe(1);
      expect(surfaceOf(first, 'chat')).toBeNull();

      expect(await edit(person, id, V2)).toMatchObject({ version: 2, state: 'draft', instructions: V2 });
      // A second save of the draft is still version 2.
      expect(await edit(person, id, V2)).toMatchObject({ version: 2, state: 'draft' });
      expect((await person.own.publication({ id })).versions).toEqual(first.versions);

      const second = await person.own.publish({ id, surfaces: ['chat'] });
      expect(second).toMatchObject({ version: 2, state: 'published' });
      expect(second.versions.map((v) => [v.version, v.instructions])).toEqual([
        [1, V1],
        [2, V2],
      ]);
      expect(second.versions[0]).toEqual(first.versions[0]);
      expect(surfaceOf(second, 'chat')).toBe(2);
      expect(surfaceOf(second, 'my_agents')).toBe(1);

      // Publishing the same version again is the same version; the table refuses any change to a published one.
      expect((await person.own.publish({ id, surfaces: ['chat'] })).versions).toEqual(second.versions);
      await expect(sql`UPDATE agents.own_agent_versions SET instructions = 'changed' WHERE agent_id = ${id}`).rejects.toThrow(
        'agents.own.version_immutable',
      );
    });

    it('a session keeps the version it opened on, and its runs read that version’s instructions', async () => {
      const { person } = build();
      const id = await agentWith(person);
      await person.own.limits.set({ id, perCall: '0.5', perSession: '1', perPeriod: '5' });
      await person.own.publish({ id, surfaces: ['my_agents'] });
      const v1 = await person.own.session.open({ id });
      expect(v1.version).toBe(1);
      await edit(person, id, V2);
      await person.own.publish({ id, surfaces: ['my_agents'] });
      const v2 = await person.own.session.open({ id });
      expect(v2.version).toBe(2);
      expect((await person.own.publication({ id })).openSessions).toEqual([
        { sessionId: v1.sessionId, version: 1 },
        { sessionId: v2.sessionId, version: 2 },
      ]);
      await person.own.run({ id, sessionId: v1.sessionId, requestId: 'publish:run:v1', ask: 'TEST question' });
      await person.own.run({ id, sessionId: v2.sessionId, requestId: 'publish:run:v2', ask: 'TEST question' });
      expect(systems).toEqual([V1, V2]);
    });

    it('a session opened on a draft keeps the instructions it opened on, though the draft is edited after', async () => {
      const { person } = build();
      const id = await agentWith(person);
      await person.own.limits.set({ id, perCall: '0.5', perSession: '1', perPeriod: '5' });
      const opened = await person.own.session.open({ id });
      expect(opened.version).toBe(1);
      await edit(person, id, V2);
      expect(await person.own.get({ id })).toMatchObject({ version: 1, state: 'draft', instructions: V2 });
      await person.own.run({ id, sessionId: opened.sessionId, requestId: 'publish:run:draft', ask: 'TEST question' });
      expect(systems).toEqual([V1]);
    });

    it('a save that changes nothing leaves a published agent published at its version', async () => {
      const { person } = build();
      const id = await agentWith(person);
      await person.own.publish({ id, surfaces: ['my_agents'] });
      expect(await edit(person, id, V1)).toMatchObject({ version: 1, state: 'published' });
      expect(await edit(person, id, V2)).toMatchObject({ version: 2, state: 'draft' });
      expect(await edit(person, id, V2)).toMatchObject({ version: 2, state: 'draft' });
    });

    it('another person can neither read nor publish the agent', async () => {
      const { person, other } = build();
      const id = await agentWith(person);
      await expect(other.own.publish({ id, surfaces: ['my_agents'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(other.own.publication({ id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await person.own.publication({ id })).versions).toEqual([]);
    });
  });

  describe('own agent sharing', () => {
    it('adds one active person as co-owner, once; a group, the owner, a frozen or unread account is refused', async () => {
      const { person, other } = build();
      const id = await agentWith(person);
      await expect(person.own.coOwners.add({ id, coOwner: 'group:TEST-team' })).rejects.toMatchObject({
        message: 'agents.own.co_owner_group',
      });
      await expect(person.own.coOwners.add({ id, coOwner: USER })).rejects.toMatchObject({ message: 'agents.own.co_owner_self' });
      await expect(person.own.coOwners.add({ id, coOwner: FROZEN })).rejects.toMatchObject({ message: 'agents.own.co_owner_inactive' });
      await expect(person.own.coOwners.add({ id, coOwner: '44444444-4444-4444-8444-444444444444' })).rejects.toMatchObject({
        message: 'agents.own.co_owner_unread',
      });
      // A business named by its bare id is a group too.
      const business = '55555555-5555-4555-8555-555555555555';
      await sql`
        INSERT INTO agents.team_pools (business_id, asset_id, pool_limit, version, idempotency_key, digest, set_by)
        VALUES (${business}, 'USDT', 1, 1, ${'publish-test:' + Math.random()}, 'TEST', ${USER})
      `;
      try {
        await expect(person.own.coOwners.add({ id, coOwner: business })).rejects.toMatchObject({ message: 'agents.own.co_owner_group' });
      } finally {
        await sql`DELETE FROM agents.team_pools WHERE business_id = ${business}`;
      }
      expect(await person.own.coOwners.list({ id })).toEqual([]);
      const added = await person.own.coOwners.add({ id, coOwner: OTHER });
      expect(added.map((row) => row.userId)).toEqual([OTHER]);
      expect((await person.own.coOwners.add({ id, coOwner: OTHER })).map((row) => row.userId)).toEqual([OTHER]);
      expect(await other.own.sharedWithMe({ limit: 10 })).toEqual([{ id, ownerId: USER, name: 'TEST helper', version: 1, state: 'draft' }]);
      // A co-owner cannot add co-owners to an agent that is not theirs.
      await expect(other.own.coOwners.add({ id, coOwner: FROZEN })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await person.own.coOwners.remove({ id, coOwner: OTHER });
      expect(await other.own.sharedWithMe({ limit: 10 })).toEqual([]);
    });
  });

  describe('own agent deleting', () => {
    it('deletes a draft only with the confirmation, for good; a published agent or one that ran a session is kept', async () => {
      const { person, other } = build();
      const spare = await agentWith(person, '1', 'TEST spare');
      await person.own.limits.set({ id: spare, perCall: '0.5', perSession: '1', perPeriod: '5' });
      await person.own.coOwners.add({ id: spare, coOwner: OTHER });
      await expect(person.own.delete({ id: spare, confirm: 'yes' })).rejects.toMatchObject({ message: 'agents.own.delete_unconfirmed' });
      await expect(other.own.delete({ id: spare, confirm: CONFIRM })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await person.own.get({ id: spare })).name).toBe('TEST spare');
      expect(await person.own.delete({ id: spare, confirm: CONFIRM })).toEqual({ id: spare, deleted: true });
      await expect(person.own.get({ id: spare })).rejects.toMatchObject({ message: 'agents.own.not_found' });
      await expect(person.own.delete({ id: spare, confirm: CONFIRM })).rejects.toMatchObject({ message: 'agents.own.not_found' });
      expect(await other.own.sharedWithMe({ limit: 10 })).toEqual([]);

      const published = await agentWith(person);
      await person.own.publish({ id: published, surfaces: ['my_agents'] });
      await expect(person.own.delete({ id: published, confirm: CONFIRM })).rejects.toMatchObject({
        message: 'agents.own.delete_published',
      });
      // Still refused once edited back to a draft: its published version stays.
      await edit(person, published, V2);
      await expect(person.own.delete({ id: published, confirm: CONFIRM })).rejects.toMatchObject({
        message: 'agents.own.delete_published',
      });

      const ran = await agentWith(person);
      await person.own.limits.set({ id: ran, perCall: '0.5', perSession: '1', perPeriod: '5' });
      await person.own.session.open({ id: ran });
      await expect(person.own.delete({ id: ran, confirm: CONFIRM })).rejects.toMatchObject({
        message: 'agents.own.delete_has_sessions',
      });
      expect((await person.own.list({ limit: 10 })).map((row) => row.id).sort()).toEqual([published, ran].sort());
    });
  });
}
