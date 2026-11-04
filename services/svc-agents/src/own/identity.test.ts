import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger } from '@intafaced/ledger-client';
import { ModelGateway } from '../gateway/gateway.js';
import { parseRoutingTable } from '../gateway/routing.js';
import { UsageMeter } from '../metering/meter.js';
import { MockModelProvider } from '../providers/mock.js';
import { createAgentsRouter } from '../router.js';
import { AgentRuntime } from '../runtime.js';
import { UserSpendStore } from '../spend/store.js';
import { createFixtureSupportDesk } from '../support-agent/desk-port.js';
import { assistantEngine, draftAgent, testEngineDraft } from './assistant.js';
import { OwnIdentityStore, tokenLifetime } from './identity.js';

/**
 * An own agent's identity and the drafting assistant (AG-identity-01, AG-builder-03; J-agents-03 #5, #6), through the
 * service's own routes on real Postgres: the token's owner, scopes and expiry; a revoked, expired or reissued token
 * fails its next call, and so does one whose owner is frozen or cannot be read; a blank lifetime issues nothing. A
 * blank model choice drafts nothing (owner.decision); a draft's tools passed the validator, and nothing is saved until
 * it is accepted.
 */

const URL = process.env.TEST_DATABASE_URL_AGENTS ?? 'postgres://svc_agents:svc_agents@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SECRET = 'an-agents-own-identity-test-secret-of-32-plus-chars';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
const PERSON = ['agents:read', 'agents:execute', 'identity:write'];
const DESCRIPTION = 'TEST: answer questions about my orders and never move money.';

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
    id: 'req-own-identity',
  });
}
/** A caller with no person's session: the agent, holding only its token. */
const anonymous = () => edgeContext({ headers: {}, id: 'req-own-identity-agent' });

describe('the drafting assistant', () => {
  it('a blank model choice is the owner’s decision; test-engine is the TEST engine; any other model is live', () => {
    expect(assistantEngine(undefined)).toBeNull();
    expect(assistantEngine('  ')).toBeNull();
    expect(assistantEngine('test-engine')).toBe('test');
    expect(assistantEngine('some-model')).toBe('live');
    expect(() => draftAgent(null, DESCRIPTION)).toThrow('owner.decision');
    expect(() => draftAgent('live', DESCRIPTION)).toThrow('agents.assistant.engine_unavailable');
  });

  it('the TEST engine drafts from the words; a tool the validator refuses is left out with its code', () => {
    expect(testEngineDraft(DESCRIPTION)).toEqual({
      name: 'TEST draft: answer questions about my orders and never move',
      instructions: `TEST draft from your description. ${DESCRIPTION}`,
      tools: ['support.kb.search', 'trade.markets.list'],
      leftOut: [],
      engine: 'test',
    });
    const money = testEngineDraft('TEST: answer questions and transfer my funds.');
    expect(money.tools).toEqual(['support.kb.search']);
    expect(money.leftOut).toEqual([{ tool: 'ledger.transfer', code: 'agents.own.money_tool' }]);
    expect(() => testEngineDraft('   ')).toThrow('agents.assistant.description_blank');
    expect(testEngineDraft('x'.repeat(4000)).name.length).toBeLessThanOrEqual(64);
  });
});

