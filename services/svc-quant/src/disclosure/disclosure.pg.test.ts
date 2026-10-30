import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresDisclosureRepository } from './postgres-repository.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, '../..');
const SCHEMA = `qdisc_${process.pid}_${Date.now().toString(36)}`;
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function testDatabaseUrl(): string {
  const fromEnv = process.env.TEST_DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  const file = readFileSync(join(homedir(), '.codex/context/work/runs/test-db.env'), 'utf8');
  const line = file.split('\n').find((row) => row.startsWith('TEST_DATABASE_URL='));
  const value = line?.slice('TEST_DATABASE_URL='.length).trim();
  if (!value) throw new Error('quant.database_url_unset — TEST_DATABASE_URL is unset');
  return value;
}

describe('risk disclosure store on Postgres', () => {
  const sql = postgres(testDatabaseUrl(), { max: 6, onnotice: () => undefined });
  const repo = createPostgresDisclosureRepository(sql, SCHEMA);

  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    for (const file of [
      'drizzle/0000_quant_strategies.sql',
      'drizzle/0002_quant_disclosure.sql',
      'drizzle/0003_quant_signal_rules.sql',
      'drizzle/20261030134631_quant_strategy_heads.sql',
    ]) {
      const migration = readFileSync(join(SERVICE, file), 'utf8').replaceAll('"quant"', `"${SCHEMA}"`).replaceAll("'quant'", `'${SCHEMA}'`);
      await sql.unsafe(migration);
    }
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql.end({ timeout: 5 });
  });

  it('has nothing published at first', async () => {
    expect(await repo.current()).toBeNull();
    expect((await repo.counts()).versions).toEqual([]);
  });

  it('gives two operators publishing at once two different versions, and replays a key without a second row', async () => {
    const [one, two] = await Promise.all([
      repo.publish({ text: 'wording one', reason: 'r1', publishedBy: OPERATOR, idempotencyKey: 'pub-one' }),
      repo.publish({ text: 'wording two', reason: 'r2', publishedBy: OPERATOR, idempotencyKey: 'pub-two' }),
    ]);
    expect([one.version, two.version].sort()).toEqual([1, 2]);
    const replay = await repo.publish({ text: 'wording one', reason: 'r1', publishedBy: OPERATOR, idempotencyKey: 'pub-one' });
    expect(replay).toEqual(one);
    await expect(repo.publish({ text: 'different', reason: 'r1', publishedBy: OPERATOR, idempotencyKey: 'pub-one' })).rejects.toMatchObject(
      {
        code: 'quant.idempotency_conflict',
      },
    );
    expect((await repo.counts()).versions).toHaveLength(2);
    expect((await repo.current())?.version).toBe(2);
  });

  it('stores one acceptance per key tuple and returns the first row on a repeat', async () => {
    const input = {
      accountId: ACCOUNT_A,
      strategyId: 'studio_1',
      strategyVersion: 1,
      disclosureVersion: 2,
      key: 'quant.disclose:studio_1:v1:2',
    };
    const first = await repo.accept(input);
    const [again, concurrent] = await Promise.all([repo.accept(input), repo.accept(input)]);
    expect(again).toEqual(first);
    expect(concurrent).toEqual(first);
    const rows = await sql.unsafe(`SELECT count(*)::int AS n FROM "${SCHEMA}"."disclosure_acceptances"`);
    expect(rows[0]?.n).toBe(1);
    expect(await repo.acceptance({ accountId: ACCOUNT_A, strategyId: 'studio_1', strategyVersion: 1, disclosureVersion: 2 })).toEqual(
      first,
    );
    expect(await repo.acceptance({ accountId: ACCOUNT_B, strategyId: 'studio_1', strategyVersion: 1, disclosureVersion: 2 })).toBeNull();
    expect(await repo.acceptance({ accountId: ACCOUNT_A, strategyId: 'studio_1', strategyVersion: 2, disclosureVersion: 2 })).toBeNull();
    expect(await repo.acceptance({ accountId: ACCOUNT_A, strategyId: 'studio_1', strategyVersion: 1, disclosureVersion: 1 })).toBeNull();
  });

  it('refuses an acceptance of a disclosure version that was never published', async () => {
    await expect(
      repo.accept({
        accountId: ACCOUNT_A,
        strategyId: 'studio_1',
        strategyVersion: 1,
        disclosureVersion: 99,
        key: 'quant.disclose:studio_1:v1:99',
      }),
    ).rejects.toThrow();
  });

  it('counts acceptances per version', async () => {
    const counts = await repo.counts();
    expect(counts.versions.map((row) => [row.version, row.acceptances])).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });

  it('never lets a version or an acceptance be rewritten or deleted', async () => {
    await expect(sql.unsafe(`UPDATE "${SCHEMA}"."disclosure_versions" SET body = 'changed' WHERE version = 1`)).rejects.toThrow(
      /disclosure_immutable/,
    );
    await expect(sql.unsafe(`DELETE FROM "${SCHEMA}"."disclosure_versions" WHERE version = 1`)).rejects.toThrow(/disclosure_immutable/);
    await expect(sql.unsafe(`UPDATE "${SCHEMA}"."disclosure_acceptances" SET strategy_id = 'x'`)).rejects.toThrow(/disclosure_immutable/);
    await expect(sql.unsafe(`DELETE FROM "${SCHEMA}"."disclosure_acceptances"`)).rejects.toThrow(/disclosure_immutable/);
  });
});
