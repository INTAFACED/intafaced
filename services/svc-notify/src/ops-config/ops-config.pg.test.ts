import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { PostgresChannelSettingsStore } from './channel-settings.pg.js';
import { PostgresTemplateStore } from './templates.pg.js';

/**
 * Durable channel settings and template versions on a test database. Rows use
 * ids private to this file and are never truncated or dropped.
 */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'drizzle');
const RUN = `opscfg-${Date.now()}`;

const available = URL ? await postgresAvailable(URL) : false;
const client: Sql | null = URL && available ? postgres(URL, { max: 2, onnotice: () => undefined }) : null;

async function migrate(db: Sql): Promise<void> {
  const rows = await db<{ db: string }[]>`SELECT current_database() AS db`;
  if (rows[0]?.db !== 'test') await assertTestDatabase(db, 'svc-notify ops-config.pg.test');
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort();
  for (const file of files) await db.unsafe(readFileSync(join(migrationsDir, file), 'utf8')).catch(() => undefined);
}

describe.skipIf(!URL || !available)('owner configuration stores on Postgres', () => {
  beforeAll(async () => {
    await migrate(client!);
  });

  afterAll(async () => {
    await client?.end({ timeout: 2 });
  });

  it('appends channel setting versions, keeps history, and spends an approval once', async () => {
    const store = new PostgresChannelSettingsStore(client!);
    const now = new Date();
    const before = (await store.history('sms')).length;
    const first = await store.append({
      channel: 'sms',
      enabled: false,
      adapter: 'sms-primary',
      updatedBy: 'a',
      approvalId: `${RUN}-c1`,
      now,
    });
    expect(first).toMatchObject({
      status: 'inserted',
      row: { channel: 'sms', enabled: false, adapter: 'sms-primary', version: before + 1 },
    });
    const second = await store.append({ channel: 'sms', enabled: true, adapter: null, updatedBy: 'a', approvalId: `${RUN}-c2`, now });
    expect(second).toMatchObject({ status: 'inserted', row: { enabled: true, version: before + 2 } });
    expect(await store.append({ channel: 'sms', enabled: false, adapter: null, updatedBy: 'a', approvalId: `${RUN}-c1`, now })).toEqual({
      status: 'exists',
    });
    expect((await store.all()).find((r) => r.channel === 'sms')).toMatchObject({ enabled: true, version: before + 2 });
    expect((await store.history('sms')).slice(0, 2).map((r) => r.version)).toEqual([before + 2, before + 1]);
  });

  it('appends template versions and refuses an edit or delete of a saved one', async () => {
    const store = new PostgresTemplateStore(client!);
    const now = new Date();
    const before = (await store.history('security_notice')).length;
    const first = await store.append({
      key: 'security_notice',
      subject: 's1',
      body: '{{eventSummary}}',
      authorId: 'a',
      approvalId: `${RUN}-t1`,
      now,
    });
    expect(first).toMatchObject({ status: 'inserted', row: { version: before + 1 } });
    const second = await store.append({
      key: 'security_notice',
      subject: 's2',
      body: '{{eventSummary}} again',
      authorId: 'a',
      approvalId: `${RUN}-t2`,
      now,
    });
    expect(second).toMatchObject({ status: 'inserted', row: { version: before + 2 } });
    expect(await store.append({ key: 'security_notice', subject: 's3', body: 'x', authorId: 'a', approvalId: `${RUN}-t1`, now })).toEqual({
      status: 'exists',
    });
    expect((await store.version('security_notice', before + 1))?.subject).toBe('s1');
    expect((await store.latest()).find((r) => r.key === 'security_notice')).toMatchObject({ subject: 's2', version: before + 2 });
    await expect(client!`UPDATE notify.message_templates SET body = 'changed' WHERE approval_id = ${`${RUN}-t1`}`).rejects.toThrow(
      /notify\.append_only/,
    );
    await expect(client!`DELETE FROM notify.message_templates WHERE approval_id = ${`${RUN}-t2`}`).rejects.toThrow(/notify\.append_only/);
    await expect(client!`UPDATE notify.channel_settings_history SET enabled = true WHERE approval_id = ${`${RUN}-c1`}`).rejects.toThrow(
      /notify\.append_only/,
    );
  });

  it('rejects an unknown template key and empty copy at the table', async () => {
    await expect(
      client!`INSERT INTO notify.message_templates (template_key, version, subject, body, author_id, approval_id) VALUES ('nope', 1, 's', 'b', 'a', ${`${RUN}-bad1`})`,
    ).rejects.toThrow();
    await expect(
      client!`INSERT INTO notify.message_templates (template_key, version, subject, body, author_id, approval_id) VALUES ('login_code', 9999, ' ', 'b', 'a', ${`${RUN}-bad2`})`,
    ).rejects.toThrow();
  });
});
