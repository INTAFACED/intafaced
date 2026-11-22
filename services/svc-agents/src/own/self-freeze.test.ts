import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, OWN_AGENT_TRIGGER_SUBJECTS, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, postgresAvailable, resolveTestDatabaseUrl } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger } from '@intafaced/ledger-client';
import { ModelGateway } from '../gateway/gateway.js';
import { parseRoutingTable } from '../gateway/routing.js';
import { UsageMeter } from '../metering/meter.js';
import { NavigatorOnchainStore } from '../navigator/onchain.js';
import { MockModelProvider } from '../providers/mock.js';
import { createAgentsRouter } from '../router.js';
import { AgentRuntime } from '../runtime.js';
import { UserSpendStore } from '../spend/store.js';
import { createFixtureSupportDesk } from '../support-agent/desk-port.js';
import { tickSchedules, type AutoRunDeps } from './automation.js';
import { OWN_RUN_TASK, ownGuardrail } from './routes.js';
import {
  assertNotSelfFrozen,
  createIdentitySelfFreezeRead,
  MemorySelfFreezeRead,
  OWNER_FREEZE_UNREAD,
  OWNER_FROZEN_SELF,
  SelfFreezeUnavailable,
  subscribeSelfFreezeApplied,
} from './self-freeze.js';

/**
 * The owner's own freeze in svc-agents (J-wallet-13 #1 #2 #4), on real Postgres through the service's own routes.
 * #1: identity's `selfFreezeApplied` revokes every agent permission kept for the person (the agent's token, their tool
 * consents, their sub-account access, the Navigator's session-key bindings) and stops their scheduled agent runs
 * (schedules, triggers, claimed occurrences, background runs), and touches nothing of anyone else; delivered twice it is
 * one change. #2: while frozen, an agent order, a permission change and a new key are each refused with the freeze's
 * code, and an unreadable freeze refuses the same way it would if frozen (fail closed). #4: after the lift nothing comes
 * back by itself; the person grants again.
 */

const URL = resolveTestDatabaseUrl(undefined, 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test');
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const FREEZE_ID = '33333333-3333-4333-8333-333333333333';
const SINCE = '2026-11-18T01:00:00.000Z';
const SECRET = 'an-agents-own-self-freeze-test-secret-of-32-plus!';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
const CADENCE = { minIntervalMinutes: 1, dailyLimit: 100 };
const SUB_A = `0x${'a'.repeat(40)}`;
const VENUE_OWNER = `0x${'c'.repeat(40)}`;

function callerFor(userId: string) {
  const principal = {
    sub: userId,
    userId,
    sid: '55555555-5555-4555-8555-555555555555',
    scopes: ['agents:read', 'agents:execute', 'identity:write'],
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
    id: 'req-own-self-freeze',
  });
}

