import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { afterAll, describe, expect, it } from 'vitest';
import { AlertQuotaReachedError, PostgresAlertStore } from './store.js';
import { PostgresAlertTriggerLog } from './trigger-log.js';

/** The Postgres engine of alert conditions, expiry and the 0018 backfill, against a real database with fresh user ids. */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? 'postgres://svc_notify:svc_notify@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const migration = (f: string) => readFileSync(join(here, '..', '..', 'drizzle', f), 'utf8');
const BEFORE = ['0000_notify_init.sql', '0006_notify_price_alerts.sql', '0007_notify_alert_kinds.sql', '0008_notify_whale_kind.sql'];

const ALERT_MIGRATIONS = [
  '0018_notify_alert_conditions.sql',
  '0019_notify_alert_extra_conditions.sql',
  '0020_notify_alert_stopped.sql',
  '0021_notify_alert_triggers.sql',
  '0022_notify_alert_frequency.sql',
  '0026_notify_alert_burst.sql',
  '0038_notify_alert_price_source.sql',
];

const available = await postgresAvailable(URL);
const sql = available ? postgres(URL, { max: 3, onnotice: () => undefined }) : null;
if (available && sql) {
  await assertTestDatabase(sql, 'svc-notify alerts conditions.pg.test');
  for (const f of BEFORE) await sql.unsafe(migration(f)).catch(() => undefined);
  // Every alert migration, in order, so each describe below finds the columns its engine reads. They are idempotent.
  for (const f of ALERT_MIGRATIONS) await sql.unsafe(migration(f)).catch(() => undefined);
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
    await sql!.unsafe(migration('0020_notify_alert_stopped.sql'));
    await sql!.unsafe(migration('0020_notify_alert_stopped.sql'));
    const rows = await sql!<{ id: string; condition: string; status: string; last_side: string | null }[]>`
      SELECT id, condition, status, last_side FROM notify.price_alerts WHERE user_id = ${userId}`;
    expect(rows.find((r) => r.id === above)).toMatchObject({ condition: 'greater_than', status: 'active', last_side: null });
    expect(rows.find((r) => r.id === below)).toMatchObject({ condition: 'less_than' });
    // Existing rows come out of 0019 with no added conditions.
    const extra = await sql!<{ extra_conditions: unknown }[]>`SELECT extra_conditions FROM notify.price_alerts WHERE id = ${above}`;
    expect(extra[0]!.extra_conditions).toEqual([]);
    // ...and take their creation time as the time they last changed.
    const times = await sql!<{ same: boolean }[]>`SELECT (updated_at = created_at) AS same FROM notify.price_alerts WHERE id = ${above}`;
    expect(times[0]!.same).toBe(true);
  });
});

