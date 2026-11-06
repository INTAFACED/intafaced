/**
 * C-alerts-scan-01: conditions, expiry, name and message.
 *
 * A crossing watch fires only on a change of side seen between two sweeps; a level watch fires whenever the mark is past the
 * target. An expiry and a text length are owner settings: blank refuses, never defaults.
 */

import { describe, expect, it } from 'vitest';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';
import { evaluatePriceAlert } from './evaluate.js';
import { TEST_ALERT_LIMITS } from './test-limits.js';
import { AlertLimitError, AlertService, renderAlertMessage, type AlertLimits } from './service.js';
import { MemoryAlertStore } from './store.js';
import type { AlertCondition, MarkSource, PriceAlert } from './types.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const LIMITS: AlertLimits = {
  maxExpiryDays: 30,
  textMaxLength: 40,
  maxConditions: null,
  triggerLogDays: null,
  maxActivePrice: 20,
  repeatFrequencies: [],
  burstWindowMinutes: null,
  burstMaxTriggers: null,
};

function rig(limits: AlertLimits = LIMITS) {
  let price = '90';
  const marks: MarkSource = { kind: 'live', quote: async (_market, at) => ({ kind: 'ok', price, at: at ?? new Date() }) };
  const notifyStore = new MemoryNotifyStore();
  const notify = new NotifyService(notifyStore, { fanoutEnabled: true });
  const alerts = new AlertService(new MemoryAlertStore(), marks, notify, undefined, limits);
  return {
    alerts,
    notifyStore,
    setMark: (p: string) => {
      price = p;
    },
  };
}

const watch = (condition: AlertCondition, lastSide: PriceAlert['lastSide'] = null): PriceAlert => ({
  id: '00000000-0000-4000-8000-000000000001',
  userId: 'u1',
  marketId: 'BTC-USD',
  kind: 'price',
  direction: condition === 'less_than' || condition === 'crossing_down' ? 'below' : 'above',
  targetPrice: '100',
  status: 'active',
  firedAt: null,
  createdAt: NOW,
  condition,
  name: null,
  message: null,
  expiresAt: null,
  lastSide,
  extras: [],
  updatedAt: NOW,
  frequency: 'once' as const,
  fireCount: 0,
  stopReason: null,
  burstStartedAt: null,
  burstCount: 0,
  lastFiredAt: null,
  source: 'mark' as const,
});
const quote = (price: string) => ({ kind: 'ok' as const, price, at: NOW });

describe('crossing evaluation', () => {
  it('a watch with no earlier observation fires nothing and remembers the side', () => {
    expect(evaluatePriceAlert(watch('crossing_up'), quote('105'))).toEqual({ kind: 'hold', markPrice: '105', side: 'at_or_above' });
    expect(evaluatePriceAlert(watch('crossing_up'), quote('95'))).toEqual({ kind: 'hold', markPrice: '95', side: 'below' });
  });
  it('crossing up fires only from below to at-or-above', () => {
    expect(evaluatePriceAlert(watch('crossing_up', 'below'), quote('100'))).toMatchObject({ kind: 'fire', side: 'at_or_above' });
    expect(evaluatePriceAlert(watch('crossing_up', 'at_or_above'), quote('95'))).toMatchObject({ kind: 'hold', side: 'below' });
    expect(evaluatePriceAlert(watch('crossing_up', 'below'), quote('99.99'))).toMatchObject({ kind: 'hold' });
  });
  it('crossing down fires only from at-or-above to strictly below', () => {
    expect(evaluatePriceAlert(watch('crossing_down', 'at_or_above'), quote('99.99'))).toMatchObject({ kind: 'fire', side: 'below' });
    expect(evaluatePriceAlert(watch('crossing_down', 'at_or_above'), quote('100'))).toMatchObject({ kind: 'hold' });
    expect(evaluatePriceAlert(watch('crossing_down', 'below'), quote('105'))).toMatchObject({ kind: 'hold', side: 'at_or_above' });
  });
  it('plain crossing fires either way', () => {
    expect(evaluatePriceAlert(watch('crossing', 'below'), quote('101'))).toMatchObject({ kind: 'fire' });
    expect(evaluatePriceAlert(watch('crossing', 'at_or_above'), quote('99'))).toMatchObject({ kind: 'fire' });
    expect(evaluatePriceAlert(watch('crossing', 'below'), quote('99'))).toMatchObject({ kind: 'hold' });
  });
  it('a level condition is unchanged: fires whenever past the target, remembers no side', () => {
    expect(evaluatePriceAlert(watch('greater_than'), quote('100'))).toEqual({ kind: 'fire', markPrice: '100' });
    expect(evaluatePriceAlert(watch('less_than'), quote('101'))).toEqual({ kind: 'hold', markPrice: '101' });
  });
});

