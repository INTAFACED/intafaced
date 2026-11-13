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
import { decideMemory, memoryItemRefused, rememberRequest, retentionPeriods, type RetentionPeriods } from './memory.js';
import { OWN_RUN_TASK } from './routes.js';

/**
 * What a person's own agent remembers, and what is kept about them (AG-builder-02, AG-guardrails-04; J-agents-09): an item
 * is remembered only on an explicit request, with its source run; clearing one removes only it and the run keeps its log;
 * memory off writes nothing and the run says so; an account number, key or secret is refused; a blank retention period
 * reads "not set" and refuses a write needing it; a share exposing a transcript waits for the person's confirmation.
 */

describe('memory rules, without a database', () => {
  it('reads an explicit request to remember, and nothing else', () => {
    expect(rememberRequest('TEST: remember that I prefer limit orders')).toBe('I prefer limit orders');
    expect(rememberRequest('Remember I trade on Mondays.')).toBe('I trade on Mondays');
    expect(rememberRequest('please remember that BTC is my main market')).toBe('BTC is my main market');
    expect(rememberRequest('What do you remember?')).toBeNull();
    expect(rememberRequest('remember')).toBeNull();
    expect(rememberRequest('TEST question')).toBeNull();
  });

  it('refuses account numbers, card numbers, keys, secrets and balances; keeps ordinary preferences', () => {
    for (const refused of [
      'my account number DE89 3704 0044 0532 0130 00',
      'DE89370400440532013000',
      'my card is 4111-1111-1111-1111',
      'my wallet key 0x' + 'a'.repeat(64),
      'my password is hunter2',
      'my seed phrase is abandon abandon',
      'my balance is 1000 USDT',
      'my api key',
    ])
      expect(memoryItemRefused(refused), refused).toBe(true);
    for (const kept of ['I prefer limit orders', 'I trade on Mondays', 'BTC and ETH only', 'spinning up a new desk'])
      expect(memoryItemRefused(kept), kept).toBe(false);
  });

  it('decides none, off, refused or remember, and never echoes what it refuses', () => {
    expect(decideMemory('TEST question', true)).toEqual({ kind: 'none' });
    expect(decideMemory('remember that I prefer limit orders', false)).toEqual({ kind: 'off' });
    expect(decideMemory('remember my account number DE89 3704 0044 0532 0130 00', true)).toEqual({ kind: 'refused' });
    expect(decideMemory('remember that I prefer limit orders', true)).toEqual({ kind: 'remember', text: 'I prefer limit orders' });
  });

  it('keeps only the retention periods the owner stored; a blank one is left out, never defaulted', () => {
    expect(retentionPeriods({ action_log: undefined, memory: 30, transcripts: null, approvals: undefined, usage: 365 })).toEqual({
      memory: 30,
      usage: 365,
    });
  });
});

const URL = process.env.TEST_DATABASE_URL_AGENTS ?? 'postgres://svc_agents:svc_agents@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SECRET = 'an-agents-own-memory-test-secret-of-32-plus-chars!!';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });

