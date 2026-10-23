/**
 * C-alerts-scan-02: the alert trigger log. A fire is recorded once with the mark that fired it; a blank retention writes no
 * log and refuses to read it, yet the alert still fires; rows past the retention are pruned by the sweep.
 */

import { describe, expect, it } from 'vitest';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';
import { AlertLimitError, AlertService, type AlertLimits } from './service.js';
import { MemoryAlertStore } from './store.js';
import { MemoryAlertTriggerLog, NOTIFY_ALERT_TRIGGER_LOG_RETENTION_UNSET } from './trigger-log.js';
import type { MarkSource } from './types.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const LIMITS: AlertLimits = {
  maxExpiryDays: 30,
  textMaxLength: 40,
  maxConditions: 3,
  triggerLogDays: 7,
  maxActivePrice: 20,
  repeatFrequencies: [],
  burstWindowMinutes: null,
  burstMaxTriggers: null,
};
const base = { userId: 'u1', marketId: 'BTC-USD', direction: 'above' as const, targetPrice: '100' };

function rig(limits: AlertLimits = LIMITS, price = '120') {
  const marks: MarkSource = { kind: 'live', quote: async (_m, at) => ({ kind: 'ok', price, at: at ?? new Date() }) };
  const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
  const log = new MemoryAlertTriggerLog();
  return { alerts: new AlertService(new MemoryAlertStore(), marks, notify, undefined, limits, log), log };
}

describe('trigger log', () => {
  it('records the fire with the mark and what the alert asked for', async () => {
    const { alerts } = rig();
    const row = await alerts.create(base, NOW);
    const report = await alerts.evaluateDueAlerts(NOW);
    expect(report.fired).toBe(1);
    const { retentionDays, triggers } = await alerts.triggers('u1', { limit: 10 }, NOW);
    expect(retentionDays).toBe(7);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      alertId: row.id,
      marketId: 'BTC-USD',
      condition: 'greater_than',
      targetPrice: '100',
      markPrice: '120',
      firedAt: NOW,
    });
    expect(triggers[0]!.notificationId).not.toBeNull();
  });

  it('keeps one row per alert if recording is repeated', async () => {
    const { alerts, log } = rig();
    const row = await alerts.create(base, NOW);
    await alerts.evaluateDueAlerts(NOW);
    const [first] = await alerts.triggers('u1', { limit: 10 }, NOW).then((r) => r.triggers);
    await log.record({ ...first!, markPrice: '999' });
    const again = await alerts.triggers('u1', { alertId: row.id, limit: 10 }, NOW);
    expect(again.triggers).toHaveLength(1);
    expect(again.triggers[0]!.markPrice).toBe('120');
  });

  it('lists only the person own triggers, newest first, and no more than the limit', async () => {
    const { alerts } = rig();
    await alerts.create(base, NOW);
    await alerts.create({ ...base, userId: 'u2' }, NOW);
    await alerts.evaluateDueAlerts(NOW);
    await alerts.create({ ...base, targetPrice: '110' }, NOW);
    await alerts.evaluateDueAlerts(new Date(NOW.getTime() + 60_000));
    const mine = await alerts.triggers('u1', { limit: 10 }, NOW);
    expect(mine.triggers.map((t) => t.targetPrice)).toEqual(['110', '100']);
    expect(mine.triggers.every((t) => t.userId === 'u1')).toBe(true);
    expect((await alerts.triggers('u1', { limit: 1 }, NOW)).triggers).toHaveLength(1);
  });

  it('blank retention writes no log, refuses the read, and the alert still fires', async () => {
    const { alerts, log } = rig({
      ...LIMITS,
      triggerLogDays: null,
      maxActivePrice: 20,
      repeatFrequencies: [],
      burstWindowMinutes: null,
      burstMaxTriggers: null,
    });
    const row = await alerts.create(base, NOW);
    expect((await alerts.evaluateDueAlerts(NOW)).fired).toBe(1);
    expect((await alerts.get('u1', row.id))!.status).toBe('fired');
    expect(await log.list('u1', { since: new Date(0), limit: 10 })).toHaveLength(0);
    await expect(alerts.triggers('u1', { limit: 10 }, NOW)).rejects.toMatchObject({
      code: NOTIFY_ALERT_TRIGGER_LOG_RETENTION_UNSET,
    });
    await expect(alerts.triggers('u1', { limit: 10 }, NOW)).rejects.toBeInstanceOf(AlertLimitError);
  });

  it('hides and then prunes rows older than the retention', async () => {
    const { alerts, log } = rig();
    await alerts.create(base, NOW);
    await alerts.evaluateDueAlerts(NOW);
    const eightDays = new Date(NOW.getTime() + 8 * 86_400_000);
    expect((await alerts.triggers('u1', { limit: 10 }, eightDays)).triggers).toHaveLength(0);
    expect(await log.list('u1', { since: new Date(0), limit: 10 })).toHaveLength(1);
    await alerts.evaluateDueAlerts(eightDays);
    expect(await log.list('u1', { since: new Date(0), limit: 10 })).toHaveLength(0);
  });
});
