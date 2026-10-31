import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUN_RESERVE, RUN_RESULT_MAX_BYTES } from '../runs/limit.js';
import { createPostgresRunRepository } from '../runs/postgres-repository.js';
import type { StrategyDraft } from '../studio/repository.js';
import { createPostgresStrategyRepository } from '../studio/postgres-repository.js';
import { createPostgresQuotaStore, postgresQuotaHold } from './postgres-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, '../..');
const SCHEMA = `qquota_${process.pid}_${Date.now().toString(36)}`;
const OPERATOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCOUNT_C = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const draft = (name: string): StrategyDraft => ({
  name,
  language: 'javascript',
  source: 'oms.buy("BTC-USD", "0.01");',
  cash: '10000',
  blocks: [{ side: 'buy', symbol: 'BTC-USD', qty: '0.01' }],
  modules: null,
  risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
  environment: 'paper',
  kind: 'paper',
  claimLabel: 'Paper — not live performance',
  live: false,
  simulated: true,
  releaseNote: '',
});

function testDatabaseUrl(): string {
  const fromEnv = process.env.TEST_DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  const file = readFileSync(join(homedir(), '.codex/context/work/runs/test-db.env'), 'utf8');
  const line = file.split('\n').find((row) => row.startsWith('TEST_DATABASE_URL='));
  const value = line?.slice('TEST_DATABASE_URL='.length).trim();
  if (!value) throw new Error('quant.database_url_unset — TEST_DATABASE_URL is unset');
  return value;
}

