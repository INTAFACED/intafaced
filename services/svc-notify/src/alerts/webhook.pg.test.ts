import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { assertTestDatabase } from '@intafaced/db';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresAlertStore } from './store.js';
import { PostgresAlertWebhookStore, runWebhookTick, type AlertWebhookPolicy, type WebhookCause } from './webhook.js';

/**
 * The Postgres record of alert delivery (J-charts-desk-10): an alert keeps the channels and webhook it was saved with, a firing's
 * webhook row is written once, two workers never take the same due row, and every attempt lands on the row once.
 */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? 'postgres://svc_notify:svc_notify@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const migration = (f: string) => readFileSync(join(here, '..', '..', 'drizzle', f), 'utf8');
const MIGRATIONS = [
  '0000_notify_init.sql',
  '0006_notify_price_alerts.sql',
  '0007_notify_alert_kinds.sql',
  '0008_notify_whale_kind.sql',
  '0018_notify_alert_conditions.sql',
  '0019_notify_alert_extra_conditions.sql',
  '0020_notify_alert_stopped.sql',
  '0021_notify_alert_triggers.sql',
  '0022_notify_alert_frequency.sql',
  '0026_notify_alert_burst.sql',
  '20261106031241_notify_alert_price_source.sql',
  '20261107074033_notify_watchlist_alerts.sql',
  '20261114033918_notify_alert_delivery.sql',
];

// Runs against a real database every time: CI provides it. Without one the suite fails, and says so.
const sql = postgres(URL, { max: 3, onnotice: () => undefined });
await assertTestDatabase(sql, 'svc-notify webhook.pg.test');
for (const f of MIGRATIONS) await sql.unsafe(migration(f)).catch(() => undefined);

const mine: string[] = [];
afterAll(async () => {
  for (const userId of mine) {
    await sql`DELETE FROM notify.price_alerts WHERE user_id = ${userId}`;
    await sql`DELETE FROM notify.alert_webhook_deliveries WHERE user_id = ${userId}`;
  }
  await sql.end();
});
const person = () => {
  const id = `u-${randomUUID()}`;
  mine.push(id);
  return id;
};
const POLICY: AlertWebhookPolicy = { ports: [443], retrySeconds: [5], testLoopback: false, timeoutMs: 1000 };
const at = (s: number) => new Date(Date.UTC(2026, 10, 14, 4, 0, s));

describe('notify.price_alerts keeps the delivery choice', () => {
  it('stores and reads back the channels and the webhook; an alert without them reads null', async () => {
    const store = new PostgresAlertStore(sql);
    const userId = person();
    const made = await store.create({
      userId,
      marketId: 'BTC-USDT',
      direction: 'above',
      targetPrice: '100',
      channels: ['email', 'push'],
      webhookUrl: 'https://hooks.example.com/a',
    });
    expect(made).toMatchObject({ channels: ['email', 'push'], webhookUrl: 'https://hooks.example.com/a' });
    expect(await store.get(userId, made.id)).toMatchObject({ channels: ['email', 'push'], webhookUrl: 'https://hooks.example.com/a' });
    const plain = await store.create({ userId, marketId: 'BTC-USDT', direction: 'above', targetPrice: '100' });
    expect(plain).toMatchObject({ channels: null, webhookUrl: null });
    expect((await store.listActiveByMarket('BTC-USDT')).find((a) => a.id === made.id)?.channels).toEqual(['email', 'push']);
  });
});

describe('notify.alert_webhook_deliveries', () => {
  it('a firing is written once; a resend is due after the schedule; a lease keeps a second worker off; each attempt lands once', async () => {
    const store = new PostgresAlertWebhookStore(sql);
    const userId = person();
    const alertId = randomUUID();
    await store.enqueue({ alertId, seq: 1, userId, url: 'https://hooks.example.com/', body: { a: 1 }, at: at(0) });
    await store.enqueue({ alertId, seq: 1, userId, url: 'https://hooks.example.com/', body: { a: 2 }, at: at(0) });

    // Two workers claim at once: only one takes the row.
    const [first, second] = await Promise.all([store.claimDue(at(0), 10, at(60)), store.claimDue(at(0), 10, at(60))]);
    const mineOf = <R extends { alertId: string }>(rows: readonly R[]) => rows.filter((r) => r.alertId === alertId);
    expect(mineOf(first).length + mineOf(second).length).toBe(1);
    expect([...mineOf(first), ...mineOf(second)][0]!.body).toEqual({ a: 1 });

    const attempt = { n: 1, at: at(0).toISOString(), status: 503, cause: 'unavailable' as WebhookCause, durationMs: 4 };
    await store.settle(alertId, 1, attempt, 'pending', at(5));
    // The same attempt written again (a lease that ran out mid-post) is not recorded twice.
    await store.settle(alertId, 1, attempt, 'pending', at(5));
    expect(mineOf(await store.claimDue(at(4), 10, at(64)))).toHaveLength(0);

    const answers: { status: number; cause: WebhookCause }[] = [];
    const sent = await runWebhookTick(
      store,
      async () => {
        answers.push({ status: 200, cause: 'ok' });
        return { status: 200, cause: 'ok' };
      },
      POLICY,
      () => at(5),
    );
    expect(sent).toBeGreaterThanOrEqual(1);
    const [row] = await store.listFor(userId, [{ alertId, seq: 1 }]);
    expect(row).toMatchObject({ status: 'delivered', nextAttemptAt: null });
    expect(row!.attempts.map((a) => [a.n, a.status, a.cause])).toEqual([
      [1, 503, 'unavailable'],
      [2, 200, 'ok'],
    ]);
    expect(await store.listFor('someone-else', [{ alertId, seq: 1 }])).toEqual([]);
  });
});
