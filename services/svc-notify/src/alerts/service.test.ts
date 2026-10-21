/**
 * AlertService — create + dark refuse + cross fires one inbox row.
 */

import { describe, expect, it } from 'vitest';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';
import { AlertService } from './service.js';
import { MemoryAlertStore } from './store.js';
import { createDarkWhaleMarkSource } from './whale-mark.js';
import {
  ALERT_KIND_UNPUBLISHED,
  ALERT_PORTFOLIO_VIEW_UNPUBLISHED,
  ALERTS_WHALE_MARK_DARK,
  AlertKindUnpublishedError,
  AlertPortfolioUnpublishedError,
  UNPUBLISHED_ALERT_KINDS,
  type MarkQuote,
  type MarkSource,
} from './types.js';
import { TEST_ALERT_LIMITS } from './test-limits.js';

function quoteSource(mark: MarkQuote): MarkSource {
  return {
    // A fake that CAN quote is `live` — `kind` describes the wiring, and a test
    // source answering `{ kind: 'ok' }` while claiming to be dark would be the
    // same lie in the other direction.
    kind: mark.kind === 'ok' ? 'live' : 'dark',
    async quote() {
      return mark;
    },
  };
}

function harness(mark: MarkQuote, whaleMark: MarkQuote | 'dark' = 'dark') {
  const notifyStore = new MemoryNotifyStore();
  // Inbox-only NotifyService is enough: alerts ride create() for the row;
  // out-of-app dispatch is the same path as every other bus consumer.
  const notify = new NotifyService(notifyStore, { fanoutEnabled: true });
  const whaleMarks = whaleMark === 'dark' ? createDarkWhaleMarkSource() : quoteSource(whaleMark);
  const alerts = new AlertService(new MemoryAlertStore(), quoteSource(mark), notify, whaleMarks, TEST_ALERT_LIMITS);
  return { alerts, notifyStore };
}

describe('AlertService — rides notify fan-out, refuses dark marks', () => {
  it('creates a watch and lists it self-only', async () => {
    const { alerts } = harness({ kind: 'ok', price: '90', at: new Date() });
    const row = await alerts.create({
      userId: 'u1',
      marketId: 'BTC-USD',
      direction: 'above',
      targetPrice: '100',
    });
    expect(row.status).toBe('active');
    const list = await alerts.list('u1');
    expect(list).toHaveLength(1);
    expect(await alerts.list('u2')).toHaveLength(0);
  });

  it('dark mark refuses every active alert and writes no notification', async () => {
    const { alerts, notifyStore } = harness({ kind: 'unavailable', reason: 'dark' });
    const row = await alerts.create({
      userId: 'u1',
      marketId: 'BTC-USD',
      direction: 'above',
      targetPrice: '100',
    });
    const report = await alerts.evaluateMarket('BTC-USD');
    expect(report.mark).toBeNull();
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      alertId: row.id,
      outcome: { kind: 'refuse', code: 'alert.price_unavailable' },
      notificationId: null,
    });
    // Still active — dark is not a fire.
    expect((await alerts.list('u1'))[0]!.status).toBe('active');
    expect(await notifyStore.unreadCount('u1')).toBe(0);
  });

  it('cross fires once into the inbox and marks the alert fired', async () => {
    const { alerts, notifyStore } = harness({ kind: 'ok', price: '100.5', at: new Date() });
    await alerts.create({
      userId: 'u1',
      marketId: 'BTC-USD',
      direction: 'above',
      targetPrice: '100',
    });
    const report = await alerts.evaluateMarket('BTC-USD');
    expect(report.mark).toBe('100.5');
    expect(report.results[0]!.outcome.kind).toBe('fire');
    expect(report.results[0]!.notificationId).toBeTruthy();

    const inbox = await notifyStore.list({ userId: 'u1', limit: 10, unreadOnly: false });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]!.kind).toBe('alert.price.crossed');
    expect(inbox.items[0]!.params).toMatchObject({
      marketId: 'BTC-USD',
      targetPrice: '100',
      markPrice: '100.5',
    });
    expect((await alerts.list('u1'))[0]!.status).toBe('fired');

    // Second evaluate does not re-fire (no longer active).
    const again = await alerts.evaluateMarket('BTC-USD');
    expect(again.results).toHaveLength(0);
    expect(await notifyStore.unreadCount('u1')).toBe(1);
  });

  it('hold leaves the alert active and the inbox empty', async () => {
    const { alerts, notifyStore } = harness({ kind: 'ok', price: '99', at: new Date() });
    await alerts.create({
      userId: 'u1',
      marketId: 'BTC-USD',
      direction: 'above',
      targetPrice: '100',
    });
    const report = await alerts.evaluateMarket('BTC-USD');
    expect(report.results[0]!.outcome).toEqual({ kind: 'hold', markPrice: '99' });
    expect(await notifyStore.unreadCount('u1')).toBe(0);
    expect((await alerts.list('u1'))[0]!.status).toBe('active');
  });
});

