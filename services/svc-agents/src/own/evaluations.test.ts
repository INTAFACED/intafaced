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
import { checkEvalRequest, evaluate, replyPasses, testEngineReply } from './evaluations.js';
import { OWN_RUN_TASK } from './routes.js';

/**
 * Evaluations of a person's own agent (AG-testing-02; J-agents-04 #5 to #7): a blank threshold or repeats count refuses
 * with its name and runs nothing; a start makes cases-times-repeats results on the test engine, each labelled TEST, and
 * its verdict is the comparison of the passed share with the threshold; the same request id again is the same run. No
 * model is called, nothing is billed and nothing reaches the ledger.
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
const SECRET = 'an-agents-own-evaluations-test-secret-of-32-plus!';
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
    id: 'req-own-evaluations',
  });
}

const CASES = [
  { input: 'TEST case', expected: 'TEST answer' },
  { input: 'Say TEST answer', expected: 'TEST answer' },
];

describe('the test engine, the checks and the comparison, without a database', () => {
  it('answers from the input alone, and a result passes only when the reply contains the expected answer as typed', () => {
    expect(testEngineReply('Say TEST answer')).toBe('TEST reply: Say TEST answer');
    expect(replyPasses('TEST reply: Say TEST answer', 'TEST answer')).toBe(true);
    expect(replyPasses('TEST reply: TEST case', 'TEST answer')).toBe(false);
    expect(replyPasses('TEST reply: say test answer', 'TEST answer')).toBe(false);
  });

  it('refuses a blank threshold or repeats count by name, never a default; then the rest of what cannot run', () => {
    expect(() => checkEvalRequest({ cases: CASES, repeats: '2', threshold: '' })).toThrow('agents.eval.threshold_unset');
    expect(() => checkEvalRequest({ cases: CASES, repeats: '2', threshold: '  ' })).toThrow('agents.eval.threshold_unset');
    expect(() => checkEvalRequest({ cases: CASES, repeats: '', threshold: '50' })).toThrow('agents.eval.repeats_unset');
    expect(() => checkEvalRequest({ cases: [], repeats: '2', threshold: '50' })).toThrow('agents.eval.cases_empty');
    expect(() => checkEvalRequest({ cases: [{ input: ' ', expected: 'x' }], repeats: '2', threshold: '50' })).toThrow(
      'agents.eval.case_blank',
    );
    for (const repeats of ['0', '11', '1.5', '-1', 'two'])
      expect(() => checkEvalRequest({ cases: CASES, repeats, threshold: '50' })).toThrow('agents.eval.repeats_invalid');
    for (const threshold of ['100.01', '101', '-1', '50.123', 'half', '1e2'])
      expect(() => checkEvalRequest({ cases: CASES, repeats: '2', threshold })).toThrow('agents.eval.threshold_invalid');
    expect(() => checkEvalRequest({ cases: [{ input: 'x'.repeat(2001), expected: 'x' }], repeats: '1', threshold: '50' })).toThrow(
      'agents.eval.case_too_long',
    );
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ input: `in ${i}`, expected: 'x' }));
    expect(() => checkEvalRequest({ cases: tooMany, repeats: '1', threshold: '50' })).toThrow('agents.eval.too_many_cases');
  });

  it('keeps a case exactly as typed, spaces included, and judges it so', () => {
    const request = checkEvalRequest({ cases: [{ input: 'reanswer', expected: ' answer' }], repeats: '1', threshold: '100' });
    expect(request.cases).toEqual([{ input: 'reanswer', expected: ' answer' }]);
    expect(evaluate(request)).toMatchObject({ passed: 0, verdict: 'fail' });
  });

  it('runs every case on every repeat; the verdict is the exact passed share against the threshold', () => {
    const request = checkEvalRequest({ cases: CASES, repeats: '2', threshold: '50%' });
    expect(request.threshold).toBe('50');
    expect(checkEvalRequest({ cases: CASES, repeats: '1', threshold: '66.5' })).toMatchObject({
      threshold: '66.5',
      thresholdHundredths: 6650,
    });
    expect(checkEvalRequest({ cases: CASES, repeats: '1', threshold: '7.05' })).toMatchObject({
      threshold: '7.05',
      thresholdHundredths: 705,
    });
    expect(checkEvalRequest({ cases: CASES, repeats: '1', threshold: '100.0' })).toMatchObject({
      threshold: '100',
      thresholdHundredths: 10_000,
    });
    const run = evaluate(request);
    expect(run.results.map((r) => [r.caseIndex, r.repeat, r.passed, r.label])).toEqual([
      [0, 1, false, 'TEST'],
      [0, 2, false, 'TEST'],
      [1, 1, true, 'TEST'],
      [1, 2, true, 'TEST'],
    ]);
    expect(run).toMatchObject({ passed: 2, total: 4, score: '50', verdict: 'pass' });
    expect(evaluate(checkEvalRequest({ cases: CASES, repeats: '2', threshold: '50.01' }))).toMatchObject({ verdict: 'fail' });
    expect(evaluate(checkEvalRequest({ cases: CASES, repeats: '1', threshold: '0' }))).toMatchObject({ verdict: 'pass' });
    expect(evaluate(checkEvalRequest({ cases: CASES.slice(1), repeats: '3', threshold: '100' }))).toMatchObject({
      score: '100',
      verdict: 'pass',
    });
    // Two of three is 66.666...: shown cut to 66.66, and a threshold of 66.67 is not met.
    const thirds = [...CASES, CASES[1]!];
    expect(evaluate(checkEvalRequest({ cases: thirds, repeats: '1', threshold: '66.66' }))).toMatchObject({
      score: '66.66',
      verdict: 'pass',
    });
    expect(evaluate(checkEvalRequest({ cases: thirds, repeats: '1', threshold: '66.67' }))).toMatchObject({ verdict: 'fail' });
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('own agent evaluations (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 6,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-own-evaluations-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');
  let lockConn: Awaited<ReturnType<typeof sql.reserve>>;
  let provider: MockModelProvider;
  let ledger: MemoryLedger;

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
    const router = createAgentsRouter({ runtime, gateway, meter, feeAssetId: 'USDT', sql });
    return { person: router.createCaller(callerFor(USER)), other: router.createCaller(callerFor(OTHER)) };
  }
  type Person = ReturnType<typeof people>['person'];

  async function draft(person: Person) {
    const { id } = await person.own.create({ template: 'service-starter', createKey: `eval:${Math.random()}` });
    await person.own.save({ id, name: 'TEST helper', instructions: '', tools: [], perSessionCap: '1' });
    return id;
  }

  const count = async (table: string) => (await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM agents.${table}`))[0]!.n;

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
      TRUNCATE agents.own_agent_eval_runs, agents.own_agent_eval_cases, agents.own_agents, agents.spend_reservations,
               agents.usage_records, agents.usage_windows, agents.agent_actions, agents.agent_sessions
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

  describe('evaluations through the service (J-agents-04 #5 to #7)', () => {
    it('starts with no test set and no run (#5)', async () => {
      const { person } = people();
      const id = await draft(person);
      expect(await person.own.evals.get({ id, limit: 50 })).toEqual({ testSet: [], latest: null, runs: [] });
    });

    it('refuses a blank threshold by name and stores nothing; with it set, cases times repeats TEST results and the comparison (#6)', async () => {
      const { person } = people();
      const id = await draft(person);
      await expect(
        person.own.evals.start({ id, requestId: 'eval:blank:0001', cases: CASES, repeats: '2', threshold: '' }),
      ).rejects.toMatchObject({
        message: 'agents.eval.threshold_unset',
      });
      expect(await person.own.evals.get({ id, limit: 50 })).toEqual({ testSet: [], latest: null, runs: [] });
      expect(await count('own_agent_eval_runs')).toBe(0);

      const run = await person.own.evals.start({ id, requestId: 'eval:set:0001', cases: CASES, repeats: '2', threshold: '50' });
      expect(run).toMatchObject({ repeats: 2, threshold: '50', passed: 2, total: 4, score: '50', verdict: 'pass', label: 'TEST' });
      expect(run.results).toHaveLength(CASES.length * 2);
      for (const result of run.results) {
        expect(result.label).toBe('TEST');
        expect(result.passed).toBe(result.reply.includes(result.expected));
      }
      const read = await person.own.evals.get({ id, limit: 50 });
      expect(read.testSet).toEqual(CASES);
      expect(read.latest).toEqual(run);
      const { cases: _cases, results: _results, ...summary } = run;
      expect(read.runs).toEqual([{ ...summary, cases: CASES.length }]);
      // The test engine: no model reached, no usage, no window, no reservation, nothing on the ledger.
      expect(provider.callCount).toBe(0);
      for (const table of ['usage_records', 'usage_windows', 'spend_reservations', 'agent_actions']) expect(await count(table)).toBe(0);
      expect(ledger.journal()).toEqual([]);
    });

    it('the same request id again is the same run; with another request under it, refused and nothing changes (#7)', async () => {
      const { person } = people();
      const id = await draft(person);
      const body = { id, requestId: 'eval:same:0001', cases: CASES, repeats: '2', threshold: '50' };
      const [first, second] = await Promise.all([person.own.evals.start(body), person.own.evals.start(body)]);
      expect(second).toEqual(first);
      expect(await person.own.evals.start(body)).toEqual(first);
      await expect(person.own.evals.start({ ...body, threshold: '75' })).rejects.toMatchObject({ message: 'agents.request_id_replay' });
      await expect(person.own.evals.start({ ...body, cases: CASES.slice(1) })).rejects.toMatchObject({
        message: 'agents.request_id_replay',
      });
      const read = await person.own.evals.get({ id, limit: 50 });
      expect(read.latest).toEqual(first);
      expect(read.runs.map((r) => r.id)).toEqual([first.id]);
      expect(await count('own_agent_eval_runs')).toBe(1);
      // A new request id is a new run.
      await person.own.evals.start({ ...body, requestId: 'eval:same:0002' });
      expect((await person.own.evals.get({ id, limit: 50 })).runs).toHaveLength(2);
    });

    it('two starts of one agent at once with different request ids both run; the test set is the later one whole', async () => {
      const { person } = people();
      const id = await draft(person);
      const other = [{ input: 'TEST other', expected: 'TEST other' }];
      const [a, b] = await Promise.all([
        person.own.evals.start({ id, requestId: 'eval:race:0001', cases: CASES, repeats: '1', threshold: '50' }),
        person.own.evals.start({ id, requestId: 'eval:race:0002', cases: other, repeats: '1', threshold: '50' }),
      ]);
      expect(a.id).not.toBe(b.id);
      const read = await person.own.evals.get({ id, limit: 50 });
      expect(read.runs).toHaveLength(2);
      expect([CASES, other]).toContainEqual(read.testSet);
      expect(read.latest!.cases).toEqual(read.testSet);
    });

    it("keeps one person's evaluations from another: someone else's agent is not found", async () => {
      const { person, other } = people();
      const id = await draft(person);
      await expect(other.own.evals.get({ id, limit: 50 })).rejects.toMatchObject({ message: 'agents.own.not_found' });
      await expect(
        other.own.evals.start({ id, requestId: 'eval:other:0001', cases: CASES, repeats: '1', threshold: '50' }),
      ).rejects.toMatchObject({
        message: 'agents.own.not_found',
      });
      expect(await count('own_agent_eval_runs')).toBe(0);
    });
  });
}
