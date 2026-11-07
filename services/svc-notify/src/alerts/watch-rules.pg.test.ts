import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { afterAll, describe, expect, it } from 'vitest';
import { AlertQuotaReachedError, PostgresAlertStore } from './store.js';
import { PostgresWatchRuleStore } from './watch-rules.js';

/** The Postgres engine of watchlist alerts (J-charts-desk-09 #7): the rule and its alerts written together, or not at all. */

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
  '0022_notify_alert_frequency.sql',
  '0026_notify_alert_burst.sql',
  '20261106031241_notify_alert_price_source.sql',
  '20261107074033_notify_watchlist_alerts.sql',
];

const available = await postgresAvailable(URL);
const sql = available ? postgres(URL, { max: 3, onnotice: () => undefined }) : null;
if (available && sql) {
  await assertTestDatabase(sql, 'svc-notify watch-rules.pg.test');
  for (const f of MIGRATIONS) await sql.unsafe(migration(f)).catch(() => undefined);
}

const mine: string[] = [];
afterAll(async () => {
  if (sql) {
    for (const userId of mine) {
      await sql`DELETE FROM notify.price_alerts WHERE user_id = ${userId}`;
      await sql`DELETE FROM notify.watchlist_alerts WHERE user_id = ${userId}`;
    }
    await sql.end();
  }
});

const NOW = new Date('2026-11-07T08:00:00Z');
const person = () => {
  const id = `u-${randomUUID()}`;
  mine.push(id);
  return id;
};
const input = (userId: string, marketId: string) => ({
  userId,
  marketId,
  kind: 'price' as const,
  direction: 'above' as const,
  condition: 'greater_than' as const,
  targetPrice: '100000',
});
const rule = (userId: string, markets: string[]) => ({
  userId,
  listId: 'majors',
  listName: 'TEST majors',
  condition: 'greater_than' as const,
  direction: 'above' as const,
  targetPrice: '100000',
  markets,
});

describe.skipIf(!available)('PostgresWatchRuleStore', () => {
  const rules = () => new PostgresWatchRuleStore(sql!);
  const alerts = () => new PostgresAlertStore(sql!);

  it('stores the rule with one alert per market, and reads it back', async () => {
    const u = person();
    const made = await rules().create(rule(u, ['m-btc', 'm-eth']), [input(u, 'm-btc'), input(u, 'm-eth')], 20, NOW);
    expect(made.alerts.map((a) => a.marketId)).toEqual(['m-btc', 'm-eth']);
    expect(made.rule).toMatchObject({ userId: u, listId: 'majors', markets: ['m-btc', 'm-eth'], status: 'active', lastSyncCode: null });
    expect((await rules().list(u)).map((r) => r.id)).toEqual([made.rule.id]);
    expect((await rules().active()).some((r) => r.id === made.rule.id)).toBe(true);
    expect(await alerts().countOpen(u, 'price')).toBe(2);
  });

  it('stores nothing, rule or alert, when the quota refuses', async () => {
    const u = person();
    await expect(rules().create(rule(u, ['m-btc', 'm-eth']), [input(u, 'm-btc'), input(u, 'm-eth')], 1, NOW)).rejects.toBeInstanceOf(
      AlertQuotaReachedError,
    );
    expect(await rules().list(u)).toEqual([]);
    expect(await alerts().countOpen(u, 'price')).toBe(0);
  });

  it('adds a market and counts it covered together, once, however many sweeps race', async () => {
    const u = person();
    const made = await rules().create(rule(u, ['m-btc']), [input(u, 'm-btc')], 20, NOW);
    const added = await Promise.all([
      rules().addMarkets(made.rule, [input(u, 'm-eth')], 20, NOW),
      rules().addMarkets(made.rule, [input(u, 'm-eth')], 20, NOW),
    ]);
    expect(added.filter((rows) => rows !== null)).toHaveLength(1);
    expect(await alerts().countOpen(u, 'price')).toBe(2);
    expect((await rules().list(u))[0]!.markets).toEqual(['m-btc', 'm-eth']);
  });

  it('adds nothing to a stopped rule, and an addition past the quota leaves the rule as it was', async () => {
    const u = person();
    const made = await rules().create(rule(u, ['m-btc']), [input(u, 'm-btc')], 20, NOW);
    await expect(rules().addMarkets(made.rule, [input(u, 'm-eth'), input(u, 'm-ifc')], 2, NOW)).rejects.toBeInstanceOf(
      AlertQuotaReachedError,
    );
    expect((await rules().list(u))[0]!.markets).toEqual(['m-btc']);
    expect(await alerts().countOpen(u, 'price')).toBe(1);
    expect(await rules().stop(u, made.rule.id, NOW)).toMatchObject({ status: 'stopped' });
    expect(await rules().addMarkets(made.rule, [input(u, 'm-eth')], 20, NOW)).toBeNull();
    expect(await alerts().countOpen(u, 'price')).toBe(1);
    expect(await rules().stop(person(), made.rule.id, NOW)).toBeNull();
  });

  it('records why a sweep added nothing, and clears it', async () => {
    const u = person();
    const made = await rules().create(rule(u, ['m-btc']), [input(u, 'm-btc')], 20, NOW);
    await rules().recordSync(made.rule.id, NOW, 'identity.watchlists_unavailable');
    expect((await rules().list(u))[0]!.lastSyncCode).toBe('identity.watchlists_unavailable');
    await rules().recordSync(made.rule.id, NOW, null);
    expect((await rules().list(u))[0]!.lastSyncCode).toBeNull();
  });
});
