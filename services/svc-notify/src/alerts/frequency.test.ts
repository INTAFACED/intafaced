/**
 * C-alerts-scan-01c: trigger frequency. An alert is one-shot unless the person chose `every_crossing` and the owner allows it.
 * A repeating alert stays active, triggers on each real crossing, and a retried sweep counts the same crossing once. A blank
 * owner list refuses a repeating alert; a level condition cannot repeat.
 */

import { describe, expect, it } from 'vitest';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';
import { AlertLimitError, AlertService, type AlertLimits } from './service.js';
import { MemoryAlertStore } from './store.js';
import { MemoryAlertTriggerLog } from './trigger-log.js';
import type { MarkSource } from './types.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const LIMITS: AlertLimits = {
  maxExpiryDays: 30,
  textMaxLength: 40,
  maxConditions: 3,
  triggerLogDays: 7,
  maxActivePrice: 20,
  repeatFrequencies: ['every_crossing'],
};
const base = { userId: 'u1', marketId: 'BTC-USD', direction: 'above' as const, targetPrice: '100', condition: 'crossing' as const };

function rig(limits: AlertLimits = LIMITS) {
  let price = '90';
  const marks: MarkSource = { kind: 'live', quote: async (_m, at) => ({ kind: 'ok', price, at: at ?? new Date() }) };
  const notifyStore = new MemoryNotifyStore();
  const notify = new NotifyService(notifyStore, { fanoutEnabled: true });
  const log = new MemoryAlertTriggerLog();
  const store = new MemoryAlertStore();
  return {
    alerts: new AlertService(store, marks, notify, undefined, limits, log),
    store,
    notifyStore,
    mark: (next: string) => {
      price = next;
    },
  };
}

describe('repeating alerts', () => {
  it('triggers on each crossing, stays active, and counts the triggers', async () => {
    const { alerts, mark } = rig();
    const row = await alerts.create({ ...base, frequency: 'every_crossing' }, NOW);
    await alerts.evaluateDueAlerts(NOW); // first sight: remembers the side, fires nothing
    mark('110');
    expect((await alerts.evaluateDueAlerts(NOW)).fired).toBe(1);
    mark('90');
    expect((await alerts.evaluateDueAlerts(NOW)).fired).toBe(1);
    mark('110');
    expect((await alerts.evaluateDueAlerts(NOW)).fired).toBe(1);
    const now = await alerts.get('u1', row.id);
    expect(now).toMatchObject({ status: 'active', fireCount: 3, firedAt: null, frequency: 'every_crossing' });
    const { triggers } = await alerts.triggers('u1', { alertId: row.id, limit: 10 }, NOW);
    expect(triggers.map((t) => [t.seq, t.markPrice]).sort()).toEqual([
      [1, '110'],
      [2, '90'],
      [3, '110'],
    ]);
  });

  it('does not fire again while the mark stays on the same side', async () => {
    const { alerts, mark } = rig();
    await alerts.create({ ...base, frequency: 'every_crossing' }, NOW);
    await alerts.evaluateDueAlerts(NOW);
    mark('110');
    expect((await alerts.evaluateDueAlerts(NOW)).fired).toBe(1);
    mark('120');
    expect((await alerts.evaluateDueAlerts(NOW)).fired).toBe(0);
    expect((await alerts.evaluateDueAlerts(NOW)).fired).toBe(0);
  });

  it('each crossing is its own inbox row, even at the same mark', async () => {
    const { alerts, notifyStore, mark } = rig();
    await alerts.create({ ...base, frequency: 'every_crossing' }, NOW);
    await alerts.evaluateDueAlerts(NOW);
    for (const price of ['110', '90', '110', '90']) {
      mark(price);
      await alerts.evaluateDueAlerts(NOW);
    }
    const rows = (await notifyStore.list({ userId: 'u1', limit: 50 })).items;
    expect(rows.filter((r) => r.kind === 'alert.price.crossed')).toHaveLength(4);
  });

  it('a one-shot alert still triggers once and is done', async () => {
    const { alerts, mark } = rig();
    const row = await alerts.create({ ...base, condition: 'greater_than' }, NOW);
    mark('110');
    expect((await alerts.evaluateDueAlerts(NOW)).fired).toBe(1);
    expect((await alerts.evaluateDueAlerts(NOW)).fired).toBe(0);
    expect(await alerts.get('u1', row.id)).toMatchObject({ status: 'fired', frequency: 'once', fireCount: 0 });
  });

  it('a retried crossing is counted once: the same count cannot be recorded twice', async () => {
    const { alerts, store, mark } = rig();
    const row = await alerts.create({ ...base, frequency: 'every_crossing' }, NOW);
    await alerts.evaluateDueAlerts(NOW);
    mark('110');
    await alerts.evaluateDueAlerts(NOW);
    expect(await store.recordRepeat('u1', row.id, 0, NOW, 'at_or_above')).toBeNull();
    expect((await alerts.get('u1', row.id))!.fireCount).toBe(1);
  });

  it('a crash after the inbox row and before the count sends nothing new on the retry', async () => {
    const { alerts, store, notifyStore, mark } = rig();
    const row = await alerts.create({ ...base, frequency: 'every_crossing' }, NOW);
    await alerts.evaluateDueAlerts(NOW);
    mark('110');
    const real = store.recordRepeat.bind(store);
    let crash = true;
    store.recordRepeat = async (...args) => {
      if (crash) {
        crash = false;
        throw new Error('crash before the count');
      }
      return real(...args);
    };
    await expect(alerts.evaluateDueAlerts(NOW)).rejects.toThrow('crash before the count');
    expect((await alerts.get('u1', row.id))!.fireCount).toBe(0);
    await alerts.evaluateDueAlerts(NOW);
    // The retry uses the same trigger number, so the inbox keeps the one row it already had.
    const rows = (await notifyStore.list({ userId: 'u1', limit: 50 })).items;
    expect(rows.filter((r) => r.kind === 'alert.price.crossed')).toHaveLength(1);
    expect(rows[0]!.sourceIdempotencyKey).toBe(`${row.id}:n1`);
  });
});