describe.skipIf(!available)('PostgresAlertStore conditions and expiry', () => {
  const store = () => new PostgresAlertStore(sql!);

  it('replaces the editable state of an active or stopped alert and forgets the remembered side', async () => {
    const userId = fresh();
    const row = await store().create({ userId, marketId: 'BTC-USD', direction: 'above', targetPrice: '100', condition: 'crossing_up' });
    await store().setLastSide(userId, row.id, 'below');
    expect((await store().get(userId, row.id))!.lastSide).toBe('below');
    const next = {
      direction: 'below' as const,
      targetPrice: '90.000000000000000001',
      condition: 'less_than' as const,
      name: 'Dip',
      message: null,
      expiresAt: null,
      extras: [{ condition: 'greater_than' as const, targetPrice: '80' }],
      frequency: 'once' as const,
      source: 'mark' as const,
    };
    const edited = await store().replace(userId, row.id, next, NOW);
    expect(edited).toMatchObject({ ...next, lastSide: null, status: 'active' });
    expect(edited!.updatedAt).toEqual(NOW);
    await store().setStopped(userId, row.id, true, NOW);
    expect(await store().replace(userId, row.id, { ...next, name: 'Still editable' }, NOW)).toMatchObject({
      status: 'stopped',
      name: 'Still editable',
    });
    await store().cancel(userId, row.id);
    expect(await store().replace(userId, row.id, next, NOW)).toBeNull();
  });

  it('stops and resumes only the right way round, and keeps the alert', async () => {
    const userId = fresh();
    const row = await store().create({ userId, marketId: 'BTC-USD', direction: 'above', targetPrice: '100' });
    expect((await store().setStopped(userId, row.id, false, NOW))!.status).toBe('active');
    expect((await store().setStopped(userId, row.id, true, NOW))!.status).toBe('stopped');
    expect((await store().setStopped(userId, row.id, true, NOW))!.status).toBe('stopped');
    expect(
      await store()
        .listActiveByMarket('BTC-USD')
        .then((rows) => rows.some((r) => r.id === row.id)),
    ).toBe(false);
    expect((await store().setStopped(userId, row.id, false, NOW))!.status).toBe('active');
    expect(await store().setStopped('someone-else', row.id, true, NOW)).toBeNull();
    const cancelled = await store().cancel(userId, row.id);
    expect(cancelled!.status).toBe('cancelled');
    expect((await store().setStopped(userId, row.id, false, NOW))!.status).toBe('cancelled');
  });

  it('expires a stopped alert whose time has passed, and deletes any alert once', async () => {
    const userId = fresh();
    const past = new Date(NOW.getTime() - 1000);
    const row = await store().create({ userId, marketId: 'BTC-USD', direction: 'above', targetPrice: '100', expiresAt: past });
    await store().setStopped(userId, row.id, true, NOW);
    await store().expireDue(NOW);
    expect((await store().get(userId, row.id))!.status).toBe('expired');
    expect(await store().remove('someone-else', row.id)).toBe(false);
    expect(await store().remove(userId, row.id)).toBe(true);
    expect(await store().remove(userId, row.id)).toBe(false);
    expect(await store().get(userId, row.id)).toBeNull();
  });

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
      frequency: 'once' as const,
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

describe.skipIf(!available)('PostgresAlertTriggerLog and migration 0021', () => {
  it('runs twice, records a fire once, lists newest first for the owner only, and prunes', async () => {
    await sql!.unsafe(migration('0021_notify_alert_triggers.sql'));
    await sql!.unsafe(migration('0021_notify_alert_triggers.sql'));
    const log = new PostgresAlertTriggerLog(sql!);
    const userId = fresh();
    const other = fresh();
    const a = randomUUID();
    const b = randomUUID();
    const row = (alertId: string, uid: string, at: Date, markPrice: string, seq = 1) => ({
      alertId,
      seq,
      userId: uid,
      marketId: 'BTC-USD',
      condition: 'greater_than' as const,
      targetPrice: '100',
      markPrice,
      firedAt: at,
      notificationId: null,
    });
    await log.record(row(a, userId, NOW, '101.5'));
    await log.record(row(a, userId, NOW, '999'));
    await log.record(row(b, userId, new Date(NOW.getTime() + 1000), '102'));
    await log.record(row(randomUUID(), other, NOW, '103'));
    // A repeating alert keeps one row per trigger number, and the same number twice is one row.
    await log.record(row(b, userId, new Date(NOW.getTime() + 2000), '104', 2));
    await log.record(row(b, userId, new Date(NOW.getTime() + 3000), '999', 2));
    const mineRows = await log.list(userId, { since: new Date(0), limit: 10 });
    expect(mineRows.map((r) => [r.seq, r.markPrice])).toEqual([
      [2, '104'],
      [1, '102'],
      [1, '101.5'],
    ]);
    expect(await log.list(userId, { alertId: a, since: new Date(0), limit: 10 })).toHaveLength(1);
    expect(await log.list(userId, { since: new Date(NOW.getTime() + 500), limit: 10 })).toHaveLength(2);
    expect(await log.prune(new Date(NOW.getTime() + 500))).toBeGreaterThanOrEqual(2);
    expect(await log.list(userId, { since: new Date(0), limit: 10 })).toHaveLength(2);
    await sql!`DELETE FROM notify.alert_fires WHERE user_id IN (${userId}, ${other})`;
  });
});

describe.skipIf(!available)('PostgresAlertStore quota', () => {
  const input = (userId: string, targetPrice: string, maxOpen?: number) => ({
    userId,
    marketId: 'BTC-USD',
    direction: 'above' as const,
    targetPrice,
    ...(maxOpen !== undefined ? { maxOpen } : {}),
  });
  it('counts active and paused alerts only, and refuses the create past the cap', async () => {
    const store = new PostgresAlertStore(sql!);
    const userId = fresh();
    const a = await store.create(input(userId, '100', 2));
    const b = await store.create(input(userId, '101', 2));
    await expect(store.create(input(userId, '102', 2))).rejects.toBeInstanceOf(AlertQuotaReachedError);
    expect(await store.countOpen(userId, 'price')).toBe(2);
    await store.setStopped(userId, a.id, true, NOW);
    expect(await store.countOpen(userId, 'price')).toBe(2);
    await store.cancel(userId, b.id);
    expect(await store.countOpen(userId, 'price')).toBe(1);
    await expect(store.create(input(userId, '103', 2))).resolves.toMatchObject({ status: 'active' });
  });
  it('lets two creates racing for the last place through only once, and a create with no cap is unchecked', async () => {
    const store = new PostgresAlertStore(sql!);
    const userId = fresh();
    const settled = await Promise.allSettled(['100', '101', '102', '103'].map((price) => store.create(input(userId, price, 1))));
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(await store.countOpen(userId, 'price')).toBe(1);
    await store.create(input(userId, '104'));
    expect(await store.countOpen(userId, 'price')).toBe(2);
  });
  it('creates a batch as one step: all of it, or none of it past the cap', async () => {
    const store = new PostgresAlertStore(sql!);
    const userId = fresh();
    const batch = (prices: string[]) => prices.map((price) => input(userId, price));
    const made = await store.createMany(batch(['100', '101', '102']), 4);
    expect(made).toHaveLength(3);
    await expect(store.createMany(batch(['103', '104']), 4)).rejects.toMatchObject({ limit: 4, held: 3, wanted: 2 });
    expect(await store.countOpen(userId, 'price')).toBe(3);
    await expect(store.createMany(batch(['105']), 4)).resolves.toHaveLength(1);
  });
  it('lets two batches racing for the last places through only once', async () => {
    const store = new PostgresAlertStore(sql!);
    const userId = fresh();
    const settled = await Promise.allSettled([0, 1, 2].map((n) => store.createMany([input(userId, `${n}1`), input(userId, `${n}2`)], 2)));
    expect(settled.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await store.countOpen(userId, 'price')).toBe(2);
  });
});

describe.skipIf(!available)('PostgresAlertStore frequency and migration 0022', () => {
  it('runs twice, stores the frequency, and counts a repeating trigger once per count', async () => {
    await sql!.unsafe(migration('0022_notify_alert_frequency.sql'));
    await sql!.unsafe(migration('0022_notify_alert_frequency.sql'));
    const store = new PostgresAlertStore(sql!);
    const userId = fresh();
    const make = (frequency?: 'once' | 'every_crossing') =>
      store.create({
        userId,
        marketId: 'BTC-USD',
        direction: 'above',
        targetPrice: '100',
        condition: 'crossing',
        ...(frequency ? { frequency } : {}),
      });
    const once = await make();
    expect(once).toMatchObject({ frequency: 'once', fireCount: 0, lastFiredAt: null });
    const repeating = await make('every_crossing');
    expect(repeating.frequency).toBe('every_crossing');
    const counted = await store.recordRepeat(userId, repeating.id, 0, NOW, 'at_or_above');
    expect(counted).toMatchObject({ status: 'active', fireCount: 1, lastFiredAt: NOW, lastSide: 'at_or_above', firedAt: null });
    // The same count cannot be taken twice, so a retried sweep adds one.
    expect(await store.recordRepeat(userId, repeating.id, 0, NOW, 'below')).toBeNull();
    expect((await store.get(userId, repeating.id))!.fireCount).toBe(1);
    // Not a repeating alert that has stopped.
    await store.setStopped(userId, repeating.id, true, NOW);
    expect(await store.recordRepeat(userId, repeating.id, 1, NOW, null)).toBeNull();
    const replaced = await store.replace(
      userId,
      repeating.id,
      {
        direction: 'above',
        targetPrice: '100',
        condition: 'crossing',
        name: null,
        message: null,
        expiresAt: null,
        extras: [],
        frequency: 'once',
        source: 'mark',
      },
      NOW,
    );
    expect(replaced?.frequency).toBe('once');
  });
  it('copies every earlier trigger as the first fire', async () => {
    const alertId = randomUUID();
    const userId = fresh();
    await sql!`INSERT INTO notify.alert_triggers (alert_id, user_id, market_id, condition, target_price, mark_price, fired_at)
               VALUES (${alertId}, ${userId}, 'BTC-USD', 'crossing', '100', '101', ${NOW})`;
    await sql!.unsafe(migration('0022_notify_alert_frequency.sql'));
    const copied = await sql!`SELECT seq, mark_price FROM notify.alert_fires WHERE alert_id = ${alertId}`;
    expect(copied.map((r) => [r.seq, r.mark_price])).toEqual([[1, '101']]);
    await sql!`DELETE FROM notify.alert_triggers WHERE user_id = ${userId}`;
    await sql!`DELETE FROM notify.alert_fires WHERE user_id = ${userId}`;
  });
});

describe.skipIf(!available)('PostgresAlertStore burst auto-stop and migration 0026', () => {
  it('runs twice, counts triggers in a window, stops past the count with the reason, and clears on resume', async () => {
    await sql!.unsafe(migration('0026_notify_alert_burst.sql'));
    await sql!.unsafe(migration('0026_notify_alert_burst.sql'));
    const store = new PostgresAlertStore(sql!);
    const userId = fresh();
    const rule = { windowMs: 10 * 60_000, max: 2 };
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
    const row = await store.create({
      userId,
      marketId: 'BTC-USD',
      direction: 'above',
      targetPrice: '100',
      condition: 'crossing',
      frequency: 'every_crossing',
    });
    expect(row).toMatchObject({ stopReason: null, burstCount: 0, burstStartedAt: null });
    expect(await store.recordRepeat(userId, row.id, 0, at(1), 'below', rule)).toMatchObject({ status: 'active', burstCount: 1 });
    expect(await store.recordRepeat(userId, row.id, 1, at(2), 'at_or_above', rule)).toMatchObject({ status: 'active', burstCount: 2 });
    const stopped = await store.recordRepeat(userId, row.id, 2, at(3), 'below', rule);
    expect(stopped).toMatchObject({ status: 'stopped', stopReason: 'burst', fireCount: 3, burstCount: 3 });
    // The same count cannot be taken twice, and a stopped alert counts nothing more.
    expect(await store.recordRepeat(userId, row.id, 2, at(3), 'below', rule)).toBeNull();
    const resumed = await store.setStopped(userId, row.id, false, at(4));
    expect(resumed).toMatchObject({ status: 'active', stopReason: null, burstCount: 0, burstStartedAt: null });
    // A window that has run out starts again; with no rule the counters are left alone.
    expect(await store.recordRepeat(userId, row.id, 3, at(40), null, rule)).toMatchObject({ burstCount: 1, status: 'active' });
    expect(await store.recordRepeat(userId, row.id, 4, at(41), null)).toMatchObject({ burstCount: 1, status: 'active' });
  });
});

describe.skipIf(!available)('PostgresAlertStore price source and migration 0038', () => {
  it('runs twice, keeps an existing row on mark, stores and edits the chosen source, and refuses one outside the four', async () => {
    await sql!.unsafe(migration('0038_notify_alert_price_source.sql'));
    await sql!.unsafe(migration('0038_notify_alert_price_source.sql'));
    const store = new PostgresAlertStore(sql!);
    const userId = fresh();
    const legacy = randomUUID();
    await sql!`INSERT INTO notify.price_alerts (id, user_id, market_id, direction, target_price) VALUES (${legacy}, ${userId}, 'BTC-USD', 'above', '100')`;
    expect((await store.get(userId, legacy))!.source).toBe('mark');
    const make = (source?: 'mark' | 'bid' | 'ask' | 'last') =>
      store.create({ userId, marketId: 'BTC-USD', direction: 'above', targetPrice: '100', ...(source ? { source } : {}) });
    expect((await make()).source).toBe('mark');
    const ask = await make('ask');
    expect(ask.source).toBe('ask');
    expect((await store.listActiveByMarket('BTC-USD')).find((r) => r.id === ask.id)!.source).toBe('ask');
    const edited = await store.replace(
      userId,
      ask.id,
      {
        direction: ask.direction,
        targetPrice: ask.targetPrice,
        condition: ask.condition,
        name: null,
        message: null,
        expiresAt: null,
        extras: [],
        frequency: 'once',
        source: 'bid',
      },
      NOW,
    );
    expect(edited!.source).toBe('bid');
    await expect(sql!`UPDATE notify.price_alerts SET source = 'mid' WHERE id = ${ask.id}`).rejects.toThrow(/price_alerts_source_ck/);
  });
});
