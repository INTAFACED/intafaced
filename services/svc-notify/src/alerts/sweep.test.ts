/**
 * Unit card — the alert sweep is a real job path, and a dark one writes nothing
 * 1. Promise: a watch the user created is EVALUATED, and while no mark source is
 *    configured every evaluation refuses by name instead of firing on a guess
 * 2. Break: the sweep skips markets it did not enumerate; a dark source marks a
 *    watch fired or writes an inbox row; a fired watch fires twice
 * 3. Done bar: dark sweep → refused counts, zero inbox rows, watches still
 *    active; live crossing sweep → one inbox row per crossing watch, one-shot
 * 4. Class N
 * 5. Paths: svc-notify
 * 6. RED: delete `evaluateDueAlerts` or make it enumerate anything other than
 *    `activeMarkets()`
 * 7. Collision: none
 */

import { describe, expect, it, vi } from 'vitest';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';
import { AlertService } from './service.js';
import { MemoryAlertStore } from './store.js';
import type { MarkQuote, MarkSource } from './types.js';
import { TEST_ALERT_LIMITS } from './test-limits.js';

/** A mark source that answers per market, and states its own wiring honestly. */
function marks(kind: 'dark' | 'live', quotes: Record<string, MarkQuote> = {}): MarkSource {
  return {
    kind,
    async quote(marketId: string) {
      return quotes[marketId] ?? { kind: 'unavailable', reason: 'dark', detail: 'no mark source configured' };
    },
  };
}

function harness(source: MarkSource) {
  const notifyStore = new MemoryNotifyStore();
  const notify = new NotifyService(notifyStore, { fanoutEnabled: true });
  const alerts = new AlertService(new MemoryAlertStore(), source, notify, undefined, TEST_ALERT_LIMITS);
  return { alerts, notifyStore };
}

const watch = (userId: string, marketId: string, targetPrice: string, direction: 'above' | 'below' = 'above') => ({
  userId,
  marketId,
  direction,
  targetPrice,
});