describe('crossing through the sweep', () => {
  it('created while already above, crossing up waits for a real crossing and fires once', async () => {
    const { alerts, setMark, notifyStore } = rig();
    setMark('105');
    await alerts.create({ userId: 'u1', marketId: 'BTC-USD', direction: 'above', targetPrice: '100', condition: 'crossing_up' }, NOW);
    await alerts.evaluateDueAlerts(NOW);
    expect(await notifyStore.unreadCount('u1')).toBe(0);
    setMark('110');
    await alerts.evaluateDueAlerts(NOW);
    expect(await notifyStore.unreadCount('u1')).toBe(0);
    setMark('95');
    await alerts.evaluateDueAlerts(NOW);
    setMark('101');
    const report = await alerts.evaluateDueAlerts(NOW);
    expect(report.fired).toBe(1);
    expect((await alerts.list('u1'))[0]).toMatchObject({ status: 'fired', condition: 'crossing_up' });
    expect(await notifyStore.unreadCount('u1')).toBe(1);
  });

  it('a crossing the fan-out kill swallowed is not lost: the side is only remembered on a hold', async () => {
    const marks: MarkSource = { kind: 'live', quote: async (_market, at) => ({ kind: 'ok', price, at: at ?? new Date() }) };
    let price = '95';
    const store = new MemoryAlertStore();
    const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: false });
    const alerts = new AlertService(store, marks, notify, undefined, LIMITS);
    const row = await alerts.create({
      userId: 'u1',
      marketId: 'BTC-USD',
      direction: 'above',
      targetPrice: '100',
      condition: 'crossing_up',
    });
    await alerts.evaluateDueAlerts(NOW);
    price = '101';
    await alerts.evaluateDueAlerts(NOW);
    // Nothing was written, so the watch is still active and still remembers the side below: the next pass can fire it.
    expect(await store.get('u1', row.id)).toMatchObject({ status: 'active', lastSide: 'below' });
  });

  it('a condition and its direction are stored together', async () => {
    const { alerts } = rig();
    const down = await alerts.create({
      userId: 'u1',
      marketId: 'BTC-USD',
      direction: 'above',
      targetPrice: '100',
      condition: 'crossing_down',
    });
    expect(down).toMatchObject({ condition: 'crossing_down', direction: 'below' });
    const legacy = await alerts.create({ userId: 'u1', marketId: 'BTC-USD', direction: 'below', targetPrice: '100' });
    expect(legacy).toMatchObject({ condition: 'less_than', direction: 'below' });
  });
});

describe('expiry', () => {
  it('an alert past its expiry is retired by the next sweep and never fires', async () => {
    const { alerts, setMark, notifyStore } = rig();
    setMark('50');
    await alerts.create(
      { userId: 'u1', marketId: 'BTC-USD', direction: 'below', targetPrice: '100', expiresAt: new Date(NOW.getTime() + 3_600_000) },
      NOW,
    );
    const later = new Date(NOW.getTime() + 2 * 3_600_000);
    const report = await alerts.evaluateDueAlerts(later);
    expect(report.fired).toBe(0);
    expect((await alerts.list('u1'))[0]!.status).toBe('expired');
    expect(await notifyStore.unreadCount('u1')).toBe(0);
  });
  it('an open-ended alert never expires', async () => {
    const { alerts, setMark } = rig();
    setMark('120');
    await alerts.create({ userId: 'u1', marketId: 'BTC-USD', direction: 'below', targetPrice: '100' });
    await alerts.evaluateDueAlerts(new Date(NOW.getTime() + 400 * 86_400_000));
    expect((await alerts.list('u1'))[0]!.status).toBe('active');
  });
  it('the public evaluate door expires a due alert instead of firing it', async () => {
    const { alerts, setMark } = rig();
    setMark('50');
    const row = await alerts.create(
      { userId: 'u1', marketId: 'BTC-USD', direction: 'below', targetPrice: '100', expiresAt: new Date(NOW.getTime() + 1000) },
      NOW,
    );
    const report = await alerts.evaluateAlert('u1', row.id, new Date(NOW.getTime() + 5000));
    expect(report.outcome).toMatchObject({ kind: 'refuse', code: 'alert.not_active' });
    expect(report.alert?.status).toBe('expired');
  });
  it('an expired alert cannot be cancelled back to life', async () => {
    const { alerts } = rig();
    const row = await alerts.create(
      { userId: 'u1', marketId: 'BTC-USD', direction: 'below', targetPrice: '100', expiresAt: new Date(NOW.getTime() + 1000) },
      NOW,
    );
    await alerts.evaluateDueAlerts(new Date(NOW.getTime() + 5000));
    expect((await alerts.cancel('u1', row.id))?.status).toBe('expired');
  });
});