describe('AlertService — portfolio watch is refuse-closed', () => {
  it('createPortfolio throws the unpublished code and stores nothing', async () => {
    const { alerts, notifyStore } = harness({ kind: 'ok', price: '100.5', at: new Date() });
    expect(() => alerts.createPortfolio({ kind: 'portfolio', userId: 'u1' })).toThrow(AlertPortfolioUnpublishedError);
    try {
      alerts.createPortfolio({ kind: 'portfolio', userId: 'u1' });
    } catch (err) {
      expect(err).toBeInstanceOf(AlertPortfolioUnpublishedError);
      expect((err as AlertPortfolioUnpublishedError).code).toBe(ALERT_PORTFOLIO_VIEW_UNPUBLISHED);
      expect(String(err)).toContain(ALERT_PORTFOLIO_VIEW_UNPUBLISHED);
    }
    expect(await alerts.list('u1')).toHaveLength(0);
    expect(await notifyStore.unreadCount('u1')).toBe(0);
  });

  it('evaluatePortfolio refuses, writes no inbox, and carries no number balance', async () => {
    const { alerts, notifyStore } = harness({ kind: 'ok', price: '100.5', at: new Date() });
    const out = alerts.evaluatePortfolio();
    expect(out.kind).toBe('refuse');
    if (out.kind === 'refuse') {
      expect(out.code).toBe(ALERT_PORTFOLIO_VIEW_UNPUBLISHED);
    }
    expect(out.kind).not.toBe('fire');
    for (const value of Object.values(out)) {
      expect(typeof value).not.toBe('number');
    }
    expect(out).not.toHaveProperty('balance');
    expect(out).not.toHaveProperty('equity');
    expect(out).not.toHaveProperty('pnl');
    expect(await notifyStore.unreadCount('u1')).toBe(0);
    expect(await alerts.list('u1')).toHaveLength(0);
  });
});

describe('AlertService — unpublished kinds named-refuse, never an active live watch', () => {
  it.each([...UNPUBLISHED_ALERT_KINDS])('createUnpublishedKind(%s) throws and stores nothing', async (kind) => {
    const { alerts, notifyStore } = harness({ kind: 'ok', price: '100.5', at: new Date() });
    expect(() => alerts.createUnpublishedKind({ kind, userId: 'u1' })).toThrow(AlertKindUnpublishedError);
    try {
      alerts.createUnpublishedKind({ kind, userId: 'u1' });
    } catch (err) {
      expect(err).toBeInstanceOf(AlertKindUnpublishedError);
      expect((err as AlertKindUnpublishedError).code).toBe(ALERT_KIND_UNPUBLISHED);
      expect((err as AlertKindUnpublishedError).alertKind).toBe(kind);
      expect(String(err)).toContain(ALERT_KIND_UNPUBLISHED);
    }
    expect(await alerts.list('u1')).toHaveLength(0);
    expect(await notifyStore.unreadCount('u1')).toBe(0);
  });

  it.each([...UNPUBLISHED_ALERT_KINDS])('evaluateUnpublishedKind(%s) refuses and never fires', async (kind) => {
    const { alerts, notifyStore } = harness({ kind: 'ok', price: '100.5', at: new Date() });
    const out = alerts.evaluateUnpublishedKind(kind);
    expect(out).toMatchObject({ kind: 'refuse', code: ALERT_KIND_UNPUBLISHED });
    expect(out.kind).not.toBe('fire');
    expect(await notifyStore.unreadCount('u1')).toBe(0);
    expect(await alerts.list('u1')).toHaveLength(0);
  });

  it('price above/below against a sourced mark still fires', async () => {
    const { alerts, notifyStore } = harness({ kind: 'ok', price: '100.5', at: new Date() });
    await alerts.create({
      userId: 'u1',
      marketId: 'BTC-USD',
      direction: 'above',
      targetPrice: '100',
    });
    const report = await alerts.evaluateMarket('BTC-USD');
    expect(report.results[0]!.outcome.kind).toBe('fire');
    expect((await alerts.list('u1'))[0]!.status).toBe('fired');
    expect(await notifyStore.unreadCount('u1')).toBe(1);
  });
});

