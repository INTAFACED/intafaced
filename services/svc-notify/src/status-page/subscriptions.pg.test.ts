import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { SqlSubscriptionStore } from './subscriptions.pg.js';

/** The status subscription store on the real tables. Each run uses its own addresses, so rows from other runs do not matter. */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const available = URL ? await postgresAvailable(URL) : false;
const client: Sql | null = URL && available ? postgres(URL, { max: 4, onnotice: () => undefined }) : null;

beforeAll(async () => {
  if (!client) return;
  const name = await client<{ db: string }[]>`SELECT current_database() AS db`;
  if (name[0]?.db !== 'test') await assertTestDatabase(client, 'svc-notify status subscriptions.pg.test');
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()) {
    await client.unsafe(readFileSync(join(migrationsDir, file), 'utf8')).catch(() => undefined);
  }
});

afterAll(async () => {
  await client?.end({ timeout: 1 }).catch(() => undefined);
});

describe.skipIf(!URL || !available)('status subscription store on the shared test database', () => {
  it('keeps one row per address, bumps the revision on a return after leaving, and sends a delivery once', async () => {
    const store = new SqlSubscriptionStore(client!);
    const email = `pg-${randomUUID()}@example.com`;
    const at = new Date();
    const first = await store.subscribe(email, ['trading'], at);
    const again = await store.subscribe(email, null, at);
    expect(again).toMatchObject({ id: first.id, state: 'unconfirmed', componentIds: null, revision: 1 });
    const active = await store.update(first.id, { state: 'active', webhookUrl: 'https://hooks.example.com/x' }, at);
    expect(active).toMatchObject({ state: 'active', webhookUrl: 'https://hooks.example.com/x', componentIds: null });
    expect(await store.subscribe(email, ['trading'], at)).toMatchObject({ state: 'active', componentIds: null });
    await store.update(first.id, { state: 'unsubscribed' }, at);
    expect(await store.subscribe(email, ['trading'], at)).toMatchObject({
      state: 'unconfirmed',
      revision: 2,
      webhookUrl: null,
      componentIds: ['trading'],
    });

    const key = `n-${randomUUID()}:${first.id}:email`;
    const claim = { key, subscriberId: first.id, event: 'n', channel: 'email' as const };
    expect((await store.claimDelivery(claim, at)).status).toBe('pending');
    await store.settleDelivery(key, 'accepted', null, at);
    await store.settleDelivery(key, 'failed', null, at);
    expect(await store.claimDelivery(claim, at)).toMatchObject({ status: 'accepted', attempts: 1 });
  });

  it('counts requests per address under concurrency, and spends a challenge once', async () => {
    const store = new SqlSubscriptionStore(client!);
    const email = `rate-${randomUUID()}@example.com`;
    const at = new Date();
    const counts = await Promise.all(
      Array.from({ length: 5 }, () => store.countAndRecordRequest(email, new Date(at.getTime() - 3_600_000), at)),
    );
    expect([...counts].sort()).toEqual([0, 1, 2, 3, 4]);
    const token = randomUUID();
    const used = await Promise.all([store.useChallenge(token, at, new Date(0)), store.useChallenge(token, at, new Date(0))]);
    expect(used.filter(Boolean)).toHaveLength(1);
  });

  it('refuses a webhook that is not https', async () => {
    const store = new SqlSubscriptionStore(client!);
    const row = await store.subscribe(`hook-${randomUUID()}@example.com`, null, new Date());
    await expect(store.update(row.id, { webhookUrl: 'http://hooks.example.com/x' }, new Date())).rejects.toThrow();
  });
});