describe('owner limits refuse instead of defaulting', () => {
  const create = (alerts: AlertService, extra: Record<string, unknown>) =>
    alerts.create({ userId: 'u1', marketId: 'BTC-USD', direction: 'above', targetPrice: '100', ...extra }, NOW);
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(AlertLimitError);
      return (err as AlertLimitError).code;
    }
    return 'no refusal';
  };

  it('a blank maximum refuses an expiry, and a blank length refuses a name or message', async () => {
    const { alerts } = rig(TEST_ALERT_LIMITS);
    expect(await code(create(alerts, { expiresAt: new Date(NOW.getTime() + 1000) }))).toBe('notify.alert_expiry_max_unset');
    expect(await code(create(alerts, { name: 'x' }))).toBe('notify.alert_text_limit_unset');
    expect(await code(create(alerts, { message: 'x' }))).toBe('notify.alert_text_limit_unset');
    // An alert that asks for neither is not affected by the blank settings.
    expect((await create(alerts, {})).status).toBe('active');
    expect(await alerts.list('u1')).toHaveLength(1);
  });

  it('refuses a past expiry, one beyond the maximum, over-long text and an unknown placeholder, storing nothing', async () => {
    const { alerts } = rig();
    expect(await code(create(alerts, { expiresAt: new Date(NOW.getTime() - 1) }))).toBe('alert.expiry_in_past');
    expect(await code(create(alerts, { expiresAt: new Date(NOW.getTime() + 31 * 86_400_000) }))).toBe('alert.expiry_too_far');
    expect(await code(create(alerts, { message: 'x'.repeat(41) }))).toBe('alert.text_too_long');
    expect(await code(create(alerts, { name: 'y'.repeat(41) }))).toBe('alert.text_too_long');
    expect(await code(create(alerts, { message: 'hello {nope}' }))).toBe('alert.message_placeholder_unknown');
    expect(await alerts.list('u1')).toHaveLength(0);
  });

  it('accepts values inside the limits, trimmed', async () => {
    const { alerts } = rig();
    const row = await create(alerts, {
      name: '  Breakout  ',
      message: ' {market} at {price} ',
      expiresAt: new Date(NOW.getTime() + 30 * 86_400_000),
    });
    expect(row).toMatchObject({ name: 'Breakout', message: '{market} at {price}' });
  });
});

describe('message', () => {
  it('fills the placeholders from the alert and the mark that fired it, and leaves other braces alone', () => {
    const row = { ...watch('crossing_up'), marketId: 'BTC-USD' };
    expect(renderAlertMessage('{market} {price} {condition} {time} {other}', row, '101.5', NOW)).toBe(
      'BTC-USD 101.5 crossing up 100 2026-10-20T12:00:00.000Z {other}',
    );
  });

  it('a fired alert writes the person’s name and rendered message into the inbox row', async () => {
    const { alerts, setMark, notifyStore } = rig();
    setMark('101');
    await alerts.create({
      userId: 'u1',
      marketId: 'BTC-USD',
      direction: 'above',
      targetPrice: '100',
      name: 'Breakout',
      message: '{market} hit {price}',
    });
    await alerts.evaluateDueAlerts(NOW);
    const inbox = await notifyStore.list({ userId: 'u1', limit: 10, unreadOnly: false });
    expect(inbox.items[0]).toMatchObject({
      titleKey: 'notify.alert.price.crossed.named.title',
      bodyKey: 'notify.alert.price.crossed.message.body',
    });
    expect(inbox.items[0]!.params).toMatchObject({ name: 'Breakout', message: 'BTC-USD hit 101' });
  });

  it('an alert with neither keeps the stock copy', async () => {
    const { alerts, setMark, notifyStore } = rig();
    setMark('101');
    await alerts.create({ userId: 'u1', marketId: 'BTC-USD', direction: 'above', targetPrice: '100' });
    await alerts.evaluateDueAlerts(NOW);
    const inbox = await notifyStore.list({ userId: 'u1', limit: 10, unreadOnly: false });
    expect(inbox.items[0]).toMatchObject({ titleKey: 'notify.alert.price.crossed.title', bodyKey: 'notify.alert.price.crossed.body' });
  });
});
