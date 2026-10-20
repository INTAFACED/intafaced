import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresAlertStore } from './store.js';

/** The Postgres engine of alert conditions, expiry and the 0018 backfill, against a real database with fresh user ids. */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? 'postgres://svc_notify:svc_notify@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const migration = (f: string) => readFileSync(join(here, '..', '..', 'drizzle', f), 'utf8');
const BEFORE = ['0000_notify_init.sql', '0006_notify_price_alerts.sql', '0007_notify_alert_kinds.sql', '0008_notify_whale_kind.sql'];

const available = await postgresAvailable(URL);
const sql = available ? postgres(URL, { max: 3, onnotice: () => undefined }) : null;
if (available && sql) {
  await assertTestDatabase(sql, 'svc-notify alerts conditions.pg.test');
  for (const f of BEFORE) await sql.unsafe(migration(f)).catch(() => undefined);
}

const mine: string[] = [];
afterAll(async () => {
  if (sql) {
    for (const userId of mine) await sql`DELETE FROM notify.price_alerts WHERE user_id = ${userId}`;
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
});

const fresh = () => {
  const userId = `u-${randomUUID()}`;
  mine.push(userId);
  return userId;
};
const NOW = new Date('2026-10-20T13:00:00.000Z');

describe.skipIf(!available)('migration 0018', () => {
  it('turns an existing level alert into the matching condition and runs again without harm', async () => {
    const userId = fresh();
    const above = randomUUID();
    const below = randomUUID();
    await sql!.unsafe(`ALTER TABLE notify.price_alerts DROP COLUMN IF EXISTS condition`).catch(() => undefined);
    await sql!`INSERT INTO notify.price_alerts (id, user_id, market_id, direction, target_price) VALUES (${above}, ${userId}, 'BTC-USD', 'above', '100')`;
    await sql!`INSERT INTO notify.price_alerts (id, user_id, market_id, direction, target_price) VALUES (${below}, ${userId}, 'BTC-USD', 'below', '100')`;
    await sql!.unsafe(migration('0018_notify_alert_conditions.sql'));
    await sql!.unsafe(migration('0018_notify_alert_conditions.sql'));
    await sql!.unsafe(migration('0019_notify_alert_extra_conditions.sql'));
    await sql!.unsafe(migration('0019_notify_alert_extra_conditions.sql'));
    const rows = await sql!<{ id: string; condition: string; status: string; last_side: string | null }[]>`
      SELECT id, condition, status, last_side FROM notify.price_alerts WHERE user_id = ${userId}`;
    expect(rows.find((r) => r.id === above)).toMatchObject({ condition: 'greater_than', status: 'active', last_side: null });
    expect(rows.find((r) => r.id === below)).toMatchObject({ condition: 'less_than' });
    // Existing rows come out of 0019 with no added conditions.
    const extra = await sql!<{ extra_conditions: unknown }[]>`SELECT extra_conditions FROM notify.price_alerts WHERE id = ${above}`;
    expect(extra[0]!.extra_conditions).toEqual([]);
  });
});

describe.skipIf(!available)('PostgresAlertStore conditions and expiry', () => {
  const store = () => new PostgresAlertStore(sql!);

  it('stores added conditions as an array and reads them back exactly', async () => {
    const userId = fresh();
    const extras = [
      { condition: 'less_than' as const, targetPrice: '120.000000000000000001' },
      { condition: 'greater_than' as const, targetPrice: '101' },
    ];
    const row = await store().create({ userId, marketId: 'BTC-USD', direction: 'above', targetPrice: '100', extras });
    expect(row.extras).toEqual(extras);
    expect((await store().get(userId, row.id))?.extras).toEqual(extras);
    const bare = await store().create({ userId, marketId: 'BTC-USD', direction: 'above', targetPrice: '100' });
    expect(bare.extras).toEqual([]);
  });

  it('stores the condition, name, message and expiry, and a condition decides the direction', async () => {
    const userId = fresh();
    const row = await store().create({
      userId,
      marketId: 'BTC-USD',
      direction: 'above',
      targetPrice: '100',
      condition: 'crossing_down',
      name: 'Breakout',
      message: '{market} at {price}',
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });
    expect(row).toMatchObject({
      condition: 'crossing_down',
      direction: 'below',
      name: 'Breakout',
      message: '{market} at {price}',
      lastSide: null,
      extras: [],
    });
    expect(row.expiresAt?.toISOString()).toBe('2026-10-20T14:00:00.000Z');
    const legacy = await store().create({ userId, marketId: 'BTC-USD', direction: 'below', targetPrice: '100' });
    expect(legacy).toMatchObject({ condition: 'less_than', direction: 'below', name: null, expiresAt: null });
  });

  it('remembers the side only while the alert is active', async () => {
    const userId = fresh();
    const row = await store().create({ userId, marketId: 'BTC-USD', direction: 'above', targetPrice: '100', condition: 'crossing' });
    await store().setLastSide(userId, row.id, 'below');
    expect((await store().get(userId, row.id))?.lastSide).toBe('below');
    await store().cancel(userId, row.id);
    await store().setLastSide(userId, row.id, 'at_or_above');
    expect((await store().get(userId, row.id))?.lastSide).toBe('below');
  });

  it('expires only active alerts past their time, and leaves open-ended ones', async () => {
    const userId = fresh();
    const due = await store().create({
      userId,
      marketId: 'ETH-USD',
      direction: 'above',
      targetPrice: '1',
      expiresAt: new Date(NOW.getTime() + 1000),
    });
    const later = await store().create({
      userId,
      marketId: 'ETH-USD',
      direction: 'above',
      targetPrice: '1',
      expiresAt: new Date(NOW.getTime() + 9_000_000),
    });
    const open = await store().create({ userId, marketId: 'ETH-USD', direction: 'above', targetPrice: '1' });
    const at = new Date(NOW.getTime() + 5000);
    expect(await store().expireDue(at)).toBeGreaterThanOrEqual(1);
    expect(await store().expireDue(at)).toBe(0);
    expect((await store().get(userId, due.id))?.status).toBe('expired');
    expect((await store().get(userId, later.id))?.status).toBe('active');
    expect((await store().get(userId, open.id))?.status).toBe('active');
    expect((await store().cancel(userId, due.id))?.status).toBe('expired');
    expect((await store().listActiveByMarket('ETH-USD')).some((r) => r.id === due.id)).toBe(false);
  });
});
