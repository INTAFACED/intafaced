/**
 * C-alerts-scan-01b: added level conditions. The alert fires only when its main condition and every added one hold on the
 * same mark. The most conditions an alert may hold is an owner setting: blank refuses, never defaults.
 */

import { describe, expect, it } from 'vitest';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';
import { evaluatePriceAlert } from './evaluate.js';
import { TEST_ALERT_LIMITS } from './test-limits.js';
import { AlertLimitError, AlertService, type AlertLimits } from './service.js';
import { MemoryAlertStore } from './store.js';
import type { AlertExtra, MarkSource, PriceAlert } from './types.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const LIMITS: AlertLimits = {
  maxExpiryDays: 30,
  textMaxLength: 40,
  maxConditions: 3,
  triggerLogDays: null,
  maxActivePrice: 20,
  repeatFrequencies: [],
  burstWindowMinutes: null,
  burstMaxTriggers: null,
};

const watch = (extras: readonly AlertExtra[], patch: Partial<PriceAlert> = {}): PriceAlert => ({
  id: '00000000-0000-4000-8000-000000000001',
  userId: 'u1',
  marketId: 'BTC-USD',
  kind: 'price',
  direction: 'above',
  targetPrice: '100',
  status: 'active',
  firedAt: null,
  createdAt: NOW,
  condition: 'greater_than',
  name: null,
  message: null,
  expiresAt: null,
  lastSide: null,
  extras,
  updatedAt: NOW,
  frequency: 'once',
  fireCount: 0,
  stopReason: null,
  burstStartedAt: null,
  burstCount: 0,
  lastFiredAt: null,
  source: 'mark',
  ...patch,
});
const quote = (price: string) => ({ kind: 'ok' as const, price, at: NOW });
const range: AlertExtra[] = [{ condition: 'less_than', targetPrice: '120' }];

describe('evaluation with added conditions', () => {
  it('fires only when the main condition and every added one hold', () => {
    expect(evaluatePriceAlert(watch(range), quote('110'))).toEqual({ kind: 'fire', markPrice: '110' });
    expect(evaluatePriceAlert(watch(range), quote('120'))).toMatchObject({ kind: 'fire' }); // at the bound counts, as for a single level
    expect(evaluatePriceAlert(watch(range), quote('121'))).toEqual({ kind: 'hold', markPrice: '121' });
    expect(evaluatePriceAlert(watch(range), quote('99'))).toEqual({ kind: 'hold', markPrice: '99' });
  });
  it('holds when any one of several added conditions fails', () => {
    const three: AlertExtra[] = [
      { condition: 'less_than', targetPrice: '120' },
      { condition: 'greater_than', targetPrice: '105' },
    ];
    expect(evaluatePriceAlert(watch(three), quote('110'))).toMatchObject({ kind: 'fire' });
    expect(evaluatePriceAlert(watch(three), quote('102'))).toMatchObject({ kind: 'hold' });
  });
  it('compares exactly, as decimal text', () => {
    const tiny: AlertExtra[] = [{ condition: 'less_than', targetPrice: '100.000000000000000002' }];
    expect(evaluatePriceAlert(watch(tiny), quote('100.000000000000000001'))).toMatchObject({ kind: 'fire' });
    expect(evaluatePriceAlert(watch(tiny), quote('100.000000000000000003'))).toMatchObject({ kind: 'hold' });
  });
  it('a crossing main condition still needs a real crossing, and the added levels must hold when it happens', () => {
    const w = (lastSide: PriceAlert['lastSide']) => watch(range, { condition: 'crossing_up', lastSide });
    expect(evaluatePriceAlert(w('below'), quote('110'))).toMatchObject({ kind: 'fire' });
    // Crossed up, but past the added upper bound: nothing fires, and the new side is remembered so it is not seen twice.
    expect(evaluatePriceAlert(w('below'), quote('130'))).toEqual({ kind: 'hold', markPrice: '130', side: 'at_or_above' });
    expect(evaluatePriceAlert(w('at_or_above'), quote('110'))).toMatchObject({ kind: 'hold' });
  });
  it('an alert with no added conditions behaves as before', () => {
    expect(evaluatePriceAlert(watch([]), quote('100'))).toEqual({ kind: 'fire', markPrice: '100' });
    expect(evaluatePriceAlert(watch([]), quote('99'))).toEqual({ kind: 'hold', markPrice: '99' });
  });
});

function rig(limits: AlertLimits = LIMITS) {
  const marks: MarkSource = { kind: 'live', quote: async (_m, at) => ({ kind: 'ok', price: '110', at: at ?? new Date() }) };
  const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
  return new AlertService(new MemoryAlertStore(), marks, notify, undefined, limits);
}
const base = { userId: 'u1', marketId: 'BTC-USD', direction: 'above' as const, targetPrice: '100' };

describe('creating an alert with added conditions', () => {
  it('stores the added conditions and returns them', async () => {
    const row = await rig().create({ ...base, extras: [{ condition: 'less_than', targetPrice: ' 120 ' }] }, NOW);
    expect(row.extras).toEqual([{ condition: 'less_than', targetPrice: '120' }]);
  });
  it('refuses with a typed code when the owner has not set the limit, and stores nothing', async () => {
    const alerts = rig(TEST_ALERT_LIMITS);
    await expect(alerts.create({ ...base, extras: range }, NOW)).rejects.toMatchObject({ code: 'notify.alert_conditions_limit_unset' });
    expect(await alerts.list('u1')).toHaveLength(0);
  });
  it('an alert with no added conditions needs no limit', async () => {
    expect((await rig(TEST_ALERT_LIMITS).create(base, NOW)).extras).toEqual([]);
  });
  it('counts the main condition toward the limit', async () => {
    const two: AlertExtra[] = [
      { condition: 'less_than', targetPrice: '120' },
      { condition: 'greater_than', targetPrice: '101' },
    ];
    await expect(rig().create({ ...base, extras: two }, NOW)).resolves.toBeTruthy(); // 1 + 2 = 3 = limit
    const three: AlertExtra[] = [...two, { condition: 'less_than', targetPrice: '119' }];
    await expect(rig().create({ ...base, extras: three }, NOW)).rejects.toBeInstanceOf(AlertLimitError);
    await expect(rig().create({ ...base, extras: three }, NOW)).rejects.toMatchObject({ code: 'alert.too_many_conditions' });
  });
  it('refuses an added condition whose price is not a positive decimal', async () => {
    for (const targetPrice of ['', '0', '-1', '1e3', 'abc']) {
      await expect(rig().create({ ...base, extras: [{ condition: 'less_than', targetPrice }] }, NOW)).rejects.toMatchObject({
        code: 'alert.extra_condition_invalid',
      });
    }
  });
});

describe('the sweep', () => {
  it('fires once when every condition holds, and not while one fails', async () => {
    const prices = ['130', '110'];
    const marks: MarkSource = {
      kind: 'live',
      quote: async (_m, at) => ({ kind: 'ok', price: prices.shift() ?? '110', at: at ?? new Date() }),
    };
    const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
    const alerts = new AlertService(new MemoryAlertStore(), marks, notify, undefined, LIMITS);
    const row = await alerts.create({ ...base, extras: range }, NOW);
    const first = await alerts.evaluateAlert('u1', row.id, NOW);
    expect(first.outcome.kind).toBe('hold');
    const second = await alerts.evaluateAlert('u1', row.id, NOW);
    expect(second.outcome.kind).toBe('fire');
  });
});