function callerFor(userId: string, scopes: readonly string[] = ['agents:read', 'agents:execute', 'identity:write']) {
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
    id: 'req-own-memory',
  });
}

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('own agent memory (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 6,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-own-memory-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');
  let lockConn: Awaited<ReturnType<typeof sql.reserve>>;

  function people(retention: RetentionPeriods = {}) {
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
    const router = createAgentsRouter({ runtime, gateway, meter, feeAssetId: 'USDT', sql, ownRetention: retention });
    return {
      person: router.createCaller(callerFor(USER)),
      other: router.createCaller(callerFor(OTHER)),
      /** The same person without identity:write: an agent's token or another app, not their own signed-in session. */
      notSession: router.createCaller(callerFor(USER, ['agents:read', 'agents:execute'])),
    };
  }
  type Person = ReturnType<typeof people>['person'];

  const ownAgent = async (person: Person) =>
    (await person.own.create({ template: 'service-starter', createKey: `memory:${Math.random()}` })).id;
  const ask = (person: Person, id: string, requestId: string, text: string) =>
    person.own.testRun({ id, requestId, ask: text }).then((run) => {
      if (run.kind !== 'engine_run') throw new Error('expected an engine run');
      return run;
    });
  const items = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agents.own_agent_memory`)[0]!.n;

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
    await sql`TRUNCATE agents.own_agent_memory, agents.own_agent_data_controls, agents.own_agent_co_owners, agents.own_agent_test_runs, agents.own_agents RESTART IDENTITY CASCADE`;
  });

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  describe('memory (J-agents-09 #1-#4)', () => {
    it('a run that is asked to remember writes one item with its source run; the run log shows the remember step; a retry is the same item', async () => {
      const { person } = people();
      const id = await ownAgent(person);
      expect(await person.own.memory.get({ id, limit: 50 })).toEqual({ enabled: true, items: [] });
      const run = await ask(person, id, 'memory:run:0001', 'TEST: remember that I prefer limit orders');
      expect(run.memory).toMatchObject({ outcome: 'remembered', text: 'I prefer limit orders', code: null });
      expect(run.log.map((row) => row.step)).toEqual(['asked', 'answered', 'remembered', 'billed']);
      const memory = await person.own.memory.get({ id, limit: 50 });
      expect(memory.items).toEqual([
        { id: run.memory!.itemId, text: 'I prefer limit orders', sourceRunId: run.id, createdAt: expect.any(String) },
      ]);
      // The same request again is that run: no second item.
      const again = await ask(person, id, 'memory:run:0001', 'TEST: remember that I prefer limit orders');
      expect(again.id).toBe(run.id);
      expect(await items()).toBe(1);
      // A question that asks for nothing to be remembered writes nothing.
      const plain = await ask(person, id, 'memory:run:0002', 'TEST question');
      expect(plain.memory).toBeNull();
      expect(await items()).toBe(1);
    });

    it('clearing one item removes only it; the run that remembered it keeps its log; another person cannot see or clear it', async () => {
      const { person, other } = people();
      const id = await ownAgent(person);
      const first = await ask(person, id, 'memory:clear:0001', 'remember that I prefer limit orders');
      await ask(person, id, 'memory:clear:0002', 'remember that I trade on Mondays');
      await expect(other.own.memory.get({ id, limit: 50 })).rejects.toMatchObject({ message: 'agents.own.not_found' });
      await expect(other.own.memory.clear({ id, itemId: first.memory!.itemId! })).rejects.toMatchObject({
        message: 'agents.own.not_found',
      });
      const after = await person.own.memory.clear({ id, itemId: first.memory!.itemId! });
      expect(after.items.map((item) => item.text)).toEqual(['I trade on Mondays']);
      const runs = await person.own.testRuns({ id, limit: 50 });
      const source = runs.find((row) => row.id === first.id);
      expect(source?.kind === 'engine_run' && source.log.find((row) => row.step === 'remembered')?.text).toBe('I prefer limit orders');
      // Cleared already: not found, and nothing else goes.
      await expect(person.own.memory.clear({ id, itemId: first.memory!.itemId! })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'agents.memory.not_found',
      });
      expect(await items()).toBe(1);
    });

    it('with memory off a run writes nothing and says so; switched back on it remembers again', async () => {
      const { person, notSession } = people();
      const id = await ownAgent(person);
      await expect(notSession.own.memory.setEnabled({ id, enabled: false })).rejects.toThrow();
      expect((await person.own.memory.setEnabled({ id, enabled: false })).enabled).toBe(false);
      const run = await ask(person, id, 'memory:off:0001', 'remember that I trade on Mondays');
      expect(run.memory).toEqual({ outcome: 'off', itemId: null, text: null, code: 'agents.memory_disabled' });
      expect(run.log.find((row) => row.step === 'not_remembered')?.text).toBe('agents.memory_disabled');
      expect(await items()).toBe(0);
      await person.own.memory.setEnabled({ id, enabled: true });
      expect((await ask(person, id, 'memory:off:0002', 'remember that I trade on Mondays')).memory?.outcome).toBe('remembered');
      expect(await items()).toBe(1);
    });

    it('an account number is refused agents.memory_item_refused and never stored or echoed in the outcome', async () => {
      const { person } = people();
      const id = await ownAgent(person);
      const run = await ask(person, id, 'memory:refuse:0001', 'TEST: remember my account number DE89 3704 0044 0532 0130 00');
      expect(run.memory).toEqual({ outcome: 'refused', itemId: null, text: null, code: 'agents.memory_item_refused' });
      expect(JSON.stringify(run.memory)).not.toContain('DE89');
      expect(run.log.find((row) => row.step === 'not_remembered')?.text).toBe('agents.memory_item_refused');
      expect(await items()).toBe(0);
    });
  });

  describe('privacy and sharing (J-agents-09 #5, #6)', () => {
    it('with no retention value stored every period reads null and keeping transcripts refuses agents.retention_unset, storing nothing', async () => {
      const { person } = people();
      const id = await ownAgent(person);
      const privacy = await person.own.privacy.get({ id });
      expect(privacy.periods.map((p) => [p.kind, p.days])).toEqual([
        ['action_log', null],
        ['memory', null],
        ['transcripts', null],
        ['approvals', null],
        ['usage', null],
      ]);
      expect(privacy.keepTranscripts).toBe(false);
      await expect(person.own.privacy.keepTranscripts({ id, keep: true })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'agents.retention_unset',
      });
      expect((await person.own.privacy.get({ id })).keepTranscripts).toBe(false);
      // Tightening never needs a period.
      expect((await person.own.privacy.keepTranscripts({ id, keep: false })).keepTranscripts).toBe(false);
    });

    it('with the transcript period set, the period shows and keeping transcripts is stored', async () => {
      const { person } = people({ transcripts: 30 });
      const id = await ownAgent(person);
      const privacy = await person.own.privacy.keepTranscripts({ id, keep: true });
      expect(privacy.keepTranscripts).toBe(true);
      expect(privacy.periods.find((p) => p.kind === 'transcripts')?.days).toBe(30);
      expect(privacy.periods.find((p) => p.kind === 'memory')?.days).toBeNull();
    });

    it('a share that exposes a transcript is listed by the check and refused until confirmed; nothing is shared before', async () => {
      const { person } = people();
      const id = await ownAgent(person);
      expect(await person.own.share.check({ id, includeTranscripts: true, includeMemory: false })).toEqual({
        exposes: ['transcripts'],
        coOwners: 0,
      });
      await sql`INSERT INTO agents.own_agent_co_owners (agent_id, owner_id, co_owner_id) VALUES (${id}, ${USER}, ${OTHER})`;
      await expect(person.own.share.set({ id, includeTranscripts: true, includeMemory: false, confirmed: false })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'agents.privacy.confirm_required',
      });
      expect(await person.own.share.get({ id })).toEqual({
        shared: false,
        includeTranscripts: false,
        includeMemory: false,
        sharedAt: null,
      });
      const shared = await person.own.share.set({ id, includeTranscripts: true, includeMemory: false, confirmed: true });
      expect(shared).toMatchObject({ shared: true, includeTranscripts: true, includeMemory: false });
    });

    it('an agent with no co-owner has no one to share with', async () => {
      const { person } = people();
      const id = await ownAgent(person);
      await expect(person.own.share.set({ id, includeTranscripts: false, includeMemory: false, confirmed: true })).rejects.toMatchObject({
        message: 'agents.share.no_co_owners',
      });
    });
  });
}
