/**
 * Unit card — v22.alerts dark/absent mark never fires as live
 * 1. Promise: tracker v22.alerts + §31 — accepted-mark vocabulary; OOA required
 *    that cannot deliver refuses by name
 * 2. Break: MarkSource.kind dark still returns ok and evaluateMarket fires;
 *    absent quote treated as zero; required email silently skipped;
 *    live ok quote with hours-old `at` fires the one-shot
 * 3. Done bar: dark/absent/stale/future → refuse alert.price_unavailable, zero inbox;
 *    required OOA unavailable → channel.not_configured, watch stays active
 * 4. Class N (no money movement; decimal strings only)
 * 5. Paths: services/svc-notify/src/alerts/**
 * 6. RED: this suite
 * 7. Collision: none on svc-notify wall (#1841/#1845–1847 elsewhere)
 */

import { describe, expect, it, vi } from 'vitest';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';
import {
  ALERT_MARK_FUTURE_SLACK_MS,
  ALERT_MARK_MAX_AGE_MS,
  acceptAlertMark,
  outOfAppRequiredRefusal,
  refuseIfMarkAged,
} from './accepted-mark.js';
import { AlertService } from './service.js';
import { MemoryAlertStore } from './store.js';
import type { MarkSource } from './types.js';
import { TEST_ALERT_LIMITS } from './test-limits.js';

describe('acceptAlertMark — dark/absent never become a live price', () => {
  it('a dark source that invents an ok quote is still unavailable', () => {
    const accepted = acceptAlertMark({ kind: 'dark' }, { kind: 'ok', price: '999', at: new Date() });
    expect(accepted).toEqual({
      kind: 'unavailable',
      reason: 'dark',
      detail: 'mark source is dark — refuse rather than invent',
    });
  });

  it('an absent mark refuses rather than becoming zero', () => {
    expect(acceptAlertMark({ kind: 'live' }, null).kind).toBe('unavailable');
    expect(acceptAlertMark({ kind: 'live' }, undefined).kind).toBe('unavailable');
    const absent = acceptAlertMark({ kind: 'live' }, null);
    if (absent.kind === 'unavailable') expect(absent.reason).toBe('refused');
  });

  it('a live source may still pass through an honest ok quote', () => {
    const at = new Date('2026-08-14T00:00:00Z');
    // `now` must be the sweep clock — defaulting to wall time would refuse a
    // fixture dated yesterday and hide a real stale-mark hole behind the test.
    expect(acceptAlertMark({ kind: 'live' }, { kind: 'ok', price: '100.5', at }, at)).toEqual({
      kind: 'ok',
      price: '100.5',
      at,
    });
  });

  it('a live ok quote older than the bank marking window is stale, not a price', () => {
    const now = new Date('2026-08-14T00:10:00Z');
    const at = new Date(now.getTime() - ALERT_MARK_MAX_AGE_MS - 1_000);
    const accepted = acceptAlertMark({ kind: 'live' }, { kind: 'ok', price: '100.5', at }, now);
    expect(accepted).toMatchObject({ kind: 'unavailable', reason: 'stale' });
    if (accepted.kind === 'unavailable') {
      expect(accepted.detail).toMatch(/301s old, limit 300s/);
    }
  });

  it('a live ok quote dated further ahead than clock slack is refused', () => {
    const now = new Date('2026-08-14T00:00:00Z');
    const at = new Date(now.getTime() + ALERT_MARK_FUTURE_SLACK_MS + 1_000);
    const accepted = acceptAlertMark({ kind: 'live' }, { kind: 'ok', price: '100.5', at }, now);
    expect(accepted).toMatchObject({ kind: 'unavailable', reason: 'refused' });
    if (accepted.kind === 'unavailable') {
      expect(accepted.detail).toMatch(/31s in the future/);
    }
  });

  it('an ok quote on the age boundary still passes (300s is the last fresh second)', () => {
    const now = new Date('2026-08-14T00:05:00Z');
    const at = new Date(now.getTime() - ALERT_MARK_MAX_AGE_MS);
    expect(refuseIfMarkAged({ kind: 'ok', price: '100.5', at }, now)).toEqual({
      kind: 'ok',
      price: '100.5',
      at,
    });
  });

  it('preserves an honest dark unavailable quote', () => {
    const q = { kind: 'unavailable' as const, reason: 'dark' as const, detail: 'no mark source configured' };
    expect(acceptAlertMark({ kind: 'dark' }, q)).toEqual(q);
  });
});

describe('outOfAppRequiredRefusal — named, never silent drop', () => {
  it('returns null when nothing is required (inbox-only is honest)', () => {
    expect(outOfAppRequiredRefusal([])).toBeNull();
    expect(outOfAppRequiredRefusal([{ channel: 'email', required: false, available: false, reason: 'channel.not_configured' }])).toBeNull();
  });

  it('names the required channel that cannot deliver', () => {
    expect(
      outOfAppRequiredRefusal([
        { channel: 'inapp', required: false, available: true, reason: null },
        { channel: 'email', required: true, available: false, reason: 'channel.not_configured' },
      ]),
    ).toEqual({
      code: 'channel.not_configured',
      detail: 'email:channel.not_configured',
    });
  });

  it('keeps channel.disabled distinct from not_configured', () => {
    expect(outOfAppRequiredRefusal([{ channel: 'sms', required: true, available: false, reason: 'channel.disabled' }])).toEqual({
      code: 'channel.disabled',
      detail: 'sms:channel.disabled',
    });
  });

  it('does not refuse-to-fire a required channel that is configured but unprobed', () => {
    expect(outOfAppRequiredRefusal([{ channel: 'email', required: true, available: false, reason: 'channel.unprobed' }])).toBeNull();
  });
});