describe('an agent token’s lifetime', () => {
  it('blank or out of range refuses; none is invented', () => {
    expect(() => tokenLifetime(null)).toThrow('agents.identity.lifetime_unset');
    expect(() => tokenLifetime(undefined)).toThrow('agents.identity.lifetime_unset');
    expect(() => tokenLifetime(0)).toThrow('agents.identity.lifetime_unset');
    expect(() => tokenLifetime(1.5)).toThrow('agents.identity.lifetime_unset');
    expect(tokenLifetime(60)).toBe(60);
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('own agent identity and assistant (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 6,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-own-identity-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');
  let lockConn: Awaited<ReturnType<typeof sql.reserve>>;

  function build({
    lifetime = 60 as number | null,
    model = 'test-engine' as string | null,
    accounts = [{ userId: USER, status: 'active' as const, kycTier: 'full' as const }] as Array<{
      userId: string;
      status: 'active' | 'frozen' | 'closed';
      kycTier: 'full';
    }>,
  } = {}) {
    const provider = new MockModelProvider({ id: 'primary' });
    const gateway = new ModelGateway([provider], parseRoutingTable({ routes: [] }));
    const meter = new UsageMeter(sql, new MemoryLedger(), { assetId: 'USDT', windowMinutes: 60 });
    const runtime = new AgentRuntime(sql, gateway, meter, new MemoryEventBus('svc-agents'), {
      feeAssetId: 'USDT',
      meteringEnabled: true,
      spend: new UserSpendStore(sql),
      funds: { available: async () => 0n },
    });
    const supportDesk = createFixtureSupportDesk({ accounts });
    const router = createAgentsRouter({
      runtime,
      gateway,
      meter,
      feeAssetId: 'USDT',
      sql,
      supportDesk,
      ownTokenLifetimeMinutes: lifetime,
      ownAssistantModel: model,
    });
    return {
      person: router.createCaller(callerFor(USER, PERSON)),
      other: router.createCaller(callerFor(OTHER, PERSON)),
      agent: router.createCaller(anonymous()),
    };
  }

  async function starterAgent(person: ReturnType<typeof build>['person']) {
    return person.own.create({ template: 'service-starter', createKey: `identity:${Math.random()}` });
  }

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
    await sql`TRUNCATE agents.own_agent_tokens, agents.own_agents RESTART IDENTITY CASCADE`;
  });

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  describe('own agent identity', () => {
    it('a blank lifetime issues nothing', async () => {
      const { person } = build({ lifetime: null });
      const agent = await starterAgent(person);
      await expect(person.own.identity.issue({ id: agent.id })).rejects.toMatchObject({ message: 'agents.identity.lifetime_unset' });
      expect(await person.own.identity.get({ id: agent.id })).toEqual({ token: null });
      expect(await sql`SELECT 1 FROM agents.own_agent_tokens`).toHaveLength(0);
    });

    it('issues the agent its own token: its owner, its tools as scopes, its expiry; the call answers who it acts as', async () => {
      const { person, agent: caller } = build();
      const agent = await starterAgent(person);
      const issued = await person.own.identity.issue({ id: agent.id });
      expect(issued.secret).toMatch(/^agt_[A-Za-z0-9_-]{43}$/);
      expect(issued.token).toMatchObject({ agentId: agent.id, ownerId: USER, scopes: agent.tools, revokedAt: null, state: 'active' });
      expect(Date.parse(issued.token.expiresAt) - Date.parse(issued.token.issuedAt)).toBe(60 * 60_000);
      expect(await person.own.identity.get({ id: agent.id })).toEqual({ token: issued.token });
      // Only the hash is kept.
      const stored = await sql<{ token_hash: string }[]>`SELECT token_hash FROM agents.own_agent_tokens`;
      expect(stored[0]!.token_hash).not.toContain(issued.secret);
      expect(await caller.own.identity.agentCall({ token: issued.secret })).toEqual({
        agentId: agent.id,
        ownerId: USER,
        scopes: agent.tools,
        expiresAt: issued.token.expiresAt,
      });
    });

    it('a revoke makes the next call fail; so does a token issued over, and an unknown one', async () => {
      const { person, agent: caller } = build();
      const agent = await starterAgent(person);
      const first = await person.own.identity.issue({ id: agent.id });
      const second = await person.own.identity.issue({ id: agent.id });
      await expect(caller.own.identity.agentCall({ token: first.secret })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'agents.identity.token_revoked',
      });
      expect((await caller.own.identity.agentCall({ token: second.secret })).agentId).toBe(agent.id);
      const revoked = await person.own.identity.revoke({ id: agent.id });
      expect(revoked).toMatchObject({ state: 'revoked' });
      await expect(caller.own.identity.agentCall({ token: second.secret })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'agents.identity.token_revoked',
      });
      await expect(person.own.identity.revoke({ id: agent.id })).rejects.toMatchObject({ message: 'agents.identity.no_live_token' });
      await expect(caller.own.identity.agentCall({ token: 'agt_unknown' })).rejects.toMatchObject({
        message: 'agents.identity.token_unknown',
      });
      await expect(caller.own.identity.agentCall({ token: 'not-an-agent-token' })).rejects.toMatchObject({
        message: 'agents.identity.token_unknown',
      });
    });

    it('a frozen, closed or unread owner makes the token fail', async () => {
      const issuer = build();
      const agent = await starterAgent(issuer.person);
      const { secret } = await issuer.person.own.identity.issue({ id: agent.id });
      for (const [status, code] of [
        ['frozen', 'agents.identity.owner_frozen'],
        ['closed', 'agents.identity.owner_inactive'],
      ] as const) {
        const { agent: caller } = build({ accounts: [{ userId: USER, status, kycTier: 'full' }] });
        await expect(caller.own.identity.agentCall({ token: secret })).rejects.toMatchObject({ code: 'FORBIDDEN', message: code });
      }
      const { agent: unread } = build({ accounts: [] });
      await expect(unread.own.identity.agentCall({ token: secret })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'agents.identity.owner_unread',
      });
    });

    it('an expired token fails its next call', async () => {
      const { person } = build();
      const agent = await starterAgent(person);
      const issuedAt = new Date('2026-11-04T10:00:00.000Z');
      const { secret } = await new OwnIdentityStore(sql, () => issuedAt).issue(USER, agent.id, agent.tools, 1);
      const later = new OwnIdentityStore(sql, () => new Date(issuedAt.getTime() + 60_000));
      await expect(later.call(secret, null)).rejects.toMatchObject({ code: 'agents.identity.token_expired' });
      expect(await later.latest(USER, agent.id)).toMatchObject({ state: 'expired' });
    });

    it('another person can neither read, issue nor revoke the agent’s token', async () => {
      const { person, other } = build();
      const agent = await starterAgent(person);
      await person.own.identity.issue({ id: agent.id });
      for (const call of [
        () => other.own.identity.get({ id: agent.id }),
        () => other.own.identity.issue({ id: agent.id }),
        () => other.own.identity.revoke({ id: agent.id }),
      ]) {
        await expect(call()).rejects.toMatchObject({ message: 'agents.own.not_found' });
      }
      expect((await person.own.identity.get({ id: agent.id })).token).toMatchObject({ state: 'active' });
    });

    it('deleting the draft deletes its tokens', async () => {
      const { person, agent: caller } = build();
      const agent = await starterAgent(person);
      const { secret } = await person.own.identity.issue({ id: agent.id });
      await person.own.delete({ id: agent.id, confirm: 'delete for good' });
      expect(await sql`SELECT 1 FROM agents.own_agent_tokens`).toHaveLength(0);
      await expect(caller.own.identity.agentCall({ token: secret })).rejects.toMatchObject({
        message: 'agents.identity.token_unknown',
      });
    });
  });

  describe('drafting with the assistant', () => {
    it('with the model unset, drafting refuses owner.decision and nothing is saved', async () => {
      const { person } = build({ model: null });
      expect(await person.own.assistant.state()).toEqual({ engine: null });
      await expect(person.own.assistant.draft({ description: DESCRIPTION })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'owner.decision',
      });
      expect(await person.own.list({ limit: 200 })).toEqual([]);
    });

    it('a model with no drafting adapter drafts nothing', async () => {
      const { person } = build({ model: 'some-model' });
      expect(await person.own.assistant.state()).toEqual({ engine: 'live' });
      await expect(person.own.assistant.draft({ description: DESCRIPTION })).rejects.toMatchObject({
        message: 'agents.assistant.engine_unavailable',
      });
    });

    it('a draft is saved only once accepted, through the validator, once per accept key', async () => {
      const { person } = build();
      expect(await person.own.assistant.state()).toEqual({ engine: 'test' });
      const draft = await person.own.assistant.draft({ description: DESCRIPTION });
      expect(draft.tools).toEqual(['support.kb.search', 'trade.markets.list']);
      expect(await person.own.list({ limit: 200 })).toEqual([]);
      const accepted = await person.own.assistant.accept({ ...draft, acceptKey: 'accept:one-key' });
      expect(accepted).toMatchObject({
        name: draft.name,
        instructions: draft.instructions,
        tools: draft.tools,
        state: 'draft',
        template: 'blank',
      });
      expect(await person.own.assistant.accept({ ...draft, acceptKey: 'accept:one-key' })).toEqual(accepted);
      expect(await person.own.list({ limit: 200 })).toHaveLength(1);
      // An accept carrying a tool the validator refuses saves nothing.
      await expect(
        person.own.assistant.accept({ ...draft, tools: [...draft.tools, 'ledger.transfer'], acceptKey: 'accept:two-key' }),
      ).rejects.toMatchObject({ message: 'agents.own.money_tool' });
      expect(await person.own.list({ limit: 200 })).toHaveLength(1);
    });
  });
}
