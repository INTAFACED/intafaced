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
import type { PolicyBaseline } from './guardrails.js';
import { OWN_RUN_TASK } from './routes.js';

/**
 * Dry runs and test runs of a person's own agent (AG-spend-04, AG-testing-01; J-agents-04 #3, #4): a dry run reports
 * every check a real call meets and the would-be effect, and makes no session, ledger entry, intent or reservation; it
 * is a test run, listed apart from live runs and left out of live analytics unless the person includes test runs.
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
const SECRET = 'an-agents-own-dry-run-test-secret-of-32-plus-x!';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });

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
    id: 'req-own-dry-run',
  });
}

const BASELINE = {
  own_data: 'act_on_request',
  market_data: 'act_on_request',
  draft_write: 'ask_before',
  live_write: 'act_on_request',
} as const;
const KB = { tool: 'support.kb.search', input: { kbQuery: 'TEST question', limit: '5' } };
const ALL_PASSED = ['caps_set', 'tool_declared', 'moves_no_value', 'consent', 'baseline', 'rule', 'door_wired'].map((check) => ({
  check,
  passed: true,
  code: null,
}));

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('own agent dry runs (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 6,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-own-dry-run-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');
  let lockConn: Awaited<ReturnType<typeof sql.reserve>>;
  let provider: MockModelProvider;
  let ledger: MemoryLedger;

  function people(baseline: Record<string, string> = BASELINE) {
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
    provider = new MockModelProvider({ id: 'primary' });
    ledger = new MemoryLedger();
    const gateway = new ModelGateway([provider], table);
    const meter = new UsageMeter(sql, ledger, { assetId: 'USDT', windowMinutes: 60 });
    const runtime = new AgentRuntime(sql, gateway, meter, new MemoryEventBus('svc-agents'), {
      feeAssetId: 'USDT',
      meteringEnabled: true,
      spend: new UserSpendStore(sql),
      funds: { available: async () => 100n * 10n ** 18n },
    });
    const router = createAgentsRouter({
      runtime,
      gateway,
      meter,
      feeAssetId: 'USDT',
      sql,
      policyBaseline: baseline as PolicyBaseline,
    });
    return { person: router.createCaller(callerFor(USER)), other: router.createCaller(callerFor(OTHER)) };
  }
  type Person = ReturnType<typeof people>['person'];

  /** The help search and the comment tool on a draft with its own cap; the person's caps only when `capped`. */
  async function draft(person: Person, { capped = true } = {}) {
    const { id } = await person.own.create({ template: 'service-starter', createKey: `dry:${Math.random()}` });
    await person.own.save({
      id,
      name: 'TEST helper',
      instructions: '',
      tools: ['support.kb.search', 'support.ticket.comment'],
      perSessionCap: '1',
    });
    if (capped) await person.own.limits.set({ id, perCall: '0.1', perSession: '0.5', perPeriod: '5' });
    return id;
  }

  const count = async (table: string) => (await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM agents.${table}`))[0]!.n;
  /** Every table a call, a run or a charge would write, and the ledger's journal: none of them may move on a dry run. */
  const untouched = async () => {
    for (const table of ['agent_sessions', 'spend_reservations', 'agent_place_intents', 'agent_actions', 'usage_records', 'usage_windows'])
      expect(await count(table), table).toBe(0);
    expect(await count('own_agent_approval_requests')).toBe(0);
    expect(ledger.journal()).toEqual([]);
    expect(provider.callCount).toBe(0);
  };

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
      TRUNCATE agents.own_agent_test_runs, agents.own_agent_approval_requests, agents.own_agent_consents, agents.own_agent_rules,
               agents.own_agent_limits, agents.own_agents, agents.spend_reservations, agents.user_spend_limits, agents.think_claims,
               agents.usage_records, agents.usage_windows, agents.agent_place_intents, agents.agent_actions, agents.agent_sessions
      RESTART IDENTITY CASCADE
    `;
  });

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  describe('a dry run of one tool call (J-agents-04 #3)', () => {
    it('passes every check and says it would run the tool once; no session, entry, intent or reservation is made', async () => {
      const { person } = people();
      const id = await draft(person);
      await person.own.consents.grant({ id, dataClass: 'own_data' });
      const dry = await person.own.dryRun({ id, requestId: 'dry:all:0001', ...KB });
      expect(dry).toMatchObject({ kind: 'dry_run', tool: KB.tool, input: KB.input, cost: '0', assetId: 'USDT', label: 'TEST' });
      expect(dry.checks).toEqual(ALL_PASSED);
      expect(dry.effect).toEqual({ kind: 'run', tool: KB.tool, module: 'support', dataClass: 'own_data', input: KB.input });
      await untouched();
      expect(await person.own.holds({ id })).toEqual({ sessions: 0, reservations: 0, intents: 0 });
      expect(await person.own.testRuns({ id, limit: 50 })).toEqual([dry]);
    });

    it('reports each check that fails with the code a real call would get; the effect is the first, the caps a session needs', async () => {
      const { person } = people();
      const id = await draft(person, { capped: false });
      // A field the tool does not declare is not a check: a real call passes only the declared ones to the door.
      const dry = await person.own.dryRun({ id, requestId: 'dry:fail:0001', tool: KB.tool, input: { kbQuery: 'TEST', page: '2' } });
      expect(dry.checks).toEqual([
        { check: 'caps_set', passed: false, code: 'agents.spend.cap_unset' },
        { check: 'tool_declared', passed: true, code: null },
        { check: 'moves_no_value', passed: true, code: null },
        { check: 'consent', passed: false, code: 'agents.consent_required' },
        { check: 'baseline', passed: true, code: null },
        { check: 'rule', passed: true, code: null },
        { check: 'door_wired', passed: true, code: null },
      ]);
      expect(dry.effect).toEqual({ kind: 'refused', tool: KB.tool, code: 'agents.spend.cap_unset' });
      await untouched();
    });

    it('a blank baseline refuses; a hand-off rule refuses; a tool with no door is refused not wired', async () => {
      const blank = people({}).person;
      const id = await draft(blank);
      await blank.own.consents.grant({ id, dataClass: 'own_data' });
      const unset = await blank.own.dryRun({ id, requestId: 'dry:blank:0001', ...KB });
      expect(unset.checks.find((c) => c.check === 'baseline')).toEqual({
        check: 'baseline',
        passed: false,
        code: 'agents.baseline_value_unset',
      });
      expect(unset.checks.map((c) => c.check)).not.toContain('rule');
      expect(unset.effect).toEqual({ kind: 'refused', tool: KB.tool, code: 'agents.baseline_value_unset' });

      const { person } = people();
      await person.own.rules.save({ id, tool: KB.tool, choice: 'hand_off' });
      const handed = await person.own.dryRun({ id, requestId: 'dry:hand:0001', ...KB });
      expect(handed.effect).toEqual({ kind: 'refused', tool: KB.tool, code: 'agents.rule_hand_off' });

      await person.own.consents.grant({ id, dataClass: 'live_write' });
      const comment = { tool: 'support.ticket.comment', input: { ticketId: 'TEST-ticket', body: 'TEST comment' } };
      const unwired = await person.own.dryRun({ id, requestId: 'dry:door:0001', ...comment });
      expect(unwired.checks.at(-1)).toEqual({ check: 'door_wired', passed: false, code: 'agents.tool_not_wired' });
      expect(unwired.effect).toEqual({ kind: 'refused', tool: comment.tool, code: 'agents.tool_not_wired' });
      await untouched();
    });

    it('a call a rule asks about would hold an approval request; nothing is held now and the door is not met', async () => {
      const { person } = people();
      const id = await draft(person);
      await person.own.consents.grant({ id, dataClass: 'live_write' });
      await person.own.rules.save({ id, tool: 'support.ticket.comment', choice: 'ask_before' });
      const input = { ticketId: 'TEST-ticket', body: 'TEST comment' };
      const dry = await person.own.dryRun({ id, requestId: 'dry:ask:0001', tool: 'support.ticket.comment', input });
      expect(dry.checks.map((c) => c.check)).not.toContain('door_wired');
      expect(dry.checks.every((c) => c.passed)).toBe(true);
      expect(dry.effect).toEqual({ kind: 'ask', tool: 'support.ticket.comment', module: 'support', dataClass: 'live_write', input });
      await untouched();
    });

    it('a tool the agent does not carry, or one that moves money, stops there and is refused not declared', async () => {
      const { person } = people();
      const id = await draft(person);
      const caps = { check: 'caps_set', passed: true, code: null };
      const undeclared = { check: 'tool_declared', passed: false, code: 'agents.tool_not_declared' };
      for (const tool of ['trade.quote', 'no.such.tool']) {
        const dry = await person.own.dryRun({ id, requestId: `dry:undeclared:${tool}`, tool, input: {} });
        expect(dry.checks).toEqual([caps, undeclared, { check: 'moves_no_value', passed: true, code: null }]);
        expect(dry.effect).toEqual({ kind: 'refused', tool, code: 'agents.tool_not_declared' });
      }
      // A money tool is never on an agent, and the dry run names why as well.
      const money = await person.own.dryRun({ id, requestId: 'dry:undeclared:ledger.transfer', tool: 'ledger.transfer', input: {} });
      expect(money.checks).toEqual([caps, undeclared, { check: 'moves_no_value', passed: false, code: 'agents.own.money_tool' }]);
      expect(money.effect).toEqual({ kind: 'refused', tool: 'ledger.transfer', code: 'agents.tool_not_declared' });
      await untouched();
    });

    it('the same request id again is the same dry run; another call under it is refused and nothing is added', async () => {
      const { person } = people();
      const id = await draft(person);
      const body = { id, requestId: 'dry:same:0001', ...KB };
      const [first, second] = await Promise.all([person.own.dryRun(body), person.own.dryRun(body)]);
      expect(second).toEqual(first);
      // The same input in another field order is the same call.
      expect(await person.own.dryRun({ ...body, input: { limit: '5', kbQuery: 'TEST question' } })).toEqual(first);
      await expect(person.own.dryRun({ ...body, input: { kbQuery: 'other' } })).rejects.toMatchObject({
        message: 'agents.request_id_replay',
      });
      expect(await count('own_agent_test_runs')).toBe(1);
    });

    it("keeps one person's dry runs, test runs, holds and analytics from another", async () => {
      const { person, other } = people();
      const id = await draft(person);
      await expect(other.own.dryRun({ id, requestId: 'dry:other:0001', ...KB })).rejects.toMatchObject({ message: 'agents.own.not_found' });
      await expect(other.own.testRuns({ id, limit: 50 })).rejects.toMatchObject({ message: 'agents.own.not_found' });
      await expect(other.own.holds({ id })).rejects.toMatchObject({ message: 'agents.own.not_found' });
      await expect(other.own.analytics({ id })).rejects.toMatchObject({ message: 'agents.own.not_found' });
      expect(await count('own_agent_test_runs')).toBe(0);
    });
  });

  describe('live and test runs apart (J-agents-04 #4)', () => {
    it('lists test runs apart from live runs; live analytics leave test runs out unless they are included', async () => {
      const { person } = people();
      const id = await draft(person);
      const { sessionId } = await person.own.session.open({ id });
      const ran = await person.own.run({ id, sessionId, requestId: 'live:run:0001', ask: 'TEST question' });
      const dry = await person.own.dryRun({ id, requestId: 'dry:apart:0001', ...KB });

      const live = await person.own.runs({ id, limit: 50 });
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ sessionId, status: 'executed', cost: ran.cost });
      expect(await person.own.testRuns({ id, limit: 50 })).toEqual([dry]);

      const byDefault = await person.own.analytics({ id });
      expect(byDefault).toEqual({
        includeTest: false,
        runs: 1,
        liveRuns: 1,
        executed: 1,
        refused: 0,
        failed: 0,
        testRuns: null,
        cost: ran.cost,
        assetId: 'USDT',
      });
      expect(await person.own.analytics({ id, includeTest: false })).toEqual(byDefault);
      expect(await person.own.analytics({ id, includeTest: true })).toEqual({ ...byDefault, includeTest: true, runs: 2, testRuns: 1 });
      // The live run holds its session's reservation; the dry run added none.
      expect(await person.own.holds({ id })).toMatchObject({ sessions: 1, intents: 0 });
      expect((await person.own.holds({ id })).reservations).toBe(await count('spend_reservations'));
    });
  });
}
