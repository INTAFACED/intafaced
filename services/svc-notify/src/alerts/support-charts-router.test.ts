/**
 * J-charts-desk-19 #1: svc-support reads one account's alerts and their trigger history through `supportCharts.alerts`.
 * Only svc-support is admitted; an account with no alerts reads an empty list; a blank trigger-log retention reads unread.
 */
import { describe, expect, it } from 'vitest';
import { createEdgeContext, supportChartsAlertsReadSchema } from '@intafaced/contracts';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';
import { AlertService, type AlertLimits } from './service.js';
import { MemoryAlertStore } from './store.js';
import { MemoryAlertTriggerLog } from './trigger-log.js';
import type { MarkSource } from './types.js';
import { supportChartsAlertsOf, supportChartsRouter } from './support-charts-router.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
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

function rig(limits: AlertLimits = LIMITS) {
  const marks: MarkSource = { kind: 'live', quote: async (_m, at) => ({ kind: 'ok', price: '120', at: at ?? new Date() }) };
  const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
  return new AlertService(new MemoryAlertStore(), marks, notify, undefined, limits, new MemoryAlertTriggerLog());
}

const edge = createEdgeContext({ secret: 'a-notify-support-charts-test-edge-secret', serviceName: 'svc-notify' });
const as = (service: string | null) => ({ ...edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'req' }), service });

describe('supportCharts.alerts', () => {
  it('reads the account’s alerts and the time each fired, and nobody else’s', async () => {
    const alerts = rig();
    const mine = await alerts.create({ userId: USER, marketId: 'BTC-USD', direction: 'above', targetPrice: '100' }, NOW);
    await alerts.create({ userId: OTHER, marketId: 'BTC-USD', direction: 'above', targetPrice: '100' }, NOW);
    await alerts.evaluateDueAlerts(NOW);

    const read = supportChartsAlertsReadSchema.parse(await supportChartsAlertsOf(alerts, USER, NOW));
    expect(read.userId).toBe(USER);
    expect(read.alerts.map((a) => a.id)).toEqual([mine.id]);
    expect(read.alerts[0]).toMatchObject({ status: 'fired', targetPrice: '100', condition: 'greater_than', firedAt: NOW.toISOString() });
    expect(read.history).toEqual({
      status: 'read',
      retentionDays: 7,
      more: false,
      items: [
        {
          alertId: mine.id,
          seq: 1,
          marketId: 'BTC-USD',
          condition: 'greater_than',
          targetPrice: '100',
          markPrice: '120',
          firedAt: NOW.toISOString(),
        },
      ],
    });
  });

  it('an account with no alerts reads empty lists', async () => {
    const read = await supportChartsAlertsOf(rig(), USER, NOW);
    expect(read).toEqual({ userId: USER, alerts: [], more: false, history: { status: 'read', retentionDays: 7, more: false, items: [] } });
  });

  it('a trigger log with no retention set reads unread, not empty', async () => {
    const read = await supportChartsAlertsOf(rig({ ...LIMITS, triggerLogDays: null }), USER, NOW);
    expect(read.history).toEqual({ status: 'unread', reason: 'retention_unset' });
  });

  it('admits svc-support alone: no service, another service and an edge caller are refused', async () => {
    const r = supportChartsRouter(rig());
    await expect(r.createCaller(as('svc-support')).alerts({ userId: USER })).resolves.toMatchObject({ userId: USER, alerts: [] });
    await expect(r.createCaller(as('svc-trade')).alerts({ userId: USER })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(r.createCaller(as(null)).alerts({ userId: USER })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
