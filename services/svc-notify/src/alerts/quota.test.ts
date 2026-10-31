/**
 * C-alerts-scan-03a: how many price alerts a person may hold open. The cap is an owner setting with no default: blank refuses
 * every price alert create. Active and paused alerts use a place; triggered, expired, cancelled and deleted ones do not.
 */

import { describe, expect, it } from 'vitest';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';
import { AlertLimitError, AlertService, NO_ALERT_LIMITS, type AlertLimits } from './service.js';
import { MemoryAlertStore } from './store.js';
import type { MarkSource } from './types.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const base = { userId: 'u1', marketId: 'BTC-USD', direction: 'above' as const, targetPrice: '100' };
const limits = (maxActivePrice: number | null): AlertLimits => ({ ...NO_ALERT_LIMITS, maxExpiryDays: 30, maxActivePrice });

function rig(max: number | null, price = '90') {
  const marks: MarkSource = { kind: 'live', quote: async (_m, at) => ({ kind: 'ok', price, at: at ?? new Date() }) };
  const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
  return new AlertService(new MemoryAlertStore(), marks, notify, undefined, limits(max));
}

describe('price alert quota', () => {
  it('refuses a create while the owner has not set the cap, and stores nothing', async () => {
    const alerts = rig(null);
    await expect(alerts.create(base, NOW)).rejects.toMatchObject({ code: 'notify.alert_quota_unset' });
    await expect(alerts.create(base, NOW)).rejects.toBeInstanceOf(AlertLimitError);
    expect(await alerts.list('u1')).toHaveLength(0);
    expect(await alerts.quota('u1', NOW)).toEqual({ kind: 'price', used: 0, max: null, burst: null, maxConditions: null });
  });

  it('refuses the create that would pass the cap, and names the cap', async () => {
    const alerts = rig(2);
    await alerts.create(base, NOW);
    await alerts.create({ ...base, targetPrice: '101' }, NOW);
    await expect(alerts.create({ ...base, targetPrice: '102' }, NOW)).rejects.toMatchObject({ code: 'alert.quota_reached' });
    await expect(alerts.create({ ...base, targetPrice: '102' }, NOW)).rejects.toThrow(/2 open price alerts/);
    expect(await alerts.list('u1')).toHaveLength(2);
    expect(await alerts.quota('u1', NOW)).toEqual({ kind: 'price', used: 2, max: 2, burst: null, maxConditions: null });
  });

  it('counts each person on their own', async () => {
    const alerts = rig(1);
    await alerts.create(base, NOW);
    await alerts.create({ ...base, userId: 'u2' }, NOW);
    await expect(alerts.create(base, NOW)).rejects.toMatchObject({ code: 'alert.quota_reached' });
  });

  it('counts a paused alert, and frees the place when it is cancelled or deleted', async () => {
    const alerts = rig(1);
    const first = await alerts.create(base, NOW);
    await alerts.setActive('u1', first.id, false);
    await expect(alerts.create(base, NOW)).rejects.toMatchObject({ code: 'alert.quota_reached' });
    await alerts.cancel('u1', first.id);
    const second = await alerts.create(base, NOW);
    await alerts.remove('u1', second.id);
    await alerts.create(base, NOW);
    expect((await alerts.quota('u1', NOW)).used).toBe(1);
  });

  it('frees the place of an alert that triggered or passed its stop time', async () => {
    const alerts = rig(1, '120');
    await alerts.create(base, NOW);
    expect((await alerts.evaluateDueAlerts(NOW)).fired).toBe(1);
    await alerts.create({ ...base, expiresAt: new Date(NOW.getTime() + 60_000) }, NOW);
    await expect(alerts.create(base, NOW)).rejects.toMatchObject({ code: 'alert.quota_reached' });
    const later = new Date(NOW.getTime() + 120_000);
    await expect(alerts.create(base, later)).resolves.toMatchObject({ status: 'active' });
  });

  it('lets two creates racing for the last place through only once', async () => {
    const alerts = rig(1);
    const settled = await Promise.allSettled([alerts.create(base, NOW), alerts.create({ ...base, targetPrice: '101' }, NOW)]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(await alerts.list('u1')).toHaveLength(1);
  });

  it('does not touch an edit, a pause or a resume of an alert already held', async () => {
    const alerts = rig(1);
    const row = await alerts.create(base, NOW);
    await expect(alerts.edit('u1', row.id, { targetPrice: '105' }, NOW)).resolves.toMatchObject({ targetPrice: '105' });
    await alerts.setActive('u1', row.id, false);
    await expect(alerts.setActive('u1', row.id, true)).resolves.toMatchObject({ status: 'active' });
  });
});

describe('watchlist alert (one rule, several markets)', () => {
  const MARKETS = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
  const watch = (marketIds: string[], extra: Record<string, unknown> = {}) => ({
    userId: 'u1',
    marketIds,
    direction: 'above' as const,
    targetPrice: '100',
    ...extra,
  });

  it('creates one alert per market with the same rule, and a market named twice once', async () => {
    const alerts = rig(10);
    const rows = await alerts.createMany(watch([...MARKETS, ' BTC-USD ']), NOW);
    expect(rows.map((r) => r.marketId)).toEqual(MARKETS);
    expect(rows.every((r) => r.targetPrice === '100' && r.status === 'active' && r.kind === 'price')).toBe(true);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
    expect(await alerts.quota('u1', NOW)).toEqual({ kind: 'price', used: 3, max: 10, burst: null, maxConditions: null });
  });

  it('creates none when the batch would pass the cap, and says how many are open and asked for', async () => {
    const alerts = rig(4);
    await alerts.create(base, NOW);
    await alerts.create({ ...base, marketId: 'XRP-USD' }, NOW);
    await expect(alerts.createMany(watch(MARKETS), NOW)).rejects.toMatchObject({ code: 'alert.quota_reached' });
    await expect(alerts.createMany(watch(MARKETS), NOW)).rejects.toThrow(/2 are open and 3 more were asked for/);
    expect(await alerts.list('u1')).toHaveLength(2);
    await expect(alerts.createMany(watch(MARKETS.slice(0, 2)), NOW)).resolves.toHaveLength(2);
  });

  it('refuses while the cap is not set, and for a price that is not real, storing nothing', async () => {
    await expect(rig(null).createMany(watch(MARKETS), NOW)).rejects.toMatchObject({ code: 'notify.alert_quota_unset' });
    const alerts = rig(10);
    await expect(alerts.createMany(watch(MARKETS, { targetPrice: '' }), NOW)).rejects.toThrow();
    await expect(alerts.createMany(watch([]), NOW)).rejects.toMatchObject({ code: 'alert.invalid_market' });
    expect(await alerts.list('u1')).toHaveLength(0);
  });

  it('checks the text, expiry and added conditions as a single create does, once for the whole batch', async () => {
    const alerts = rig(10);
    await expect(alerts.createMany(watch(MARKETS, { name: 'x' }), NOW)).rejects.toMatchObject({ code: 'notify.alert_text_limit_unset' });
    expect(await alerts.list('u1')).toHaveLength(0);
  });

  it('lets two batches racing for the last places through only once', async () => {
    const alerts = rig(3);
    const settled = await Promise.allSettled([alerts.createMany(watch(MARKETS), NOW), alerts.createMany(watch(MARKETS), NOW)]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(await alerts.list('u1')).toHaveLength(3);
  });
});
