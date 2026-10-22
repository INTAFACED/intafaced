import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { PostgresContactPolicyStore } from './contact-policy.pg.js';

/**
 * Contact policy versions on a test database (BK-safe-02). Rows use approval ids
 * private to this run; versions are append-only, so nothing is deleted.
 */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'drizzle');
const RUN = `cpol-${Date.now()}`;

const available = URL ? await postgresAvailable(URL) : false;
const client: Sql | null = URL && available ? postgres(URL, { max: 2, onnotice: () => undefined }) : null;

async function migrate(db: Sql): Promise<void> {
  const rows = await db<{ db: string }[]>`SELECT current_database() AS db`;
  if (rows[0]?.db !== 'test') await assertTestDatabase(db, 'svc-notify contact-policy.pg.test');
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort();
  for (const file of files) await db.unsafe(readFileSync(join(migrationsDir, file), 'utf8')).catch(() => undefined);
}

describe.skipIf(!URL || !available)('contact policy store on Postgres', () => {
  beforeAll(async () => {
    await migrate(client!);
  });

  afterAll(async () => {
    await client?.end({ timeout: 2 });
  });

  it('appends versions, reads the newest, spends an approval once, and refuses edits', async () => {
    const store = new PostgresContactPolicyStore(client!);
    const before = (await store.latest())?.version ?? 0;
    const copy = {
      officialDomains: ['test.example'],
      neverAskStatement: 'TEST never-ask statement',
      contactChannels: ['email', 'in_app'] as const,
      smsCarriesLinks: false,
      phishingReport: 'TEST phishing report',
    };
    const first = await store.append({
      ...copy,
      contactChannels: [...copy.contactChannels],
      authorId: 'a',
      approvalId: `${RUN}-1`,
      now: new Date(),
    });
    expect(first).toMatchObject({
      status: 'inserted',
      row: { version: before + 1, officialDomains: ['test.example'], smsCarriesLinks: false },
    });
    expect(
      await store.append({ ...copy, contactChannels: [...copy.contactChannels], authorId: 'a', approvalId: `${RUN}-1`, now: new Date() }),
    ).toEqual({ status: 'exists' });
    const second = await store.append({
      ...copy,
      contactChannels: ['sms'],
      smsCarriesLinks: true,
      authorId: 'a',
      approvalId: `${RUN}-2`,
      now: new Date(),
    });
    expect(second).toMatchObject({ status: 'inserted', row: { version: before + 2 } });
    expect(await store.latest()).toMatchObject({ version: before + 2, contactChannels: ['sms'], smsCarriesLinks: true });

    await expect(
      client!`UPDATE notify.contact_policy_versions SET sms_carries_links = false WHERE approval_id = ${`${RUN}-2`}`,
    ).rejects.toMatchObject({
      code: '23514',
    });
    await expect(client!`DELETE FROM notify.contact_policy_versions WHERE approval_id = ${`${RUN}-1`}`).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('rejects a blank statement, no domains and an unknown channel at the table', async () => {
    const insert = (domains: string[], statement: string, channels: string[]) => client!`
      INSERT INTO notify.contact_policy_versions (
        version, official_domains, never_ask_statement, contact_channels, sms_carries_links, phishing_report, author_id, approval_id
      ) VALUES (100000 + floor(random() * 100000)::int, ${domains}, ${statement}, ${channels}, false, 'TEST', 'a', ${`${RUN}-bad-${Math.random()}`})
    `;
    await expect(insert(['test.example'], ' ', ['email'])).rejects.toMatchObject({ code: '23514' });
    await expect(insert([], 'TEST', ['email'])).rejects.toMatchObject({ code: '23514' });
    await expect(insert(['test.example'], 'TEST', ['whatsapp'])).rejects.toMatchObject({ code: '23514' });
  });
});