describe('quotas by plan on Postgres (AL-limits-01)', () => {
  const sql = postgres(testDatabaseUrl(), { max: 8, onnotice: () => undefined });
  // Accounts without an assignment fall under TEST, the default profile these tests publish.
  const hold = postgresQuotaHold(SCHEMA, 'TEST', RUN_RESERVE);
  const store = createPostgresQuotaStore(sql, SCHEMA, 'TEST', RUN_RESERVE);
  const strategies = createPostgresStrategyRepository(sql, SCHEMA, hold);
  const runs = createPostgresRunRepository(sql, SCHEMA, RUN_RESULT_MAX_BYTES, hold);
  let n = 0;
  const set = (profile: string, resource: Parameters<typeof store.setLimit>[0]['resource'], limit: string | null) =>
    store.setLimit({
      profile,
      resource,
      limit,
      reason: 'LOCAL TEST',
      setBy: OPERATOR,
      idempotencyKey: `quant.quota:${profile}:${resource}:${(n += 1)}`,
    });
  const begin = (userId: string, key: string, kind: 'backtest' | 'sandbox' = 'backtest') =>
    runs.begin({ userId, idempotencyKey: key, kind, strategyId: null, strategyVersion: null });

  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
    const files = readdirSync(join(SERVICE, 'drizzle'))
      .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
      .sort();
    for (const name of files) {
      await sql.unsafe(
        readFileSync(join(SERVICE, 'drizzle', name), 'utf8')
          .replaceAll('"quant"', `"${SCHEMA}"`)
          .replaceAll("'quant'", `'${SCHEMA}'`),
      );
    }
    for (const resource of [
      'strategies',
      'versions_per_strategy',
      'concurrent_runs',
      'paper_runs',
      'stored_runs',
      'log_lines',
      'storage_bytes',
    ] as const) {
      await set('TEST', resource, '1000000000');
    }
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql.end({ timeout: 0 });
  });

  it('refuses at the limit with the resource and counts, and counts nothing twice on a replay', async () => {
    await set('THREE', 'stored_runs', '3');
    for (const resource of ['concurrent_runs', 'log_lines', 'storage_bytes'] as const) await set('THREE', resource, '100000000');
    await store.assign({
      accountId: ACCOUNT_A,
      profile: 'THREE',
      reason: 'LOCAL TEST',
      assignedBy: OPERATOR,
      idempotencyKey: 'assign:a:1',
    });
    for (const key of ['r1', 'r2', 'r3']) await begin(ACCOUNT_A, key);
    // The replay of a stored run returns it and is not a fourth.
    expect((await begin(ACCOUNT_A, 'r3')).idempotencyKey).toBe('r3');
    await expect(begin(ACCOUNT_A, 'r4')).rejects.toThrow(
      /quant\.quota_exceeded — stored_runs — stored runs: 3 used of 3 allowed by profile THREE/,
    );
    const usage = await store.usage(ACCOUNT_A);
    expect(usage.profile).toBe('THREE');
    expect(usage.rows.find((row) => row.resource === 'stored_runs')).toEqual({ resource: 'stored_runs', limit: '3', used: '3' });
    // Three runs never finished: they are still in progress.
    expect(usage.rows.find((row) => row.resource === 'concurrent_runs')).toEqual({
      resource: 'concurrent_runs',
      limit: '100000000',
      used: '3',
    });
    // Each of them holds room for the largest result it may store until it finishes.
    expect(usage.rows.find((row) => row.resource === 'storage_bytes')!.used).toBe(String(3 * RUN_RESULT_MAX_BYTES));
    expect(usage.rows.find((row) => row.resource === 'strategies')).toEqual({ resource: 'strategies', limit: null, used: '0' });
  });

  it('refuses every create at a limit of 0, a blank limit by name, and an account with no profile', async () => {
    await set('ZERO', 'strategies', '0');
    await store.assign({ accountId: ACCOUNT_B, profile: 'ZERO', reason: 'LOCAL TEST', assignedBy: OPERATOR, idempotencyKey: 'assign:b:1' });
    await expect(
      strategies.create({ accountId: ACCOUNT_B, clientStrategyId: 'c1', idempotencyKey: 'k1', draft: draft('one') }),
    ).rejects.toThrow(/quant\.quota_exceeded — strategies — saved strategies: 0 used of 0 allowed by profile ZERO/);
    // ZERO never set stored runs: blank, refused by name, never defaulted.
    await expect(begin(ACCOUNT_B, 'b1')).rejects.toThrow(
      /quant\.quota_unset — concurrent_runs — the limit for runs in progress in profile ZERO is not set/,
    );

    const unassigned = createPostgresStrategyRepository(sql, SCHEMA, postgresQuotaHold(SCHEMA, null, RUN_RESERVE));
    await expect(
      unassigned.create({ accountId: ACCOUNT_C, clientStrategyId: 'c1', idempotencyKey: 'k1', draft: draft('one') }),
    ).rejects.toThrow(/quant\.quota_profile_unset/);
    // The default profile applies, and the operator's later assignment wins over it.
    const created = await strategies.create({ accountId: ACCOUNT_C, clientStrategyId: 'c1', idempotencyKey: 'k1', draft: draft('one') });
    expect(created.version).toBe(1);
    await store.assign({ accountId: ACCOUNT_C, profile: 'ZERO', reason: 'LOCAL TEST', assignedBy: OPERATOR, idempotencyKey: 'assign:c:1' });
    await expect(
      strategies.create({ accountId: ACCOUNT_C, clientStrategyId: 'c2', idempotencyKey: 'k2', draft: draft('two') }),
    ).rejects.toThrow(/quant\.quota_exceeded — strategies — saved strategies: 1 used of 0/);
  });

  it('lets exactly one of two writes racing at the limit through', async () => {
    const racer = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await set('ONE', 'stored_runs', '1');
    for (const resource of ['concurrent_runs', 'log_lines', 'storage_bytes'] as const) await set('ONE', resource, '100000000');
    await store.assign({ accountId: racer, profile: 'ONE', reason: 'LOCAL TEST', assignedBy: OPERATOR, idempotencyKey: 'assign:race:1' });
    const outcomes = await Promise.allSettled([begin(racer, 'race-a'), begin(racer, 'race-b'), begin(racer, 'race-c')]);
    expect(outcomes.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    for (const row of outcomes.filter((one) => one.status === 'rejected')) {
      expect(String((row as PromiseRejectedResult).reason)).toMatch(/quant\.quota_exceeded — stored_runs/);
    }
  });

  it('keys operator writes, refuses a reused key for other content, and never rewrites a row', async () => {
    const first = await store.setLimit({
      profile: 'KEYED',
      resource: 'strategies',
      limit: '5',
      reason: 'LOCAL TEST',
      setBy: OPERATOR,
      idempotencyKey: 'quant.quota:KEYED:strategies:1',
    });
    const again = await store.setLimit({
      profile: 'KEYED',
      resource: 'strategies',
      limit: '5',
      reason: 'LOCAL TEST',
      setBy: OPERATOR,
      idempotencyKey: 'quant.quota:KEYED:strategies:1',
    });
    expect(again).toEqual(first);
    await expect(
      store.setLimit({
        profile: 'KEYED',
        resource: 'strategies',
        limit: '6',
        reason: 'LOCAL TEST',
        setBy: OPERATOR,
        idempotencyKey: 'quant.quota:KEYED:strategies:1',
      }),
    ).rejects.toThrow(/quant\.idempotency_conflict/);
    const blank = await store.setLimit({
      profile: 'KEYED',
      resource: 'strategies',
      limit: null,
      reason: 'LOCAL TEST',
      setBy: OPERATOR,
      idempotencyKey: 'quant.quota:KEYED:strategies:2',
    });
    expect(blank).toMatchObject({ limit: null, seq: 2 });
    await expect(sql.unsafe(`UPDATE "${SCHEMA}"."quota_limits" SET limit_value = 9`)).rejects.toThrow(/quant\.quota_immutable/);
    await expect(sql.unsafe(`DELETE FROM "${SCHEMA}"."quota_assignments"`)).rejects.toThrow(/quant\.quota_immutable/);
  });

  it('counts versions per strategy and stops a new version at its limit', async () => {
    const owner = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await set('VERSIONS', 'strategies', '10');
    await set('VERSIONS', 'versions_per_strategy', '2');
    await set('VERSIONS', 'storage_bytes', '100000');
    await store.assign({ accountId: owner, profile: 'VERSIONS', reason: 'LOCAL TEST', assignedBy: OPERATOR, idempotencyKey: 'assign:v:1' });
    const created = await strategies.create({ accountId: owner, clientStrategyId: 'v1', idempotencyKey: 'vk1', draft: draft('v') });
    await strategies.revise({ accountId: owner, id: created.id, idempotencyKey: 'vk2', draft: draft('v2') });
    await expect(strategies.revise({ accountId: owner, id: created.id, idempotencyKey: 'vk3', draft: draft('v3') })).rejects.toThrow(
      /quant\.quota_exceeded — versions_per_strategy — versions of this strategy: 2 used of 2/,
    );
    const usage = await store.usage(owner);
    expect(usage.rows.find((row) => row.resource === 'versions_per_strategy')).toEqual({
      resource: 'versions_per_strategy',
      limit: '2',
      used: '2',
    });
    expect(Number(usage.rows.find((row) => row.resource === 'storage_bytes')!.used)).toBeGreaterThan(0);
  });

  it('frees a slot when a strategy goes to the recycle bin, and refuses its restore at the limit', async () => {
    const owner = '11111111-1111-4111-8111-111111111111';
    await set('BIN', 'strategies', '1');
    await set('BIN', 'storage_bytes', '100000');
    await store.assign({ accountId: owner, profile: 'BIN', reason: 'LOCAL TEST', assignedBy: OPERATOR, idempotencyKey: 'assign:bin:1' });
    const first = await strategies.create({ accountId: owner, clientStrategyId: 'b1', idempotencyKey: 'bk1', draft: draft('one') });
    await strategies.softDelete({ accountId: owner, id: first.id, idempotencyKey: 'bk2' });
    expect((await store.usage(owner)).rows.find((row) => row.resource === 'strategies')!.used).toBe('0');
    await strategies.create({ accountId: owner, clientStrategyId: 'b2', idempotencyKey: 'bk3', draft: draft('two') });
    await expect(strategies.restore({ accountId: owner, id: first.id, idempotencyKey: 'bk4' })).rejects.toThrow(
      /quant\.quota_exceeded — strategies — saved strategies: 1 used of 1 allowed by profile BIN$/,
    );
    // Still in the bin, with its version: nothing changed.
    expect(await strategies.get({ accountId: owner, id: first.id })).toBeNull();
  });

  it('answers a same-key retry that waited at the limit with its replay, never a refusal', async () => {
    const owner = '22222222-2222-4222-8222-222222222222';
    for (const resource of ['concurrent_runs', 'log_lines', 'storage_bytes'] as const) await set('SAME', resource, '100000000');
    await set('SAME', 'stored_runs', '1');
    await set('SAME', 'strategies', '1');
    await store.assign({ accountId: owner, profile: 'SAME', reason: 'LOCAL TEST', assignedBy: OPERATOR, idempotencyKey: 'assign:same:1' });
    const runsBack = await Promise.all([begin(owner, 'same-key'), begin(owner, 'same-key'), begin(owner, 'same-key')]);
    expect(new Set(runsBack.map((row) => row.id)).size).toBe(1);
    const saved = await Promise.all(
      [1, 2, 3].map(() =>
        strategies.create({ accountId: owner, clientStrategyId: 'same', idempotencyKey: 'same-save', draft: draft('same') }),
      ),
    );
    expect(new Set(saved.map((row) => row.id)).size).toBe(1);
  });

  it('holds room for the largest result while a run is in progress, and refuses a run with no account', async () => {
    const owner = '33333333-3333-4333-8333-333333333333';
    for (const resource of ['concurrent_runs', 'stored_runs', 'log_lines'] as const) await set('ROOM', resource, '100000000');
    // Room for two runs in progress and a little more, not three.
    await set('ROOM', 'storage_bytes', String(2 * RUN_RESULT_MAX_BYTES + 1000));
    await store.assign({ accountId: owner, profile: 'ROOM', reason: 'LOCAL TEST', assignedBy: OPERATOR, idempotencyKey: 'assign:room:1' });
    const one = await begin(owner, 'room-1');
    await begin(owner, 'room-2');
    await expect(begin(owner, 'room-3')).rejects.toThrow(
      new RegExp(
        `quant\\.quota_exceeded — storage_bytes — stored source and results \\(bytes\\): ${2 * RUN_RESULT_MAX_BYTES} used of ${2 * RUN_RESULT_MAX_BYTES + 1000} allowed by profile ROOM — this needs ${RUN_RESULT_MAX_BYTES} more`,
      ),
    );
    // Finished, a run counts what it stored: a small result frees the rest of its room.
    await runs.finish({ id: one.id, userId: owner, outcome: 'ok', stored: { detail: null, response: { logs: ['a', 'b'] } } });
    const usage = await store.usage(owner);
    const stored = Number(usage.rows.find((row) => row.resource === 'storage_bytes')!.used);
    expect(stored).toBeLessThan(RUN_RESULT_MAX_BYTES + 100);
    expect(usage.rows.find((row) => row.resource === 'log_lines')!.used).toBe(String(2 + Number(RUN_RESERVE.logLines)));
    await begin(owner, 'room-3');

    await expect(
      runs.begin({ userId: null, idempotencyKey: 'anon-1', kind: 'sandbox', strategyId: null, strategyVersion: null }),
    ).rejects.toThrow(/quant\.quota_profile_unset — quota profile — a run with no account/);
  });
});
