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
import { decide } from './policy.js';
import { OWN_RUN_TASK } from './routes.js';

/**
 * A person's allow and deny rules for their own agent (AG-spend-02, J-agents-08 #1): a deny at any scope covering the
 * account wins whatever order the rules were written in; with rules required an action no rule allows is refused; only
 * the person writes the rules, and the service's own check refuses with the code the rules carry.
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
const SECRET = 'an-agents-own-policy-test-secret-of-32-plus-chars!';
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
    id: 'req-own-policy',
  });
}

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

describe('decide, without a database', () => {
  it('a deny at any covering scope wins over an allow, in either order and whichever rule has the lower id', () => {
    for (const [allowId, denyId] of [
      [A, B],
      [B, A],
    ] as const) {
      const allow = { id: allowId, effect: 'allow', action: 'place_order', scope: 'all' } as const;
      const deny = { id: denyId, effect: 'deny', action: 'place_order', scope: 'main' } as const;
      for (const rules of [
        [allow, deny],
        [deny, allow],
      ])
        expect(decide(rules, false, 'place_order', 'main')).toEqual({
          action: 'place_order',
          account: 'main',
          outcome: 'denied',
          ruleId: denyId,
        });
    }
  });

  it('an allow alone allows; a rule for another action does not touch this one', () => {
    const rule = { id: A, effect: 'allow', action: 'place_order', scope: 'main' } as const;
    const rules = [rule];
    expect(decide(rules, true, 'place_order', 'main').outcome).toBe('allowed');
    expect(decide([{ ...rule, effect: 'deny' }], false, 'cancel_order', 'main').outcome).toBe('no_rule');
  });

  it('no matching rule refuses on an agent that requires rules, and is left to the other gates on one that does not', () => {
    expect(decide([], true, 'cancel_order', 'main')).toEqual({
      action: 'cancel_order',
      account: 'main',
      outcome: 'no_match_refused',
      ruleId: null,
    });
    expect(decide([], false, 'cancel_order', 'main').outcome).toBe('no_rule');
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('own agent policy rules (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 6,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-own-policy-test' },
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
    };
  }

  async function ownAgent(person: ReturnType<typeof people>['person']) {
    const { id } = await person.own.create({ template: 'service-starter', createKey: `policy:${Math.random()}` });
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
    await sql`TRUNCATE agents.own_agent_policy_rules, agents.own_agent_policy_settings, agents.own_agents RESTART IDENTITY CASCADE`;
  });

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  describe('allow and deny rules (J-agents-08 #1)', () => {
    it('allow on all accounts then deny on main refuses placing an order, and so does the reverse order; the check refuses with the code', async () => {
      const { person } = people();
      for (const order of [
        ['allow', 'deny'],
        ['deny', 'allow'],
      ] as const) {
        const id = await ownAgent(person);
        let policy;
        for (const effect of order)
          policy = await person.own.policy.add({ id, effect, action: 'place_order', scope: effect === 'allow' ? 'all' : 'main' });
        const deny = policy!.rules.find((rule) => rule.effect === 'deny')!;
        expect(policy!.decisions.find((d) => d.action === 'place_order')).toEqual({
          action: 'place_order',
          account: 'main',
          outcome: 'denied',
          ruleId: deny.id,
        });
        await expect(person.own.policy.check({ id, action: 'place_order', account: 'main' })).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: 'agents.policy_denied',
        });
      }
    });

    it('rules required: an action no rule allows is refused agents.policy_no_match; off again, it is left to the other gates', async () => {
      const { person } = people();
      const id = await ownAgent(person);
      await person.own.policy.add({ id, effect: 'allow', action: 'place_order', scope: 'all' });
      expect((await person.own.policy.check({ id, action: 'cancel_order', account: 'main' })).outcome).toBe('no_rule');
      const required = await person.own.policy.require({ id, rulesRequired: true });
      expect(required.rulesRequired).toBe(true);
      expect(required.decisions.find((d) => d.action === 'cancel_order')!.outcome).toBe('no_match_refused');
      await expect(person.own.policy.check({ id, action: 'cancel_order', account: 'main' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'agents.policy_no_match',
      });
      expect((await person.own.policy.check({ id, action: 'place_order', account: 'main' })).outcome).toBe('allowed');
      expect(
        (await person.own.policy.require({ id, rulesRequired: false })).decisions.find((d) => d.action === 'cancel_order')!.outcome,
      ).toBe('no_rule');
    });

    it('adding the same rule again is the stored row; removing it ends it, and a rule added again is a new row', async () => {
      const { person } = people();
      const id = await ownAgent(person);
      const first = await person.own.policy.add({ id, effect: 'deny', action: 'place_order', scope: 'main' });
      const again = await person.own.policy.add({ id, effect: 'deny', action: 'place_order', scope: 'main' });
      expect(again.rules).toEqual(first.rules);
      const removed = await person.own.policy.remove({ id, ruleId: first.rules[0]!.id });
      expect(removed.rules).toEqual([]);
      expect(removed.decisions.find((d) => d.action === 'place_order')!.outcome).toBe('no_rule');
      const readded = await person.own.policy.add({ id, effect: 'deny', action: 'place_order', scope: 'main' });
      expect(readded.rules[0]!.id).not.toBe(first.rules[0]!.id);
      const stored = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agents.own_agent_policy_rules WHERE removed_at IS NULL`;
      expect(stored[0]!.n).toBe(1);
    });

    it('only the person writes their rules: another person reaches no agent, and a token that is not their session is refused', async () => {
      const { person, other, notSession } = people();
      const id = await ownAgent(person);
      const { rules } = await person.own.policy.add({ id, effect: 'allow', action: 'place_order', scope: 'all' });
      await expect(other.own.policy.add({ id, effect: 'allow', action: 'cancel_order', scope: 'all' })).rejects.toMatchObject({
        message: 'agents.own.not_found',
      });
      await expect(other.own.policy.remove({ id, ruleId: rules[0]!.id })).rejects.toMatchObject({ message: 'agents.own.not_found' });
      await expect(notSession.own.policy.add({ id, effect: 'allow', action: 'cancel_order', scope: 'all' })).rejects.toThrow();
      await expect(notSession.own.policy.require({ id, rulesRequired: true })).rejects.toThrow();
      expect((await person.own.policy.get({ id })).rules).toHaveLength(1);
    });
  });
}