describe('the frequency rules', () => {
  it('refuses a repeating alert while the owner list is blank, and stores nothing', async () => {
    const { alerts } = rig({ ...LIMITS, repeatFrequencies: [] });
    await expect(alerts.create({ ...base, frequency: 'every_crossing' }, NOW)).rejects.toMatchObject({
      code: 'notify.alert_frequency_unset',
    });
    expect(await alerts.list('u1')).toHaveLength(0);
  });
  it('a blank list leaves one-shot alerts unaffected', async () => {
    const { alerts } = rig({ ...LIMITS, repeatFrequencies: [] });
    expect(await alerts.create({ ...base, frequency: 'once' }, NOW)).toMatchObject({ frequency: 'once' });
  });
  it('only a crossing can repeat', async () => {
    const { alerts } = rig();
    await expect(alerts.create({ ...base, condition: 'greater_than', frequency: 'every_crossing' }, NOW)).rejects.toMatchObject({
      code: 'alert.frequency_needs_crossing',
    });
    await expect(alerts.create({ ...base, condition: undefined, frequency: 'every_crossing' }, NOW)).rejects.toBeInstanceOf(
      AlertLimitError,
    );
  });
  it('a watchlist batch is checked the same way, all or none', async () => {
    const { alerts } = rig({ ...LIMITS, repeatFrequencies: [] });
    await expect(
      alerts.createMany(
        { userId: 'u1', marketIds: ['A', 'B'], direction: 'above', targetPrice: '1', condition: 'crossing', frequency: 'every_crossing' },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'notify.alert_frequency_unset' });
    expect(await alerts.list('u1')).toHaveLength(0);
  });
  it('an edit cannot turn a repeating alert into a level, and can change its frequency back to once', async () => {
    const { alerts } = rig();
    const row = await alerts.create({ ...base, frequency: 'every_crossing' }, NOW);
    await expect(alerts.edit('u1', row.id, { condition: 'greater_than' }, NOW)).rejects.toMatchObject({
      code: 'alert.frequency_needs_crossing',
    });
    expect(await alerts.edit('u1', row.id, { name: null }, NOW)).toMatchObject({ frequency: 'every_crossing' });
    expect(await alerts.edit('u1', row.id, { frequency: 'once', condition: 'greater_than' }, NOW)).toMatchObject({ frequency: 'once' });
  });
  it('an edit of a repeating alert still works if the owner list is later blanked', async () => {
    const rigged = rig();
    const row = await rigged.alerts.create({ ...base, frequency: 'every_crossing' }, NOW);
    const blank = new AlertService(
      rigged.store,
      { kind: 'live', quote: async (_m, at) => ({ kind: 'ok', price: '90', at: at ?? NOW }) },
      new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true }),
      undefined,
      { ...LIMITS, repeatFrequencies: [] },
    );
    expect(await blank.edit('u1', row.id, { targetPrice: '105' }, NOW)).toMatchObject({ targetPrice: '105', frequency: 'every_crossing' });
  });
});