describe('the freeze read, without a database', () => {
  it('passes an open freeze; refuses a frozen one with its code and start; an unreadable or unwired one refuses as frozen', async () => {
    const read = new MemorySelfFreezeRead();
    await expect(assertNotSelfFrozen(USER, read)).resolves.toBeUndefined();
    read.frozenSince.set(USER, SINCE);
    await expect(assertNotSelfFrozen(USER, read)).rejects.toMatchObject({ code: OWNER_FROZEN_SELF, params: { since: SINCE } });
    await expect(assertNotSelfFrozen(OTHER, read)).resolves.toBeUndefined();
    read.down = true;
    await expect(assertNotSelfFrozen(OTHER, read)).rejects.toMatchObject({ code: OWNER_FREEZE_UNREAD });
    await expect(assertNotSelfFrozen(USER, null)).rejects.toMatchObject({ code: OWNER_FREEZE_UNREAD });
    await expect(assertNotSelfFrozen(USER, undefined)).rejects.toMatchObject({ code: OWNER_FREEZE_UNREAD });
  });

  it("reads identity's GET /internal/self-freeze/:userId; a refusal, a transport fault or an off-contract answer throws", async () => {
    const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
    const seen: string[] = [];
    const ok = createIdentitySelfFreezeRead('http://identity.test/', 'TEST-internal-secret-of-32-chars-long!!', undefined, (async (
      url: string | URL | Request,
    ) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ userId: USER, frozen: true, since: SINCE }), { status: 200 });
    }) as typeof fetch);
    await expect(ok.read(USER)).resolves.toEqual({ frozen: true, since: SINCE });
    expect(seen).toEqual([`http://identity.test/internal/self-freeze/${USER}`]);
    const open = createIdentitySelfFreezeRead(
      'http://identity.test',
      'x'.repeat(32),
      undefined,
      answer(200, {
        userId: USER,
        frozen: false,
        since: null,
      }) as typeof fetch,
    );
    await expect(open.read(USER)).resolves.toEqual({ frozen: false });
    for (const fetchFn of [
      answer(500, { error: 'x' }),
      answer(200, { userId: OTHER, frozen: false, since: null }),
      answer(200, { userId: USER, frozen: 'no' }),
      async () => {
        throw new Error('TEST: connection refused');
      },
    ]) {
      const read = createIdentitySelfFreezeRead('http://identity.test', 'x'.repeat(32), undefined, fetchFn as typeof fetch);
      await expect(read.read(USER)).rejects.toBeInstanceOf(SelfFreezeUnavailable);
    }
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('the owner’s own freeze (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db = await createTestDatabase({ service: 'agents', url: URL, migrations });
  const sql = db.sql;

  function build(freeze: MemorySelfFreezeRead | null = new MemorySelfFreezeRead()) {
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
    const desk = createFixtureSupportDesk({
      accounts: [
        { userId: USER, status: 'active', kycTier: 'full' },
        { userId: OTHER, status: 'active', kycTier: 'full' },
      ],
    });
    const router = createAgentsRouter({
      runtime,
      gateway,
      meter,
      feeAssetId: 'USDT',
      sql,
      ownCadence: CADENCE,
      supportDesk: desk,
      ownTokenLifetimeMinutes: 60,
      selfFreeze: freeze,
    });
    const autoRuns: AutoRunDeps = { sql, runtime, cadence: CADENCE, task: OWN_RUN_TASK, guardrailOf: ownGuardrail, selfFreeze: freeze };
    return {
      person: router.createCaller(callerFor(USER)),
      other: router.createCaller(callerFor(OTHER)),
      agentCaller: router.createCaller(edgeContext({ headers: {}, id: 'req-agent-token' })),
      autoRuns,
    };
  }
  type Caller = ReturnType<typeof build>['person'];

  /** One agent of the person's with every permission svc-agents keeps, and one scheduled run of each kind. */
  async function equip(person: Caller, userId: string) {
    const { id } = await person.own.create({ template: 'service-starter', createKey: `freeze:${userId}:${Math.random()}` });
    await person.own.save({ id, name: 'TEST helper', instructions: '', tools: [], perSessionCap: '1' });
    await person.own.limits.set({ id, perCall: '0.012', perSession: '0.02', perPeriod: '5' });
    await person.own.consents.grant({ id, dataClass: 'own_data' });
    await person.own.consents.grant({ id, dataClass: 'market_data' });
    await person.own.access.grant({
      id,
      grantKey: crypto.randomUUID(),
      venueId: 'TEST-venue',
      owner: VENUE_OWNER,
      subAccounts: [{ subAccount: SUB_A, name: 'TEST A' }],
      endsInDays: '7',
    });
    const { secret } = await person.own.identity.issue({ id });
    await new NavigatorOnchainStore(sql).bind({
      userId,
      chainId: 84532,
      account: `0x${(userId === USER ? 'd' : 'e').repeat(40)}`,
      sessionKey: `0x${'f'.repeat(40)}`,
      spendLimitWei: '1000',
      validUntil: 4_102_444_800,
      targets: [`0x${'1'.repeat(40)}`],
      selectors: ['0x12345678'],
      specHash: `0x${'2'.repeat(64)}`,
    });
    const schedule = await person.own.schedules.create({
      id,
      createKey: `sched:${userId}:${Math.random()}`,
      repeat: 'repeat',
      intervalMinutes: '60',
      perRunCap: '0.1',
      ask: 'TEST check',
    });
    // Due far ahead, so the test's own tick decides when it runs.
    await sql`UPDATE agents.own_agent_schedules SET next_due_at = now() + interval '1 day' WHERE id = ${schedule.id}`;
    const trigger = await person.own.triggers.create({
      id,
      createKey: `trig:${userId}:${Math.random()}`,
      subject: OWN_AGENT_TRIGGER_SUBJECTS[0],
      perRunCap: '0.1',
      ask: 'TEST on fill',
    });
    // An occurrence a worker claimed and has not run yet.
    await sql`
      INSERT INTO agents.own_agent_auto_runs (run_key, agent_id, owner_id, source, source_id, ordinal, due_at)
      VALUES (${`agents:schedule:${schedule.id}:99`}, ${id}, ${userId}, 'schedule', ${schedule.id}, 99, now())
    `;
    // A session's background run that is going on, and a background test run of the agent.
    const [session] = await sql<{ id: string }[]>`
      INSERT INTO agents.agent_sessions (user_id, agent_id, guardrail, guardrail_version)
      VALUES (${userId}, 'navigator', ${sql.json({ limits: {} })}, 1) RETURNING id::text
    `;
    await sql`
      INSERT INTO agents.session_background_runs (user_id, session_id, agent_id, request_key, task, ask, notice, steps_total, state)
      VALUES (${userId}, ${session!.id}, 'navigator', ${`bg:${userId}`}, 'navigator.plan', 'TEST', 'inapp', 3, 'running')
    `;
    await sql`
      INSERT INTO agents.own_agent_background_runs (owner_id, agent_id, request_key, ask, steps_total)
      VALUES (${userId}, ${id}, ${`test:${userId}`}, 'TEST', 3)
    `;
    return { id, secret, scheduleId: schedule.id, triggerId: trigger.id };
  }

  /** What svc-agents keeps live for one person: each kind of permission and scheduled run, counted. */
  async function live(userId: string) {
    const n = async (rows: Promise<{ n: number }[]>) => (await rows)[0]!.n;
    return {
      tokens: await n(sql`SELECT count(*)::int AS n FROM agents.own_agent_tokens WHERE owner_id = ${userId} AND revoked_at IS NULL`),
      consents: await n(sql`SELECT count(*)::int AS n FROM agents.own_agent_consents WHERE owner_id = ${userId} AND revoked_at IS NULL`),
      access: await n(sql`SELECT count(*)::int AS n FROM agents.own_agent_account_access WHERE owner_id = ${userId} AND ended_at IS NULL`),
      bindings: await n(
        sql`SELECT count(*)::int AS n FROM agents.navigator_onchain_bindings WHERE user_id = ${userId} AND revoke_requested_at IS NULL`,
      ),
      schedules: await n(sql`SELECT count(*)::int AS n FROM agents.own_agent_schedules WHERE owner_id = ${userId} AND state = 'active'`),
      triggers: await n(sql`SELECT count(*)::int AS n FROM agents.own_agent_triggers WHERE owner_id = ${userId} AND state = 'active'`),
      claimed: await n(sql`SELECT count(*)::int AS n FROM agents.own_agent_auto_runs WHERE owner_id = ${userId} AND state = 'claimed'`),
      sessionRuns: await n(
        sql`SELECT count(*)::int AS n FROM agents.session_background_runs WHERE user_id = ${userId} AND state IN ('queued', 'running')`,
      ),
      testRuns: await n(
        sql`SELECT count(*)::int AS n FROM agents.own_agent_background_runs WHERE owner_id = ${userId} AND state = 'running'`,
      ),
    };
  }
  const ALL_LIVE = { tokens: 1, consents: 2, access: 1, bindings: 1, schedules: 1, triggers: 1, claimed: 1, sessionRuns: 1, testRuns: 1 };
  const NONE_LIVE = { tokens: 0, consents: 0, access: 0, bindings: 0, schedules: 0, triggers: 0, claimed: 0, sessionRuns: 0, testRuns: 0 };

  beforeEach(async () => {
    await db.truncateAll();
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('#1 the freeze event revokes every agent permission and stops scheduled runs', () => {
    it("revokes and stops everything of the person's, nothing of another's; delivered twice it is one change", async () => {
      const { person, other, agentCaller } = build();
      const mine = await equip(person, USER);
      const theirs = await equip(other, OTHER);
      expect(await live(USER)).toEqual(ALL_LIVE);
      expect(await live(OTHER)).toEqual(ALL_LIVE);

      const bus = new MemoryEventBus('svc-identity');
      await subscribeSelfFreezeApplied(bus, sql);
      const payload = { userId: USER, freezeId: FREEZE_ID, since: SINCE };
      const key = `identity.self_freeze.frozen:${FREEZE_ID}`;
      await bus.publish('selfFreezeApplied', payload, { idempotencyKey: key });

      expect(await live(USER)).toEqual(NONE_LIVE);
      expect(await live(OTHER)).toEqual(ALL_LIVE);
      // The scheduled occurrence settled as skipped by the freeze; the test run stopped with the freeze's code.
      expect(await sql`SELECT state, code, reason_code FROM agents.own_agent_auto_runs WHERE owner_id = ${USER}`).toEqual([
        { state: 'skipped', code: 'agents.schedule_blocked', reason_code: OWNER_FROZEN_SELF },
      ]);
      expect(await sql`SELECT state, stop_code FROM agents.own_agent_background_runs WHERE owner_id = ${USER}`).toEqual([
        { state: 'stopped', stop_code: OWNER_FROZEN_SELF },
      ]);
      expect((await sql`SELECT state FROM agents.session_background_runs WHERE user_id = ${USER}`)[0]).toEqual({ state: 'paused' });
      // The agent's token is revoked; the other person's still answers.
      await expect(agentCaller.own.identity.agentCall({ token: mine.secret })).rejects.toMatchObject({
        message: 'agents.identity.token_revoked',
      });
      expect((await agentCaller.own.identity.agentCall({ token: theirs.secret })).ownerId).toBe(OTHER);

      const record = async () =>
        sql<{ updated: Date }[]>`
          SELECT max(updated_at) AS updated FROM (
            SELECT updated_at FROM agents.own_agent_tokens WHERE owner_id = ${USER}
            UNION ALL SELECT updated_at FROM agents.own_agent_consents WHERE owner_id = ${USER}
            UNION ALL SELECT updated_at FROM agents.navigator_onchain_bindings WHERE user_id = ${USER}
            UNION ALL SELECT updated_at FROM agents.own_agent_schedules WHERE owner_id = ${USER}
          ) t
        `;
      const before = await record();
      const applied = await sql`SELECT freeze_id::text, user_id, applied FROM agents.self_freezes_applied`;
      expect(applied).toEqual([
        {
          freeze_id: FREEZE_ID,
          user_id: USER,
          applied: {
            tokensRevoked: 1,
            consentsRevoked: 2,
            accountAccessEnded: 1,
            onchainBindingsRevoking: 1,
            schedulesCancelled: 1,
            triggersCancelled: 1,
            autoRunsSkipped: 1,
            sessionRunsPaused: 1,
            testRunsStopped: 1,
          },
        },
      ]);

      // Delivered again: the same envelope key (the bus's seen-set) and a fresh delivery after a restart (a new
      // consumer with an empty seen-set, so only the freeze's own record in Postgres stands between it and a second change).
      await bus.publish('selfFreezeApplied', payload, { idempotencyKey: key });
      const restarted = new MemoryEventBus('svc-identity');
      await subscribeSelfFreezeApplied(restarted, sql);
      await restarted.publish('selfFreezeApplied', payload, { idempotencyKey: key });
      expect(await sql`SELECT freeze_id::text, user_id, applied FROM agents.self_freezes_applied`).toEqual(applied);
      expect(await record()).toEqual(before);
      expect(await live(OTHER)).toEqual(ALL_LIVE);
    });

    it('#4 after the lift nothing comes back by itself: the person grants each permission again', async () => {
      const freeze = new MemorySelfFreezeRead();
      const { person } = build(freeze);
      const { id } = await equip(person, USER);
      const bus = new MemoryEventBus('svc-identity');
      await subscribeSelfFreezeApplied(bus, sql);
      await bus.publish('selfFreezeApplied', { userId: USER, freezeId: FREEZE_ID, since: SINCE });
      // Lifted: identity reads open again. What the freeze revoked or stopped stays so.
      expect(await live(USER)).toEqual(NONE_LIVE);
      expect((await person.own.consents.list({ id })).every((c) => c.revokedAt !== null)).toBe(true);
      expect((await person.own.identity.get({ id })).token).toMatchObject({ state: 'revoked' });
      expect((await person.own.access.get({ id })).grants).toEqual([]);
      // Granting again works, and only what the person grants is live.
      await person.own.consents.grant({ id, dataClass: 'own_data' });
      await person.own.identity.issue({ id });
      expect(await live(USER)).toMatchObject({ tokens: 1, consents: 1, access: 0, bindings: 0, schedules: 0, triggers: 0 });
    });
  });

  describe('#2 while frozen, each is refused with the freeze reason', () => {
    it('an agent order, a permission change and a new key are each refused owner_frozen_self, and nothing changes', async () => {
      const open = new MemorySelfFreezeRead();
      const { person: setup } = build(open);
      const { id, secret } = await equip(setup, USER);
      const before = await live(USER);

      const freeze = new MemorySelfFreezeRead();
      freeze.frozenSince.set(USER, SINCE);
      const { person, agentCaller, other } = build(freeze);
      const frozen = { code: 'FORBIDDEN', message: OWNER_FROZEN_SELF };

      // A new key for the agent, and the agent's existing token used (even before the event reached svc-agents).
      await expect(person.own.identity.issue({ id })).rejects.toMatchObject(frozen);
      await expect(agentCaller.own.identity.agentCall({ token: secret })).rejects.toMatchObject(frozen);
      // Permission changes that give an agent more.
      await expect(person.own.consents.grant({ id, dataClass: 'live_write' })).rejects.toMatchObject(frozen);
      await expect(
        person.own.access.grant({
          id,
          grantKey: crypto.randomUUID(),
          venueId: 'TEST-venue',
          owner: VENUE_OWNER,
          subAccounts: [{ subAccount: SUB_A, name: 'TEST A' }],
          endsInDays: '7',
        }),
      ).rejects.toMatchObject(frozen);
      await expect(person.own.policy.add({ id, effect: 'allow', action: 'place_order', scope: 'all' })).rejects.toMatchObject(frozen);
      await expect(person.own.policy.require({ id, rulesRequired: false })).rejects.toMatchObject(frozen);
      await expect(
        person.own.schedules.create({
          id,
          createKey: 'sched:frozen:1',
          repeat: 'once',
          intervalMinutes: '',
          perRunCap: '0.1',
          ask: 'TEST',
        }),
      ).rejects.toMatchObject(frozen);
      await expect(
        person.own.triggers.create({
          id,
          createKey: 'trig:frozen:1',
          subject: OWN_AGENT_TRIGGER_SUBJECTS[0],
          perRunCap: '0.1',
          ask: 'TEST',
        }),
      ).rejects.toMatchObject(frozen);
      // An agent order: no session of the agent opens, so nothing runs or trades for the person.
      await expect(person.own.session.open({ id })).rejects.toMatchObject(frozen);
      // What only narrows still works while frozen: a deny rule and a revoke.
      await person.own.policy.add({ id, effect: 'deny', action: 'place_order', scope: 'all' });
      await person.own.consents.revoke({ id, dataClass: 'market_data' });
      // Nothing was granted, issued or scheduled.
      expect(await live(USER)).toEqual({ ...before, consents: before.consents - 1 });
      expect(await sql`SELECT 1 FROM agents.own_agent_tokens WHERE owner_id = ${USER}`).toHaveLength(1);
      // Another person is not frozen by it.
      const { id: theirs } = await other.own.create({ template: 'service-starter', createKey: 'freeze:other:fresh' });
      await expect(other.own.consents.grant({ id: theirs, dataClass: 'own_data' })).resolves.toMatchObject({ revokedAt: null });
    });

    it('a scheduled occurrence that comes due while frozen is skipped by the freeze code, and the agent never runs', async () => {
      const freeze = new MemorySelfFreezeRead();
      const { person, autoRuns } = build(freeze);
      const { scheduleId } = await equip(person, USER);
      await sql`DELETE FROM agents.own_agent_auto_runs`;
      await sql`UPDATE agents.own_agent_schedules SET next_due_at = now() - interval '1 minute' WHERE id = ${scheduleId}`;
      freeze.frozenSince.set(USER, SINCE);
      await tickSchedules(autoRuns, 1);
      expect(await sql`SELECT state, code, reason_code, session_id FROM agents.own_agent_auto_runs`).toEqual([
        { state: 'skipped', code: 'agents.schedule_blocked', reason_code: OWNER_FROZEN_SELF, session_id: null },
      ]);
    });

    it('fails closed: identity down, or no freeze read wired, refuses every one owner_freeze_unread and changes nothing', async () => {
      const { person: setup } = build();
      const { id, secret, scheduleId } = await equip(setup, USER);
      const before = await live(USER);
      const down = new MemorySelfFreezeRead();
      down.down = true;
      for (const freeze of [down, null]) {
        const { person, agentCaller, autoRuns } = build(freeze);
        const unread = { code: 'FORBIDDEN', message: OWNER_FREEZE_UNREAD };
        await expect(person.own.identity.issue({ id })).rejects.toMatchObject(unread);
        await expect(agentCaller.own.identity.agentCall({ token: secret })).rejects.toMatchObject(unread);
        await expect(person.own.consents.grant({ id, dataClass: 'live_write' })).rejects.toMatchObject(unread);
        await expect(person.own.policy.add({ id, effect: 'allow', action: 'cancel_order', scope: 'main' })).rejects.toMatchObject(unread);
        await expect(
          person.own.schedules.create({
            id,
            createKey: 'sched:unread:1',
            repeat: 'once',
            intervalMinutes: '',
            perRunCap: '0.1',
            ask: 'TEST',
          }),
        ).rejects.toMatchObject(unread);
        await expect(person.own.session.open({ id })).rejects.toMatchObject(unread);
        await sql`DELETE FROM agents.own_agent_auto_runs`;
        await sql`UPDATE agents.own_agent_schedules SET next_due_at = now() - interval '1 minute' WHERE id = ${scheduleId}`;
        await tickSchedules(autoRuns, 1);
        expect(await sql`SELECT state, reason_code FROM agents.own_agent_auto_runs`).toEqual([
          { state: 'skipped', reason_code: OWNER_FREEZE_UNREAD },
        ]);
        await sql`UPDATE agents.own_agent_schedules SET next_due_at = now() + interval '1 day' WHERE id = ${scheduleId}`;
      }
      expect({ ...(await live(USER)), claimed: before.claimed }).toEqual(before);
    });
  });
}
