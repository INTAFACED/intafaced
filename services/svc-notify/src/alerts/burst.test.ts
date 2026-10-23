/**
 * C-alerts-scan-03b: burst auto-stop. A repeating alert that triggers more than the owner's count inside the owner's window is
 * stopped with the reason `burst`, after that trigger has been delivered. Either owner value blank leaves the rule off.
 */

import { describe, expect, it } from 'vitest';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';
import { AlertService, type AlertLimits } from './service.js';
import { MemoryAlertStore, nextBurst } from './store.js';
import type { MarkSource } from './types.js';

const T0 = new Date('2026-10-20T12:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const LIMITS: AlertLimits = {
  maxExpiryDays: 30,
  textMaxLength: 40,
  maxConditions: 3,
  triggerLogDays: 7,
  maxActivePrice: 20,
  repeatFrequencies: ['every_crossing'],
  burstWindowMinutes: 10,
  burstMaxTriggers: 3,
};
const base = { userId: 'u1', marketId: 'BTC-USD', direction: 'above' as const, targetPrice: '100', condition: 'crossing' as const };

function rig(limits: AlertLimits = LIMITS) {
  let price = '90';
  const marks: MarkSource = { kind: 'live', quote: async (_m, now) => ({ kind: 'ok', price, at: now ?? new Date() }) };
  const notifyStore = new MemoryNotifyStore();
  const alerts = new AlertService(
    new MemoryAlertStore(),
    marks,
    new NotifyService(notifyStore, { fanoutEnabled: true }),
    undefined,
    limits,
  );
  const set = (next: string) => {
    price = next;
  };
  /** One crossing: up if the mark is below, down if above. */
  const cross = async (now: Date) => {
    set(price === '90' ? '110' : '90');
    return alerts.evaluateDueAlerts(now);
  };
  return { alerts, notifyStore, cross };
}

describe('burst auto-stop', () => {
  it('delivers the trigger that passes the count, then stops the alert with the reason', async () => {
    const { alerts, notifyStore, cross } = rig();
    const row = await alerts.create({ ...base, frequency: 'every_crossing' }, T0);
    await alerts.evaluateDueAlerts(T0); // first sight
    for (const minute of [1, 2, 3]) expect((await cross(at(minute))).fired).toBe(1);
    expect(await alerts.get('u1', row.id)).toMatchObject({ status: 'active', stopReason: null, fireCount: 3 });
    expect((await cross(at(4))).fired).toBe(1); // the fourth in ten minutes
    expect(await alerts.get('u1', row.id)).toMatchObject({ status: 'stopped', stopReason: 'burst', fireCount: 4 });
    const inbox = (await notifyStore.list({ userId: 'u1', limit: 50, unreadOnly: false })).items;
    expect(inbox.filter((r) => r.kind === 'alert.price.crossed')).toHaveLength(4);
    // A stopped alert is not evaluated, so a fifth crossing sends nothing.
    expect((await cross(at(5))).fired).toBe(0);
  });
  it('starts a new window once the old one has run out', async () => {
    const { alerts, cross } = rig();
    const row = await alerts.create({ ...base, frequency: 'every_crossing' }, T0);
    await alerts.evaluateDueAlerts(T0);
    for (const minute of [1, 2, 3]) await cross(at(minute));
    await cross(at(30)); // outside the ten minutes: counts as the first of a new window
    await cross(at(31));
    await cross(at(32));
    expect(await alerts.get('u1', row.id)).toMatchObject({ status: 'active', stopReason: null, fireCount: 6 });
  });
  it('resuming clears the reason and the window', async () => {
    const { alerts, cross } = rig();
    const row = await alerts.create({ ...base, frequency: 'every_crossing' }, T0);
    await alerts.evaluateDueAlerts(T0);
    for (const minute of [1, 2, 3, 4]) await cross(at(minute));
    expect((await alerts.get('u1', row.id))!.status).toBe('stopped');
    expect(await alerts.setActive('u1', row.id, true, at(5))).toMatchObject({ status: 'active', stopReason: null, burstCount: 0 });
  });
  it('a pause by the person has no reason', async () => {
    const { alerts } = rig();
    const row = await alerts.create({ ...base, frequency: 'every_crossing' }, T0);
    expect(await alerts.setActive('u1', row.id, false, at(1))).toMatchObject({ status: 'stopped', stopReason: null });
  });
  it.each([
    ['window', { burstWindowMinutes: null }],
    ['count', { burstMaxTriggers: null }],
  ])('leaves the rule off while the %s is blank, and says so', async (_label, patch) => {
    const { alerts, cross } = rig({ ...LIMITS, ...patch });
    const row = await alerts.create({ ...base, frequency: 'every_crossing' }, T0);
    await alerts.evaluateDueAlerts(T0);
    for (const minute of [1, 2, 3, 4, 5, 6]) await cross(at(minute));
    expect(await alerts.get('u1', row.id)).toMatchObject({ status: 'active', stopReason: null, fireCount: 6 });
    expect((await alerts.quota('u1', at(7))).burst).toBeNull();
  });
  it('reports the rule beside the quota when it is armed', async () => {
    const { alerts } = rig();
    expect((await alerts.quota('u1', T0)).burst).toEqual({ windowMinutes: 10, maxTriggers: 3 });
  });
  it('a one-shot alert is not counted', async () => {
    const { alerts, cross } = rig();
    const row = await alerts.create({ ...base, condition: 'greater_than' }, T0);
    await cross(at(1));
    expect(await alerts.get('u1', row.id)).toMatchObject({ status: 'fired', stopReason: null, burstCount: 0 });
  });
});

describe('the window arithmetic', () => {
  const rule = { windowMs: 10 * 60_000, max: 3 };
  it('counts inside the window, restarts after it, and stops only past the count', () => {
    const first = nextBurst({ burstStartedAt: null, burstCount: 0 }, at(0), rule);
    expect(first).toMatchObject({ burstCount: 1, stop: false });
    const third = nextBurst({ burstStartedAt: at(0), burstCount: 2 }, at(9), rule);
    expect(third).toMatchObject({ burstCount: 3, stop: false });
    expect(nextBurst({ burstStartedAt: at(0), burstCount: 3 }, at(10), rule)).toMatchObject({ burstCount: 4, stop: true });
    expect(nextBurst({ burstStartedAt: at(0), burstCount: 3 }, at(11), rule)).toMatchObject({ burstCount: 1, stop: false });
  });
});
