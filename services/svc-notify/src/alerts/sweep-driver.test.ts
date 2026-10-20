/**
 * Unit card — boot + interval share one sweep driver
 * 1. Promise: mounted sweep evaluates on boot, not only after ALERT_SWEEP_INTERVAL_MS
 * 2. Break: interval-only driver leaves /ready.lastAt null and watches blind at boot
 * 3. Done bar: runAlertSweepPass records complete/error; evaluateDueAlerts is the job
 * 4. Class N
 * 5. Paths: services/svc-notify/src/alerts/**
 * 6. RED: delete runAlertSweepPass or stop calling evaluateDueAlerts inside it
 * 7. Collision: none
 */

import { describe, expect, it, vi } from 'vitest';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';
import { runAlertSweepPass } from './sweep-driver.js';
import { AlertService } from './service.js';
import { MemoryAlertStore } from './store.js';
import type { MarkSource } from './types.js';
import { TEST_ALERT_LIMITS } from './test-limits.js';

const darkMarks: MarkSource = {
  kind: 'dark',
  async quote() {
    return { kind: 'unavailable', reason: 'dark', detail: 'no mark source configured' };
  },
};

describe('runAlertSweepPass — the mounted job path', () => {
  it('records a completed pass from evaluateDueAlerts', async () => {
    const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
    const alerts = new AlertService(new MemoryAlertStore(), darkMarks, notify, undefined, TEST_ALERT_LIMITS);
    await alerts.create({ userId: 'u1', marketId: 'BTC-USD', direction: 'above', targetPrice: '100' });

    const onComplete = vi.fn();
    const onError = vi.fn();
    await runAlertSweepPass(alerts, { onComplete, onError });

    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]![0]).toMatchObject({
      markets: 1,
      fired: 0,
      refused: 1,
      refusals: { 'alert.price_unavailable': 1 },
    });
    expect(onComplete.mock.calls[0]![1]).toBeInstanceOf(Date);
  });

  it('records errors without throwing — the inbox must stay up', async () => {
    const alerts = {
      evaluateDueAlerts: vi.fn(async () => {
        throw new Error('simulated sweep failure');
      }),
    } as unknown as AlertService;

    const onComplete = vi.fn();
    const onError = vi.fn();
    await expect(runAlertSweepPass(alerts, { onComplete, onError })).resolves.toBeUndefined();

    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});
