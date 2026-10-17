import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresStrategyRepository } from './postgres-repository.js';
import type { StrategyRepository } from './repository.js';
import type { StrategyDraft } from './repository.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, '../..');
const SCHEMA = `qbe_${process.pid}_${Date.now().toString(36)}`;

const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function testDatabaseUrl(): string {
  const fromEnv = process.env.TEST_DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  const file = readFileSync(join(homedir(), '.codex/context/work/runs/test-db.env'), 'utf8');
  const line = file.split('\n').find((row) => row.startsWith('TEST_DATABASE_URL='));
  const value = line?.slice('TEST_DATABASE_URL='.length).trim();
  if (!value) throw new Error('quant.database_url_unset — TEST_DATABASE_URL is unset');
  return value;
}

const draft = (name: string): StrategyDraft => ({
  name,
  language: 'javascript',
  source: 'oms.buy("BTC-USD", "0.01");',
  cash: '10000',
  blocks: [{ side: 'buy', symbol: 'BTC-USD', qty: '0.01' }],
  risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
  environment: 'paper',
  kind: 'paper',
  claimLabel: 'Paper — not live performance',
  live: false,
  simulated: true,
});

describe('paper strategies survive a new connection to the same database', () => {
  const url = testDatabaseUrl();
  const sql = postgres(url, { max: 2, onnotice: () => undefined });
  let repo: StrategyRepository;

  beforeAll(async () => {
    const migration = readFileSync(join(SERVICE, 'drizzle/0000_quant_strategies.sql'), 'utf8')
      .replaceAll('"quant"', `"${SCHEMA}"`)
      .replaceAll("'quant'", `'${SCHEMA}'`);
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql.unsafe(migration);
    repo = createPostgresStrategyRepository(sql, SCHEMA);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql.end({ timeout: 5 });
  });

  it('keeps every version for the owner, hides a delete, and refuses another account', async () => {
    const created = await repo.create({
      accountId: ACCOUNT_A,
      clientStrategyId: 'client-alpha',
      idempotencyKey: 'idem-create',
      draft: draft('alpha'),
    });
    const replayKey = await repo.create({
      accountId: ACCOUNT_A,
      clientStrategyId: 'client-other',
      idempotencyKey: 'idem-create',
      draft: draft('should-not-apply'),
    });
    expect(replayKey.id).toBe(created.id);
    expect(replayKey.name).toBe('alpha');
    expect(replayKey.versions).toHaveLength(1);

    const replayClient = await repo.create({
      accountId: ACCOUNT_A,
      clientStrategyId: 'client-alpha',
      idempotencyKey: 'idem-create-2',
      draft: draft('still-alpha'),
    });
    expect(replayClient.id).toBe(created.id);
    expect(replayClient.versions).toHaveLength(1);

    const revised = await repo.revise({
      accountId: ACCOUNT_A,
      id: created.id,
      idempotencyKey: 'idem-revise',
      draft: draft('beta'),
    });
    expect(revised.version).toBe(2);
    expect(revised.versions[0]?.name).toBe('alpha');
    expect(revised.versions[0]?.version).toBe(1);
    expect(revised.versions[1]?.name).toBe('beta');

    const reviseReplay = await repo.revise({
      accountId: ACCOUNT_A,
      id: created.id,
      idempotencyKey: 'idem-revise',
      draft: draft('gamma'),
    });
    expect(reviseReplay.name).toBe('beta');
    expect(reviseReplay.versions).toHaveLength(2);

    const reopened = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      const again = createPostgresStrategyRepository(reopened, SCHEMA);
      const loaded = await again.get({ accountId: ACCOUNT_A, id: created.id });
      expect(loaded?.versions.map((row) => row.name)).toEqual(['alpha', 'beta']);
      expect(loaded?.cash).toBe('10000');
      expect(typeof loaded?.cash).toBe('string');
    } finally {
      await reopened.end({ timeout: 5 });
    }

    const probe = spawnSync('pnpm', ['exec', 'tsx', join(HERE, 'reopen-probe.ts')], {
      cwd: SERVICE,
      encoding: 'utf8',
      env: {
        ...process.env,
        QUANT_REOPEN_URL: url,
        QUANT_REOPEN_SCHEMA: SCHEMA,
        QUANT_REOPEN_ACCOUNT: ACCOUNT_A,
        QUANT_REOPEN_ID: created.id,
      },
    });
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual({
      versions: [
        { version: 1, name: 'alpha' },
        { version: 2, name: 'beta' },
      ],
    });

    const second = await repo.create({
      accountId: ACCOUNT_A,
      clientStrategyId: 'client-second',
      idempotencyKey: 'idem-second',
      draft: draft('second'),
    });
    const third = await repo.create({
      accountId: ACCOUNT_A,
      clientStrategyId: 'client-third',
      idempotencyKey: 'idem-third',
      draft: draft('third'),
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 4; i += 1) {
      const page = await repo.list({ accountId: ACCOUNT_A, limit: 1, cursor });
      if (page.strategies[0]) seen.push(page.strategies[0].id);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([created.id, second.id, third.id]);
    await repo.softDelete({ accountId: ACCOUNT_A, id: second.id, idempotencyKey: 'idem-delete-second' });
    await repo.softDelete({ accountId: ACCOUNT_A, id: third.id, idempotencyKey: 'idem-delete-third' });

    expect(await repo.list({ accountId: ACCOUNT_B, limit: 50 })).toEqual({ strategies: [], nextCursor: null });
    expect(await repo.get({ accountId: ACCOUNT_B, id: created.id })).toBeNull();
    await expect(repo.softDelete({ accountId: ACCOUNT_B, id: created.id, idempotencyKey: 'idem-foreign-delete' })).rejects.toThrow(
      /strategy not found/,
    );
    expect(await repo.versions({ accountId: ACCOUNT_B, id: created.id })).toBeNull();

    await expect(sql.unsafe(`UPDATE "${SCHEMA}".strategy_versions SET name = 'hacked' WHERE version = 1`)).rejects.toThrow(/immutable/);
    const versionOne = await sql<{ name: string }[]>`
      SELECT name FROM ${sql(SCHEMA)}.strategy_versions WHERE strategy_id = ${created.id} AND version = 1
    `;
    expect(versionOne[0]?.name).toBe('alpha');

    await repo.softDelete({ accountId: ACCOUNT_A, id: created.id, idempotencyKey: 'idem-delete' });
    expect(await repo.list({ accountId: ACCOUNT_A, limit: 50 })).toEqual({ strategies: [], nextCursor: null });
    expect(await repo.get({ accountId: ACCOUNT_A, id: created.id })).toBeNull();
    const kept = await repo.versions({ accountId: ACCOUNT_A, id: created.id });
    expect(kept?.map((row) => ({ version: row.version, name: row.name }))).toEqual([
      { version: 1, name: 'alpha' },
      { version: 2, name: 'beta' },
    ]);
    const counted = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(SCHEMA)}.strategy_versions WHERE strategy_id = ${created.id}
    `;
    expect(Number(counted[0]?.n)).toBe(2);
  });
});
