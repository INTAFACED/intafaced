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
    expect(await alerts.quota('u1', NOW)).toEqual({ kind: 'price', used: 0, max: null });
  });

  it('refuses the create that would pass the cap, and names the cap', async () => {
    const alerts = rig(2);
    await alerts.create(base, NOW);
    await alerts.create({ ...base, targetPrice: '101' }, NOW);
    await expect(alerts.create({ ...base, targetPrice: '102' }, NOW)).rejects.toMatchObject({ code: 'alert.quota_reached' });
    await expect(alerts.create({ ...base, targetPrice: '102' }, NOW)).rejects.toThrow(/2 open price alerts/);
    expect(await alerts.list('u1')).toHaveLength(2);
    expect(await alerts.quota('u1', NOW)).toEqual({ kind: 'price', used: 2, max: 2 });
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