describe('AlertService — dark kind cannot fire even with an invented quote', () => {
  it('refuses and writes no inbox row when a dark port answers ok', async () => {
    const notifyStore = new MemoryNotifyStore();
    const notify = new NotifyService(notifyStore, { fanoutEnabled: true });
    const marks: MarkSource = {
      kind: 'dark',
      async quote() {
        return { kind: 'ok', price: '100.5', at: new Date() };
      },
    };
    const alerts = new AlertService(new MemoryAlertStore(), marks, notify, undefined, TEST_ALERT_LIMITS);
    await alerts.create({
      userId: 'u1',
      marketId: 'BTC-USD',
      direction: 'above',
      targetPrice: '100',
    });

    const report = await alerts.evaluateMarket('BTC-USD');
    expect(report.mark).toBeNull();
    expect(report.results[0]!.outcome).toMatchObject({
      kind: 'refuse',
      code: 'alert.price_unavailable',
    });
    expect(report.results[0]!.notificationId).toBeNull();
    expect((await alerts.list('u1'))[0]!.status).toBe('active');
    expect(await notifyStore.unreadCount('u1')).toBe(0);
    expect(alerts.evaluationStatus()).toEqual({
      markSource: 'dark',
      canFire: false,
      code: 'alert.price_unavailable',
    });
  });

  it('refuses a live source whose ok quote is older than the marking window — no inbox, watch stays active', async () => {
    const notifyStore = new MemoryNotifyStore();
    const notify = new NotifyService(notifyStore, { fanoutEnabled: true });
    const now = new Date('2026-08-14T00:10:00Z');
    const marks: MarkSource = {
      kind: 'live',
      async quote() {
        return { kind: 'ok', price: '100.5', at: new Date(now.getTime() - 301_000) };
      },
    };
    const alerts = new AlertService(new MemoryAlertStore(), marks, notify, undefined, TEST_ALERT_LIMITS);
    await alerts.create({
      userId: 'u1',
      marketId: 'BTC-USD',
      direction: 'above',
      targetPrice: '100',
    });

    const report = await alerts.evaluateMarket('BTC-USD', now);
    expect(report.mark).toBeNull();
    expect(report.results[0]!.outcome).toMatchObject({
      kind: 'refuse',
      code: 'alert.price_unavailable',
    });
    expect(report.results[0]!.notificationId).toBeNull();
    expect((await alerts.list('u1'))[0]!.status).toBe('active');
    expect(await notifyStore.unreadCount('u1')).toBe(0);
    // Wiring is still live — stale is weather, not "no feed configured".
    expect(alerts.evaluationStatus()).toEqual({
      markSource: 'live',
      canFire: true,
      code: null,
    });
  });

  it('refuses a live source that returns no quote at all', async () => {
    const notifyStore = new MemoryNotifyStore();
    const notify = new NotifyService(notifyStore, { fanoutEnabled: true });
    const marks = {
      kind: 'live' as const,
      async quote() {
        return undefined as unknown as Awaited<ReturnType<MarkSource['quote']>>;
      },
    };
    const alerts = new AlertService(new MemoryAlertStore(), marks, notify, undefined, TEST_ALERT_LIMITS);
    await alerts.create({
      userId: 'u1',
      marketId: 'BTC-USD',
      direction: 'above',
      targetPrice: '100',
    });
    const report = await alerts.evaluateMarket('BTC-USD');
    expect(report.results[0]!.outcome).toMatchObject({ kind: 'refuse', code: 'alert.price_unavailable' });
    expect(await notifyStore.unreadCount('u1')).toBe(0);
  });

  it('required out-of-app that cannot deliver refuses by name and does not fire', async () => {
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
    const marks: MarkSource = {
      kind: 'live',
      async quote() {
        return { kind: 'ok', price: '100.5', at: new Date() };
      },
    };
    const alerts = new AlertService(new MemoryAlertStore(), marks, notify, undefined, TEST_ALERT_LIMITS);
    await alerts.create({
      userId: 'u1',
      marketId: 'BTC-USD',
      direction: 'above',
      targetPrice: '100',
    });

    const report = await alerts.evaluateMarket('BTC-USD');
    expect(report.results[0]!.outcome).toMatchObject({
      kind: 'refuse',
      code: 'channel.not_configured',
      detail: 'email:channel.not_configured',
    });
    expect(create).not.toHaveBeenCalled();
    expect((await alerts.list('u1'))[0]!.status).toBe('active');
    expect(await notifyStore.unreadCount('u1')).toBe(0);
    expect(alerts.evaluationStatus()).toEqual({
      markSource: 'live',
      canFire: false,
      code: 'channel.not_configured',
    });
  });
});
