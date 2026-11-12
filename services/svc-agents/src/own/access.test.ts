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
import { parseTierLaws } from '../tier-laws.js';
import { assertAccessAllows, parseAccessEnd } from './access.js';
import { OWN_RUN_TASK } from './routes.js';

/**
 * Which of a person's venue sub-accounts their own agent may act on, and until when (AG-spend-02, J-agents-08 #2): a grant
 * names the sub-accounts exactly and always carries an end; a sub-account not granted, or one whose access has ended, is
 * refused before the rules are read; only the person grants access.
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
const SECRET = 'an-agents-own-access-test-secret-of-32-plus-chars!';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
const PERSON = ['agents:read', 'agents:execute', 'identity:write'];

function callerFor(userId: string, scopes: readonly string[] = PERSON) {
  const principal = {
    sub: userId,
    userId,
    sid: '55555555-5555-4555-8555-555555555555',
    scopes,
    tier: 'basic',
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
    id: 'req-own-access',
  });
}

const SUB_A = `0x${'a'.repeat(40)}`;
const SUB_B = `0x${'b'.repeat(40)}`;
const OWNER = `0x${'c'.repeat(40)}`;
const NOW = new Date('2026-11-11T12:00:00.000Z');

describe('access, without a database', () => {
  it('a blank end is refused agents.access_expiry_unset, never defaulted; a non-whole, zero or too long end is invalid', () => {
    for (const blank of [null, undefined, '', '   '])
      expect(() => parseAccessEnd(blank, NOW)).toThrow(expect.objectContaining({ code: 'agents.access_expiry_unset' }));
    for (const bad of ['0', '-1', '1.5', 'seven', '366'])
      expect(() => parseAccessEnd(bad, NOW)).toThrow(expect.objectContaining({ code: 'agents.access_expiry_invalid' }));
    expect(parseAccessEnd('7', NOW).toISOString()).toBe('2026-11-18T12:00:00.000Z');
  });

  it('a sub-account with live access is allowed; one not granted is refused; one past its end is refused; main is not decided here', () => {
    const rows = [{ subAccount: SUB_A, endsAt: '2026-11-18T12:00:00.000Z' }];
    expect(() => assertAccessAllows(rows, `sub:${SUB_A}`, NOW)).not.toThrow();
    expect(() => assertAccessAllows(rows, `sub:${SUB_B}`, NOW)).toThrow(expect.objectContaining({ code: 'agents.access_account_denied' }));
    expect(() => assertAccessAllows([], `sub:${SUB_A}`, NOW)).toThrow(expect.objectContaining({ code: 'agents.access_account_denied' }));
    expect(() => assertAccessAllows(rows, `sub:${SUB_A}`, new Date('2026-11-18T12:00:00.000Z'))).toThrow(
      expect.objectContaining({ code: 'agents.access_expired' }),
    );
    expect(() => assertAccessAllows([], 'main', NOW)).not.toThrow();
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('own agent account access (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 6,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-own-access-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');
  let lockConn: Awaited<ReturnType<typeof sql.reserve>>;

  function people() {
    const table = parseRoutingTable({
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
    const gateway = new ModelGateway([new MockModelProvider({ id: 'primary' })], table);
    const meter = new UsageMeter(sql, new MemoryLedger(), { assetId: 'USDT', windowMinutes: 60 });
    const runtime = new AgentRuntime(sql, gateway, meter, new MemoryEventBus('svc-agents'), {
      feeAssetId: 'USDT',
      meteringEnabled: true,
      spend: new UserSpendStore(sql),
      funds: { available: async () => 100n * 10n ** 18n },
    });
    const router = createAgentsRouter({ runtime, gateway, meter, feeAssetId: 'USDT', sql, tierLaws: parseTierLaws(undefined) });
    return {
      person: router.createCaller(callerFor(USER)),
      other: router.createCaller(callerFor(OTHER)),
      /** The same person without identity:write: an agent's token or another app, not their own signed-in session. */
      notSession: router.createCaller(callerFor(USER, ['agents:read', 'agents:execute'])),
      /** svc-trade asking the gate for the person (J-agents-08 #4 #6): a verified service caller, no principal. */
      trade: router.createCaller({ ...edgeContext({ headers: {}, id: 'req-trade' }), service: 'svc-trade' }),
      /** Another service, verified as itself, which may not ask. */
      bank: router.createCaller({ ...edgeContext({ headers: {}, id: 'req-bank' }), service: 'svc-bank' }),
    };
  }

  async function ownAgent(person: ReturnType<typeof people>['person']) {
    const { id } = await person.own.create({ template: 'service-starter', createKey: `access:${Math.random()}` });
    return id;
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
    await sql`TRUNCATE agents.own_agent_account_access, agents.own_agent_policy_rules, agents.own_agent_policy_settings, agents.own_agents RESTART IDENTITY CASCADE`;
  });

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  const grantOf = (id: string, subs: readonly string[], endsInDays: string | null, grantKey = crypto.randomUUID()) => ({
    id,
    grantKey,
    venueId: 'test-venue',
    owner: OWNER,
    subAccounts: subs.map((s) => ({ subAccount: s, name: s === SUB_A ? 'Sub-account A' : 'Sub-account B' })),
    endsInDays,
  });

  describe('account access (J-agents-08 #2)', () => {
    it('access to sub-account A only: a tool naming B is refused, one naming A passes to the rules; a blank end grants nothing', async () => {
      const { person } = people();
      const id = await ownAgent(person);
      await expect(person.own.access.grant(grantOf(id, [SUB_A], null))).rejects.toMatchObject({ message: 'agents.access_expiry_unset' });
      await expect(person.own.access.grant(grantOf(id, [SUB_A], ''))).rejects.toMatchObject({ message: 'agents.access_expiry_unset' });
      expect((await person.own.access.get({ id })).grants).toEqual([]);
      const before = Date.now();
      const { grants } = await person.own.access.grant(grantOf(id, [SUB_A], '7'));
      expect(grants.map((g) => [g.subAccount, g.name, g.owner, g.venueId])).toEqual([[SUB_A, 'Sub-account A', OWNER, 'test-venue']]);
      const ends = Date.parse(grants[0]!.endsAt) - Date.parse(grants[0]!.grantedAt);
      expect(ends).toBe(7 * 86_400_000);
      expect(Date.parse(grants[0]!.grantedAt)).toBeGreaterThanOrEqual(before - 1000);
      await expect(person.own.policy.check({ id, action: 'place_order', account: `sub:${SUB_B}` })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'agents.access_account_denied',
      });
      expect((await person.own.policy.check({ id, action: 'place_order', account: `sub:${SUB_A}` })).outcome).toBe('no_rule');
      // The rules still decide after access: a deny on every account refuses A too.
      await person.own.policy.add({ id, effect: 'deny', action: 'place_order', scope: 'all' });
      await expect(person.own.policy.check({ id, action: 'place_order', account: `sub:${SUB_A}` })).rejects.toMatchObject({
        message: 'agents.policy_denied',
      });
      // A deny on main does not reach a sub-account.
      const other = await ownAgent(person);
      await person.own.access.grant(grantOf(other, [SUB_A], '7'));
      await person.own.policy.add({ id: other, effect: 'deny', action: 'place_order', scope: 'main' });
      expect((await person.own.policy.check({ id: other, action: 'place_order', account: `sub:${SUB_A}` })).outcome).toBe('no_rule');
    });

    it('access past its end is refused agents.access_expired; a new grant replaces the old one exactly', async () => {
      const { person } = people();
      const id = await ownAgent(person);
      await person.own.access.grant(grantOf(id, [SUB_A, SUB_B], '7'));
      await sql`UPDATE agents.own_agent_account_access SET granted_at = now() - interval '8 days', ends_at = now() - interval '1 day'`;
      await expect(person.own.policy.check({ id, action: 'place_order', account: `sub:${SUB_A}` })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'agents.access_expired',
      });
      const { grants } = await person.own.access.grant(grantOf(id, [SUB_A], '1'));
      expect(grants.map((g) => g.subAccount)).toEqual([SUB_A]);
      expect((await person.own.policy.check({ id, action: 'place_order', account: `sub:${SUB_A}` })).outcome).toBe('no_rule');
      await expect(person.own.policy.check({ id, action: 'place_order', account: `sub:${SUB_B}` })).rejects.toMatchObject({
        message: 'agents.access_account_denied',
      });
      const live = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agents.own_agent_account_access WHERE ended_at IS NULL`;
      expect(live[0]!.n).toBe(1);
    });

    it('a retried grant is the same grant: it ends nothing and adds nothing; two grants at once leave one set live', async () => {
      const { person } = people();
      const id = await ownAgent(person);
      const key = crypto.randomUUID();
      const first = await person.own.access.grant(grantOf(id, [SUB_A], '7', key));
      const again = await person.own.access.grant(grantOf(id, [SUB_A], '7', key));
      expect(again).toEqual(first);
      const all = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agents.own_agent_account_access`;
      expect(all[0]!.n).toBe(1);
      await Promise.all([person.own.access.grant(grantOf(id, [SUB_A], '3')), person.own.access.grant(grantOf(id, [SUB_B], '3'))]);
      const live = (await person.own.access.get({ id })).grants;
      expect(live).toHaveLength(1);
    });

    it('an empty or malformed grant is refused and grants nothing', async () => {
      const { person } = people();
      const id = await ownAgent(person);
      await expect(person.own.access.grant(grantOf(id, [], '7'))).rejects.toMatchObject({ message: 'agents.access_none_chosen' });
      await expect(person.own.access.grant(grantOf(id, ['0xnot'], '7'))).rejects.toMatchObject({
        message: 'agents.access_request_invalid',
      });
      await expect(person.own.access.grant({ ...grantOf(id, [SUB_A], '7'), owner: 'nobody' })).rejects.toMatchObject({
        message: 'agents.access_request_invalid',
      });
      expect((await person.own.access.get({ id })).grants).toEqual([]);
    });

    it("svc-trade asks the same gate for the person: A passes, B and another person's agent refuse, and no other caller may ask", async () => {
      const { person, trade, bank } = people();
      const id = await ownAgent(person);
      await person.own.access.grant(grantOf(id, [SUB_A], '7'));
      const ask = (account: string, userId = USER) => trade.own.policy.forService({ userId, id, action: 'place_order', account } as never);
      expect((await ask(`sub:${SUB_A}`)).outcome).toBe('no_rule');
      await expect(ask(`sub:${SUB_B}`)).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'agents.access_account_denied' });
      await expect(ask(`sub:${SUB_A}`, OTHER)).rejects.toMatchObject({ message: 'agents.own.not_found' });
      await person.own.policy.add({ id, effect: 'deny', action: 'place_order', scope: 'all' });
      await expect(ask(`sub:${SUB_A}`)).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'agents.policy_denied' });
      await expect(
        bank.own.policy.forService({ userId: USER, id, action: 'place_order', account: `sub:${SUB_A}` } as never),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      // The person's own session is not a service: it asks through own.policy.check instead.
      await expect(
        person.own.policy.forService({ userId: USER, id, action: 'place_order', account: `sub:${SUB_A}` } as never),
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });

    it('the agent drafts one order from the words: side, size, asset and type; anything else is not understood', async () => {
      const { person, other } = people();
      const id = await ownAgent(person);
      expect(await person.own.trade.draft({ id, ask: 'Buy 0.0001 BTC at market' })).toEqual({
        side: 'buy',
        base: 'BTC',
        size: '0.0001',
        type: 'market',
        price: null,
        label: 'TEST',
      });
      expect(await person.own.trade.draft({ id, ask: 'sell 0.5 eth at 3100' })).toMatchObject({
        side: 'sell',
        base: 'ETH',
        type: 'limit',
        price: '3100',
      });
      for (const ask of ['buy some BTC', 'Buy 0 BTC at market', 'send 1 USDT to my savings', 'Buy 0.0001 BTC at market and sell it'])
        await expect(person.own.trade.draft({ id, ask })).rejects.toMatchObject({ message: 'agents.order_not_understood' });
      await expect(other.own.trade.draft({ id, ask: 'Buy 0.0001 BTC at market' })).rejects.toMatchObject({
        message: 'agents.own.not_found',
      });
    });

    it('only the person grants access: another person reaches no agent, and a token that is not their session is refused', async () => {
      const { person, other, notSession } = people();
      const id = await ownAgent(person);
      await expect(other.own.access.grant(grantOf(id, [SUB_A], '7'))).rejects.toMatchObject({ message: 'agents.own.not_found' });
      await expect(notSession.own.access.grant(grantOf(id, [SUB_A], '7'))).rejects.toThrow();
      await expect(other.own.access.get({ id })).rejects.toMatchObject({ message: 'agents.own.not_found' });
      expect((await person.own.access.get({ id })).grants).toEqual([]);
    });
  });
}