describe('AlertService — whale flow on the whale mark, never the price print', () => {
  it('create whale stores an active watch; dark whale mark refuses alerts.whale_mark_dark and never fires', async () => {
    const livePrice = harness({ kind: 'ok', price: '100.5', at: new Date() });
    const row = await livePrice.alerts.create({
      userId: 'u1',
      marketId: 'BTC-USD',
      kind: 'whale',
      direction: 'above',
      targetPrice: '1000',
    });
    expect(row.kind).toBe('whale');
    expect(row.status).toBe('active');
    expect(livePrice.alerts.whaleEvaluationStatus()).toEqual({
      markSource: 'dark',
      canFire: false,
      code: ALERTS_WHALE_MARK_DARK,
    });

    const refused = await livePrice.alerts.evaluateMarket('BTC-USD');
    expect(refused.results[0]!.outcome).toMatchObject({ kind: 'refuse', code: ALERTS_WHALE_MARK_DARK });
    expect(refused.results[0]!.notificationId).toBeNull();
    expect((await livePrice.alerts.list('u1'))[0]!.status).toBe('active');
    expect(await livePrice.notifyStore.unreadCount('u1')).toBe(0);

    const byId = await livePrice.alerts.evaluateAlert('u1', row.id);
    expect(byId.evaluation.code).toBe(ALERTS_WHALE_MARK_DARK);
    expect(byId.outcome).toMatchObject({ kind: 'refuse', code: ALERTS_WHALE_MARK_DARK });
    expect(byId.alert?.status).toBe('active');
  });

  it('live whale allow-list flow fires once; a live price print still does not count as flow', async () => {
    const live = harness({ kind: 'ok', price: '100.5', at: new Date() }, { kind: 'ok', price: '2500', at: new Date() });
    const row = await live.alerts.create({
      userId: 'u1',
      marketId: 'BTC-USD',
      kind: 'whale',
      direction: 'above',
      targetPrice: '1000',
    });
    expect(live.alerts.whaleEvaluationStatus().canFire).toBe(true);
    const fired = await live.alerts.evaluateAlert('u1', row.id);
    expect(fired.outcome).toEqual({ kind: 'fire', markPrice: '2500' });
    expect(fired.notificationId).toBeTruthy();
    const inbox = await live.notifyStore.list({ userId: 'u1', limit: 10, unreadOnly: false });
    expect(inbox.items[0]!.kind).toBe('alert.whale.crossed');
    expect(inbox.items[0]!.params).toMatchObject({
      alertKind: 'whale',
      targetPrice: '1000',
      markPrice: '2500',
    });
    expect(typeof inbox.items[0]!.params.markPrice).toBe('string');
    expect((await live.alerts.list('u1'))[0]!.status).toBe('fired');
  });
});

