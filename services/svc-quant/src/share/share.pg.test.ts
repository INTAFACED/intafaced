import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgresAvailable } from '@intafaced/db/testing';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresShareRepository } from './postgres-repository.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, '../..');
const SCHEMA = `qshare_${process.pid}_${Date.now().toString(36)}`;
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_ID = 'run_share_1';
const databaseUrl = process.env.TEST_DATABASE_URL_QUANT?.trim() || process.env.TEST_DATABASE_URL?.trim();
const ready = await postgresAvailable(databaseUrl);

describe.skipIf(!ready)('share links on Postgres (AL-report-03)', () => {
  const sql = postgres(databaseUrl!, { max: 6, onnotice: () => undefined });
  const repo = createPostgresShareRepository(sql, SCHEMA);
  let firstToken = '';

  beforeAll(async () => {
    const lock: Sql = postgres(databaseUrl!, { max: 1, onnotice: () => undefined });
    await lock`SELECT pg_advisory_lock(hashtext('svc-quant.AL-report-03.migrate'))`;
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
      for (const file of ['drizzle/0001_quant_runs.sql', 'drizzle/0006_quant_result_shares.sql']) {
        const migration = readFileSync(join(SERVICE, file), 'utf8')
          .replaceAll('"quant"', `"${SCHEMA}"`)
          .replaceAll("'quant'", `'${SCHEMA}'`);
        await sql.unsafe(migration);
      }
      await sql.unsafe(
        `INSERT INTO "${SCHEMA}"."runs"
           (id, user_id, scope_key, idempotency_key, kind, strategy_id, strategy_version, started_at, finished_at, outcome_code, result)
         VALUES ($1, $2::uuid, $3, $4, 'backtest', 'studio_1', 1, now(), now(), 'ok', '{}'::jsonb)`,
        [RUN_ID, ACCOUNT_A, ACCOUNT_A, 'algo:bt:share-test'],
      );
    } finally {
      await lock`SELECT pg_advisory_unlock(hashtext('svc-quant.AL-report-03.migrate'))`;
      await lock.end({ timeout: 5 });
    }
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql.end({ timeout: 5 });
  });

  it('stores one active link for two creates at once, and keeps only the token hash', async () => {
    const now = '2026-10-23T00:00:00.000Z';
    const [one, two] = await Promise.all([
      repo.create({ accountId: ACCOUNT_A, runId: RUN_ID, seq: 0, now }),
      repo.create({ accountId: ACCOUNT_A, runId: RUN_ID, seq: 0, now }),
    ]);
    const tokens = [one.token, two.token].filter((token): token is string => token !== null);
    expect(tokens).toHaveLength(1);
    firstToken = tokens[0]!;
    expect(one.links).toBe(1);
    expect(two.link.key).toBe('result.share:run_share_1:0');
    const rows = await sql.unsafe(`SELECT token_hash, write_key FROM "${SCHEMA}"."result_shares"`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toHaveLength(64);
    expect(rows[0]?.token_hash).not.toBe(tokens[0]);
    expect(JSON.stringify(rows)).not.toContain(tokens[0]);
  });

  it('does not reuse a revoked key, and a revoked token reads the same as an unknown one', async () => {
    await repo.revoke({ accountId: ACCOUNT_A, runId: RUN_ID, now: '2026-10-23T00:01:00.000Z' });
    const stale = await repo.create({ accountId: ACCOUNT_A, runId: RUN_ID, seq: 0, now: '2026-10-23T00:02:00.000Z' });
    expect(stale.token).toBeNull();
    expect(stale.link.revokedAt).not.toBeNull();
    const next = await repo.create({ accountId: ACCOUNT_A, runId: RUN_ID, seq: 1, now: '2026-10-23T00:02:00.000Z' });
    expect(next.token).not.toBeNull();
    expect(next.link.key).toBe('result.share:run_share_1:1');
    const active = (await repo.list({ accountId: ACCOUNT_A, runId: RUN_ID })).filter((link) => link.revokedAt === null);
    expect(active).toHaveLength(1);
    const at = Date.parse('2026-10-23T00:03:00.000Z');
    const revokedRead = await repo.openPublic({ token: firstToken, rate: 10, windowMs: 60_000, nowMs: at });
    const unknownRead = await repo.openPublic({ token: 'not-a-link', rate: 10, windowMs: 60_000, nowMs: at });
    expect(revokedRead.kind).toBe('missing');
    expect(unknownRead.kind).toBe(revokedRead.kind);
    const opened = await repo.openPublic({ token: next.token!, rate: 10, windowMs: 60_000, nowMs: at });
    expect(opened.kind).toBe('ok');
  });

  it('counts public reads inside the owner window and allows them again after it', async () => {
    await repo.revoke({ accountId: ACCOUNT_A, runId: RUN_ID, now: '2026-10-23T01:00:00.000Z' });
    const created = await repo.create({ accountId: ACCOUNT_A, runId: RUN_ID, seq: 2, now: '2026-10-23T01:00:00.000Z' });
    const at = Date.parse('2026-10-23T02:00:00.000Z');
    expect((await repo.openPublic({ token: created.token!, rate: 1, windowMs: 60_000, nowMs: at })).kind).toBe('ok');
    expect((await repo.openPublic({ token: created.token!, rate: 1, windowMs: 60_000, nowMs: at + 1_000 })).kind).toBe('limited');
    expect((await repo.openPublic({ token: created.token!, rate: 1, windowMs: 60_000, nowMs: at + 61_000 })).kind).toBe('ok');
  });

  it('returns missing for a revoked token after unknown reads have filled the rate', async () => {
    const now = '2026-10-23T04:00:00.000Z';
    await repo.revoke({ accountId: ACCOUNT_A, runId: RUN_ID, now });
    const before = await repo.list({ accountId: ACCOUNT_A, runId: RUN_ID });
    const created = await repo.create({ accountId: ACCOUNT_A, runId: RUN_ID, seq: before.length, now });
    expect(created.token).not.toBeNull();
    const at = Date.parse('2026-10-23T04:01:00.000Z');
    expect((await repo.openPublic({ token: created.token!, rate: 0, windowMs: 60_000, nowMs: at })).kind).toBe('limited');
    expect((await repo.openPublic({ token: 'not-a-link', rate: 1, windowMs: 60_000, nowMs: at })).kind).toBe('missing');
    expect((await repo.openPublic({ token: 'still-unknown', rate: 1, windowMs: 60_000, nowMs: at + 1 })).kind).toBe('missing');
    await repo.revoke({ accountId: ACCOUNT_A, runId: RUN_ID, now: '2026-10-23T04:02:00.000Z' });
    expect((await repo.openPublic({ token: created.token!, rate: 1, windowMs: 60_000, nowMs: at + 2 })).kind).toBe('missing');
    expect((await repo.openPublic({ token: 'not-a-link', rate: 1, windowMs: 60_000, nowMs: at + 3 })).kind).toBe('missing');
    expect((await repo.openPublic({ token: created.token!, rate: 0, windowMs: 60_000, nowMs: at + 4 })).kind).toBe('missing');
    const unknownBuckets = await sql.unsafe(`SELECT bucket FROM "${SCHEMA}"."share_reads" WHERE bucket = 'unknown'`);
    expect(unknownBuckets).toHaveLength(0);
  });

  it('refuses a rewrite of the hash and a delete', async () => {
    await expect(sql.unsafe(`UPDATE "${SCHEMA}"."result_shares" SET token_hash = repeat('ab', 32)`)).rejects.toThrow(/share_immutable/);
    await expect(sql.unsafe(`DELETE FROM "${SCHEMA}"."result_shares"`)).rejects.toThrow(/share_immutable/);
  });
});