describe('the alert sweep — evaluation that actually runs', () => {
  it('evaluates every market holding an active watch, without being handed a market list', async () => {
    const { alerts } = harness(
      marks('live', {
        'BTC-USD': { kind: 'ok', price: '100.5', at: new Date() },
        'ETH-USD': { kind: 'ok', price: '10', at: new Date() },
      }),
    );
    await alerts.create(watch('u1', 'BTC-USD', '100'));
    await alerts.create(watch('u2', 'ETH-USD', '50'));

    const report = await alerts.evaluateDueAlerts();

    // Two markets, discovered from the watch table itself.
    expect(report.markets).toBe(2);
    expect(report.fired).toBe(1); // BTC crossed 100
    expect(report.held).toBe(1); // ETH is nowhere near 50
    expect(report.refused).toBe(0);
  });

  it('a dark mark source refuses every watch, marks nothing fired, and writes no inbox row', async () => {
    const { alerts, notifyStore } = harness(marks('dark'));
    await alerts.create(watch('u1', 'BTC-USD', '100'));
    await alerts.create(watch('u2', 'BTC-USD', '90'));
    await alerts.create(watch('u3', 'ETH-USD', '5'));

    const report = await alerts.evaluateDueAlerts();

    expect(report).toEqual({
      markets: 2,
      fired: 0,
      held: 0,
      refused: 3,
      // The refusal is NAMED. "Nothing fired" without this number is
      // indistinguishable from "nothing was evaluated".
      refusals: { 'alert.price_unavailable': 3 },
    });

    // Not one of them pretends to have fired, and nobody was told anything.
    for (const userId of ['u1', 'u2', 'u3']) {
      expect((await alerts.list(userId))[0]!.status).toBe('active');
      expect(await notifyStore.unreadCount(userId)).toBe(0);
    }
  });

  it('reports zero markets rather than failing when nobody holds a watch', async () => {
    const { alerts } = harness(marks('dark'));
    await expect(alerts.evaluateDueAlerts()).resolves.toEqual({
      markets: 0,
      fired: 0,
      held: 0,
      refused: 0,
      refusals: {},
    });
  });

  it('fires a crossing watch into the inbox once, and the next sweep does not fire it again', async () => {
    const { alerts, notifyStore } = harness(marks('live', { 'BTC-USD': { kind: 'ok', price: '100.5', at: new Date() } }));
    await alerts.create(watch('u1', 'BTC-USD', '100'));

    const first = await alerts.evaluateDueAlerts();
    expect(first.fired).toBe(1);
    expect(await notifyStore.unreadCount('u1')).toBe(1);
    expect((await alerts.list('u1'))[0]!.status).toBe('fired');

    // One-shot. A second pass finds no active watch on that market at all, so
    // the market drops out of the sweep rather than re-notifying.
    const second = await alerts.evaluateDueAlerts();
    expect(second).toEqual({ markets: 0, fired: 0, held: 0, refused: 0, refusals: {} });
    expect(await notifyStore.unreadCount('u1')).toBe(1);
  });

  it('a cancelled watch is not swept', async () => {
    const { alerts, notifyStore } = harness(marks('live', { 'BTC-USD': { kind: 'ok', price: '100.5', at: new Date() } }));
    const row = await alerts.create(watch('u1', 'BTC-USD', '100'));
    await alerts.cancel('u1', row.id);

    await expect(alerts.evaluateDueAlerts()).resolves.toMatchObject({ markets: 0, fired: 0 });
    expect(await notifyStore.unreadCount('u1')).toBe(0);
  });

  it('required out-of-app that cannot deliver refuses on the sweep path and does not fire', async () => {
    const notifyStore = new MemoryNotifyStore();
    const create = vi.fn();
    const notify = {
      channelStatus: () => [
        { channel: 'inapp', available: true, reason: null, requires: [], required: false, socket: null },
        {
          channel: 'email',
          available: false,
          reason: 'channel.not_configured',
          requires: ['NOTIFY_EMAIL_GATEWAY_URL', 'NOTIFY_EMAIL_GATEWAY_TOKEN'],
          required: true,
          socket: 'socket.notify-email',
        },
      ],
      create,
    } as unknown as NotifyService;
    const alerts = new AlertService(
      new MemoryAlertStore(),
      marks('live', { 'BTC-USD': { kind: 'ok', price: '100.5', at: new Date() } }),
      notify,
      undefined,
      TEST_ALERT_LIMITS,
    );
    await alerts.create(watch('u1', 'BTC-USD', '100'));

    const report = await alerts.evaluateDueAlerts();
    expect(report).toMatchObject({
      markets: 1,
      fired: 0,
      refused: 1,
      refusals: { 'channel.not_configured': 1 },
    });
    expect(create).not.toHaveBeenCalled();
    expect((await alerts.list('u1'))[0]!.status).toBe('active');
    expect(await notifyStore.unreadCount('u1')).toBe(0);
  });
});

describe('the disclosure the user surface reads', () => {
  it('a dark deployment says a watch cannot fire, and names the refusal it would record', () => {
    const { alerts } = harness(marks('dark'));
    expect(alerts.evaluationStatus()).toEqual({
      markSource: 'dark',
      canFire: false,
      code: 'alert.price_unavailable',
    });
  });

  it('a wired deployment says the wiring is there, and claims nothing more', () => {
    const { alerts } = harness(marks('live'));
    expect(alerts.evaluationStatus()).toEqual({ markSource: 'live', canFire: true, code: null });
  });

  it('canFire follows the wiring, not the last quote — a live source that happens to be unavailable still reads live', async () => {
    // The distinction that matters: `canFire` must not flap with weather, or an
    // operator reading it cannot tell "no feed configured" from "feed hiccuped".
    const { alerts } = harness(marks('live', { 'BTC-USD': { kind: 'unavailable', reason: 'stale', detail: 'mark age > 30s' } }));
    await alerts.create(watch('u1', 'BTC-USD', '100'));

    const report = await alerts.evaluateDueAlerts();
    expect(report.refused).toBe(1);
    expect(alerts.evaluationStatus().canFire).toBe(true);
  });
});