describe('AlertService — funding and liquidation_proximity on the sourced mark', () => {
  it.each(['funding', 'liquidation_proximity'] as const)(
    'create %s stores an active watch; live cross fires; dark refuses and never fires',
    async (kind) => {
      const live = harness({ kind: 'ok', price: '100.5', at: new Date() });
      const row = await live.alerts.create({
        userId: 'u1',
        marketId: 'BTC-USD',
        kind,
        direction: 'above',
        targetPrice: '100',
      });
      expect(row.kind).toBe(kind);
      expect(row.status).toBe('active');
      expect(row.targetPrice).toBe('100');
      expect(typeof row.targetPrice).toBe('string');

      const fired = await live.alerts.evaluateMarket('BTC-USD');
      expect(fired.results[0]!.outcome.kind).toBe('fire');
      expect(fired.results[0]!.notificationId).toBeTruthy();
      const inbox = await live.notifyStore.list({ userId: 'u1', limit: 10, unreadOnly: false });
      expect(inbox.items[0]!.kind).toBe(`alert.${kind}.crossed`);
      expect(inbox.items[0]!.params).toMatchObject({
        alertKind: kind,
        targetPrice: '100',
        markPrice: '100.5',
      });
      expect((await live.alerts.list('u1'))[0]!.status).toBe('fired');

      const dark = harness({ kind: 'unavailable', reason: 'dark' });
      await dark.alerts.create({
        userId: 'u1',
        marketId: 'BTC-USD',
        kind,
        direction: 'above',
        targetPrice: '100',
      });
      const refused = await dark.alerts.evaluateMarket('BTC-USD');
      expect(refused.results[0]!.outcome).toMatchObject({ kind: 'refuse', code: 'alert.price_unavailable' });
      expect(refused.results[0]!.notificationId).toBeNull();
      expect((await dark.alerts.list('u1'))[0]!.status).toBe('active');
      expect(await dark.notifyStore.unreadCount('u1')).toBe(0);
    },
  );
});

