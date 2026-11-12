import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgresAvailable } from '@intafaced/db/testing';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresNotifyRepository } from './postgres-repository.js';

// AL-live-06, AL-alerts-01: channel settings, fill alerts and announced fills on Postgres.
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, '../..');
const SCHEMA = `qnotify_${process.pid}_${Date.now().toString(36)}`;
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const databaseUrl = process.env.TEST_DATABASE_URL_QUANT?.trim() || process.env.TEST_DATABASE_URL?.trim();
const ready = await postgresAvailable(databaseUrl);

describe.skipIf(!ready)('strategy notify store on Postgres (AL-live-06, AL-alerts-01)', () => {
  const sql = postgres(databaseUrl!, { max: 6, onnotice: () => undefined });
  const repo = createPostgresNotifyRepository(sql, SCHEMA);

  beforeAll(async () => {
    const lock: Sql = postgres(databaseUrl!, { max: 1, onnotice: () => undefined });
    await lock`SELECT pg_advisory_lock(hashtext('svc-quant.AL-alerts-01.migrate'))`;
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
      const migration = readFileSync(join(SERVICE, 'drizzle/20261112090000_quant_strategy_notify.sql'), 'utf8')
        .replaceAll('"quant"', `"${SCHEMA}"`)
        .replaceAll("'quant'", `'${SCHEMA}'`);
      await sql.unsafe(migration);
    } finally {
      await lock`SELECT pg_advisory_unlock(hashtext('svc-quant.AL-alerts-01.migrate'))`;
      await lock.end({ timeout: 5 });
    }
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql.end({ timeout: 5 });
  });

  it('keeps one channel setting per account and strategy', async () => {
    expect(await repo.settings({ accountId: ACCOUNT_A, strategyId: 's1' })).toBeNull();
    await repo.saveSettings({ accountId: ACCOUNT_A, strategyId: 's1', channels: ['inapp', 'email'] });
    await repo.saveSettings({ accountId: ACCOUNT_A, strategyId: 's1', channels: ['inapp'] });
    expect((await repo.settings({ accountId: ACCOUNT_A, strategyId: 's1' }))?.channels).toEqual(['inapp']);
    expect(await repo.settings({ accountId: ACCOUNT_B, strategyId: 's1' })).toBeNull();
  });

  it('stores one alert per key, even for two creates at once, and never rewrites it', async () => {
    const input = { accountId: ACCOUNT_A, strategyId: 's1', strategyVersion: 1, template: '{side} {qty}', key: 'quant.alert:s1:a:0' };
    const [one, two] = await Promise.all([repo.createAlert(input), repo.createAlert(input)]);
    expect(one.id).toBe(two.id);
    expect(await repo.alerts({ accountId: ACCOUNT_A, strategyId: 's1', limit: 10 })).toHaveLength(1);
    expect(await repo.alerts({ accountId: ACCOUNT_B, strategyId: 's1', limit: 10 })).toHaveLength(0);
    await expect(sql.unsafe(`UPDATE "${SCHEMA}"."strategy_alerts" SET template = 'x' WHERE id = $1`, [one.id])).rejects.toThrow(
      /quant\.alert_immutable/,
    );
    expect((await repo.sweepAlerts({ after: null, limit: 10 })).map((row) => row.id)).toEqual([one.id]);
  });

  it('records an announced fill once', async () => {
    const [alert] = await repo.alerts({ accountId: ACCOUNT_A, strategyId: 's1', limit: 1 });
    const mark = { alertId: alert!.id, runId: 'run-1', seq: 0, eventId: `quant.fill:${alert!.id}:run-1:0` };
    await repo.markAnnounced(mark);
    await repo.markAnnounced(mark);
    expect([...(await repo.announced({ alertId: alert!.id, runId: 'run-1' }))]).toEqual([0]);
    expect((await repo.announced({ alertId: alert!.id, runId: 'run-2' })).size).toBe(0);
  });
});