describe('AlertService — fire only when the inbox can receive it', () => {
  /**
   * Unit card — markFired-before-notify burns the watch under kill / crash
   * 1. Promise: README price alerts — cross marks fired AND inserts one
   *    notification; fan-out kill writes nothing (fanout-off-pin); notify.create
   *    recovers crash-after-insert by re-fanning (notify-service.ts)
   * 2. Break: evaluateMarket called markFired then fireNotification — under
   *    NOTIFY_FANOUT_ENABLED=false create is a pure no-op AFTER status is
   *    already fired → user sees fired + empty inbox, one-shot never retries.
   *    Same if create throws after mark.
   * 3. Done bar: fire notification first; markFired only when an inbox row
   *    exists or was recovered (dispatch/notification); fanout-off leaves active
   * 4. Class N
   * 5. Paths: services/svc-notify/src/alerts/**
   * 6. RED: this suite
   * 7. Collision: none on wall
   */
  it('fan-out kill leaves a crossed watch active with an empty inbox', async () => {
    const notifyStore = new MemoryNotifyStore();
    const notify = new NotifyService(notifyStore, { fanoutEnabled: false });
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
    expect(report.results[0]!.outcome.kind).toBe('fire');
    expect(report.results[0]!.notificationId).toBeNull();
    // Must still be active so a later pass (fan-out back on) can deliver.
    expect((await alerts.list('u1'))[0]!.status).toBe('active');
    expect(await notifyStore.unreadCount('u1')).toBe(0);
  });

  it('create throw leaves the watch active so the next sweep can retry', async () => {
    const notifyStore = new MemoryNotifyStore();
    const notify = {
      create: async () => {
        throw new Error('simulated crash mid-fire');
      },
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

    await expect(alerts.evaluateMarket('BTC-USD')).rejects.toThrow(/simulated crash/);
    expect((await alerts.list('u1'))[0]!.status).toBe('active');
    expect(await notifyStore.unreadCount('u1')).toBe(0);
  });

  it('when fan-out returns, a previously crossed watch still fires once', async () => {
    const notifyStore = new MemoryNotifyStore();
    const alertStore = new MemoryAlertStore();
    const marks: MarkSource = {
      kind: 'live',
      async quote() {
        return { kind: 'ok', price: '100.5', at: new Date() };
      },
    };
    const alertsKilled = new AlertService(
      alertStore,
      marks,
      new NotifyService(notifyStore, { fanoutEnabled: false }),
      undefined,
      TEST_ALERT_LIMITS,
    );
    await alertsKilled.create({
      userId: 'u1',
      marketId: 'BTC-USD',
      direction: 'above',
      targetPrice: '100',
    });
    await alertsKilled.evaluateMarket('BTC-USD');
    expect((await alertsKilled.list('u1'))[0]!.status).toBe('active');
    expect(await notifyStore.unreadCount('u1')).toBe(0);

    // Same watch store, fan-out re-enabled — the blocked cross must still land once.
    const alertsLive = new AlertService(
      alertStore,
      marks,
      new NotifyService(notifyStore, { fanoutEnabled: true }),
      undefined,
      TEST_ALERT_LIMITS,
    );
    const report = await alertsLive.evaluateMarket('BTC-USD');
    expect(report.results[0]!.outcome.kind).toBe('fire');
    expect(report.results[0]!.notificationId).toBeTruthy();
    expect((await alertsLive.list('u1'))[0]!.status).toBe('fired');
    expect(await notifyStore.unreadCount('u1')).toBe(1);

    // One-shot holds after recovery.
    const again = await alertsLive.evaluateMarket('BTC-USD');
    expect(again.results).toHaveLength(0);
    expect(await notifyStore.unreadCount('u1')).toBe(1);
  });

  it('evaluateAlert refuses a dark port that still quotes a last — never fired as live', async () => {
    const notifyStore = new MemoryNotifyStore();
    const lyingDark: MarkSource = {
      kind: 'dark',
      async quote() {
        return { kind: 'ok', price: '999', at: new Date() };
      },
    };
    const alerts = new AlertService(
      new MemoryAlertStore(),
      lyingDark,
      new NotifyService(notifyStore, { fanoutEnabled: true }),
      undefined,
      TEST_ALERT_LIMITS,
    );
    const row = await alerts.create({
      userId: 'u1',
      marketId: 'BTC-USD',
      direction: 'above',
      targetPrice: '100',
    });
    const report = await alerts.evaluateAlert('u1', row.id);
    expect(report.evaluation).toEqual({
      markSource: 'dark',
      canFire: false,
      code: 'alert.price_unavailable',
    });
    expect(report.outcome).toMatchObject({ kind: 'refuse', code: 'alert.price_unavailable' });
    expect(report.alert?.status).toBe('active');
    expect(report.alert?.status).not.toBe('fired');
    expect(report.notificationId).toBeNull();
    expect(await notifyStore.unreadCount('u1')).toBe(0);
  });

  it('a reprinted mark spelling does not insert a second inbox row when markFired missed', async () => {
    const notifyStore = new MemoryNotifyStore();
    const alertStore = new (class extends MemoryAlertStore {
      attempts = 0;
      override async markFired(userId: string, id: string, at: Date) {
        this.attempts += 1;
        if (this.attempts === 1) throw new Error('markFired missed');
        return super.markFired(userId, id, at);
      }
    })();
    let price = '100.50';
    const marks: MarkSource = {
      kind: 'live',
      async quote() {
        return { kind: 'ok', price, at: new Date() };
      },
    };
    const alerts = new AlertService(
      alertStore,
      marks,
      new NotifyService(notifyStore, { fanoutEnabled: true }),
      undefined,
      TEST_ALERT_LIMITS,
    );
    const row = await alerts.create({
      userId: 'u1',
      marketId: 'BTC-USD',
      direction: 'above',
      targetPrice: '100',
    });

    await expect(alerts.evaluateMarket('BTC-USD')).rejects.toThrow(/markFired missed/);
    expect((await alerts.list('u1'))[0]!.status).toBe('active');
    expect(await notifyStore.unreadCount('u1')).toBe(1);

    // Same cross as compareDecimalStrings: 100.50 === 100.5. The recovery key must match.
    price = '100.5';
    const again = await alerts.evaluateMarket('BTC-USD');
    expect(again.results[0]!.outcome.kind).toBe('fire');
    const inbox = await notifyStore.list({ userId: 'u1', limit: 10, unreadOnly: false });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]!.sourceIdempotencyKey).toBe(`${row.id}:100.5`);
    expect(inbox.items[0]!.params).toMatchObject({ markPrice: '100.50' });
    expect(await notifyStore.unreadCount('u1')).toBe(1);
  });
});
