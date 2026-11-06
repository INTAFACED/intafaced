/**
 * Public notify actions for notices and alerts.
 * A blank price refuses the alert. The alerts list requires its limit.
 * A public announcement stays empty until real content exists.
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { AlertService } from './alerts/service.js';
import { MemoryAlertStore } from './alerts/store.js';
import type { MarkSource } from './alerts/types.js';
import { NotifyService } from './notify-service.js';
import { createNotifyRouter } from './router.js';
import { MemoryNotifyStore } from './store.js';
import { TEST_ALERT_LIMITS } from './alerts/test-limits.js';

const SECRET = 'a-notify-notices-test-edge-secret-long';
const USER = '11111111-1111-4111-8111-111111111111';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-notify' });

function principal(): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['notify:read', 'notify:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function signed() {
  const raw = encodePrincipal(principal());
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-notices',
  });
}

function anonymous() {
  return edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon-notice' });
}

function darkMarks(): MarkSource {
  return {
    kind: 'dark',
    async quote() {
      return { kind: 'unavailable', reason: 'dark' };
    },
  };
}

function openCaller() {
  const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
  const alerts = new AlertService(new MemoryAlertStore(), darkMarks(), notify, undefined, TEST_ALERT_LIMITS);
  return createNotifyRouter(notify, alerts).createCaller(signed());
}

describe('price alert', () => {
  it('refuses while the price is blank and posts nothing', async () => {
    const caller = openCaller();

    await expect(caller.notify.createAlert({ marketId: 'BTC-USD', direction: 'above' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'A price alert is refused. The missing piece is price.',
      cause: {
        name: 'NotifyPriceUnsetError',
        code: 'notify.price_unset',
        missingPiece: 'price',
        slot: null,
      },
    });

    const listed = await caller.notify.alerts({ limit: 1 });
    expect(listed.items).toEqual([]);
    expect(await caller.notify.unreadCount()).toEqual({ count: 0 });
  });

  it('refuses an empty price string and does not invent one', async () => {
    const caller = openCaller();

    for (const targetPrice of ['', '   ']) {
      await expect(caller.notify.createAlert({ marketId: 'BTC-USD', direction: 'above', targetPrice })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'A price alert is refused. The missing piece is price.',
        cause: {
          name: 'NotifyPriceUnsetError',
          code: 'notify.price_unset',
          missingPiece: 'price',
          slot: null,
        },
      });
    }

    const listed = await caller.notify.alerts({ limit: 1 });
    expect(listed.items).toEqual([]);
    expect(await caller.notify.unreadCount()).toEqual({ count: 0 });
  });
});

describe('alerts list', () => {
  it('refuses when the limit is omitted and does not invent a page size', async () => {
    const caller = openCaller();
    await caller.notify.createAlert({ marketId: 'BTC-USD', direction: 'above', targetPrice: '100' });
    await caller.notify.createAlert({ marketId: 'ETH-USD', direction: 'below', targetPrice: '200' });

    await expect(caller.notify.alerts()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'notify.alerts_list_limit_unset',
      cause: {
        name: 'NotifyAlertsListLimitUnsetError',
        code: 'notify.alerts_list_limit_unset',
        missingPiece: 'limit',
        slot: null,
      },
    });

    let message = '';
    try {
      await caller.notify.alerts({});
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toBe('notify.alerts_list_limit_unset');
    expect(message).not.toMatch(/\b20\b|\b50\b/);
    expect(await caller.notify.unreadCount()).toEqual({ count: 0 });
  });

  it('returns one page when the caller sends the limit', async () => {
    const caller = openCaller();
    await caller.notify.createAlert({ marketId: 'BTC-USD', direction: 'above', targetPrice: '100' });
    await caller.notify.createAlert({ marketId: 'ETH-USD', direction: 'below', targetPrice: '200' });

    const page = await caller.notify.alerts({ limit: 1 });

    expect(page.items).toHaveLength(1);
    expect(['100', '200']).toContain(page.items[0]?.targetPrice);
    expect(await caller.notify.unreadCount()).toEqual({ count: 0 });
  });
});

describe('public announcement', () => {
  it('refuses until real content exists and does not invent filler', async () => {
    const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
    const alerts = new AlertService(new MemoryAlertStore(), darkMarks(), notify, undefined, TEST_ALERT_LIMITS);
    const router = createNotifyRouter(notify, alerts);
    const anon = router.createCaller(anonymous());
    const filler = 'The house is open. Trading is free today.';

    await expect(anon.notify.announcement({ text: filler })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'A public announcement is refused. The missing piece is content.',
      cause: {
        name: 'NotifyAnnouncementUnsetError',
        code: 'notify.announcement_unset',
        missingPiece: 'content',
        slot: null,
      },
    });

    let text = '';
    try {
      await anon.notify.announcement();
    } catch (err) {
      const cause = err instanceof Error && 'cause' in err && err.cause instanceof Error ? err.cause.message : '';
      text = err instanceof Error ? `${err.name} ${err.message} ${cause}` : String(err);
    }
    expect(text).not.toContain(filler);
    expect(text).not.toContain('Trading');
    expect(text).not.toMatch(/\d/);

    const signedCaller = router.createCaller(signed());
    expect(await signedCaller.notify.alerts({ limit: 1 })).toMatchObject({ items: [] });
    expect(await signedCaller.notify.unreadCount()).toEqual({ count: 0 });
  });
});

describe('watchlist alert', () => {
  it('creates one alert per market in one answer and lists them', async () => {
    const caller = openCaller();
    const made = await caller.notify.createAlerts({ marketIds: ['BTC-USD', 'ETH-USD'], direction: 'above', targetPrice: '100' });
    expect(made.alerts.map((a) => a.marketId)).toEqual(['BTC-USD', 'ETH-USD']);
    expect(made.alerts.every((a) => a.targetPrice === '100' && a.status === 'active')).toBe(true);
    expect(made.evaluation.canFire).toBe(false);
    expect((await caller.notify.alerts({ limit: 10 })).items).toHaveLength(2);
    expect(await caller.notify.alertQuota()).toMatchObject({ kind: 'price', used: 2, max: 1000 });
  });

  it('refuses a blank price as a single create does, and a condition that disagrees with the direction, creating nothing', async () => {
    const caller = openCaller();
    await expect(caller.notify.createAlerts({ marketIds: ['BTC-USD'], direction: 'above' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'notify.price_unset' },
    });
    await expect(
      caller.notify.createAlerts({ marketIds: ['BTC-USD'], direction: 'above', targetPrice: '100', condition: 'less_than' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((await caller.notify.alerts({ limit: 10 })).items).toEqual([]);
  });

  it('refuses a batch past the cap as a precondition and creates none of it', async () => {
    const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
    const alerts = new AlertService(new MemoryAlertStore(), darkMarks(), notify, undefined, {
      ...TEST_ALERT_LIMITS,
      maxActivePrice: 2,
      repeatFrequencies: [],
    });
    const caller = createNotifyRouter(notify, alerts).createCaller(signed());
    await expect(
      caller.notify.createAlerts({ marketIds: ['BTC-USD', 'ETH-USD', 'SOL-USD'], direction: 'above', targetPrice: '100' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', cause: { code: 'alert.quota_reached' } });
    expect((await caller.notify.alerts({ limit: 10 })).items).toEqual([]);
  });

  it('answers the quota as not set while the cap is blank', async () => {
    const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
    const alerts = new AlertService(new MemoryAlertStore(), darkMarks(), notify);
    const caller = createNotifyRouter(notify, alerts).createCaller(signed());
    expect(await caller.notify.alertQuota()).toEqual({ kind: 'price', used: 0, max: null, burst: null, maxConditions: null });
    await expect(caller.notify.createAlerts({ marketIds: ['BTC-USD'], direction: 'above', targetPrice: '100' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'notify.alert_quota_unset' },
    });
  });
});

describe('alert price source and condition limit on the wire', () => {
  it('stores the chosen source on createAlert, createAlerts and updateAlert, and an alert sent without one is on mark', async () => {
    const caller = openCaller();
    const plain = await caller.notify.createAlert({ marketId: 'BTC-USD', direction: 'above', targetPrice: '100' });
    expect(plain.alert.source).toBe('mark');
    const onAsk = await caller.notify.createAlert({ marketId: 'BTC-USD', direction: 'above', targetPrice: '100', source: 'ask' });
    expect(onAsk.alert.source).toBe('ask');
    const batch = await caller.notify.createAlerts({
      marketIds: ['ETH-USD', 'SOL-USD'],
      direction: 'below',
      targetPrice: '50',
      source: 'last',
    });
    expect(batch.alerts.map((a) => a.source)).toEqual(['last', 'last']);
    const edited = await caller.notify.updateAlert({ id: onAsk.alert.id, source: 'bid' });
    expect(edited.alert.source).toBe('bid');
    // An edit that does not name the source keeps it.
    expect((await caller.notify.updateAlert({ id: onAsk.alert.id, targetPrice: '120' })).alert.source).toBe('bid');
    const listed = await caller.notify.alerts({ limit: 10 });
    expect(listed.items.find((a) => a.id === onAsk.alert.id)?.source).toBe('bid');
  });

  it('refuses a source outside the four, creating nothing', async () => {
    const caller = openCaller();
    await expect(
      caller.notify.createAlert({ marketId: 'BTC-USD', direction: 'above', targetPrice: '100', source: 'mid' as never }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((await caller.notify.alerts({ limit: 10 })).items).toEqual([]);
  });

  it('alertQuota carries the owner condition limit, and null while it is blank', async () => {
    expect((await openCaller().notify.alertQuota()).maxConditions).toBeNull();
    const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
    const alerts = new AlertService(new MemoryAlertStore(), darkMarks(), notify, undefined, { ...TEST_ALERT_LIMITS, maxConditions: 3 });
    const caller = createNotifyRouter(notify, alerts).createCaller(signed());
    expect(await caller.notify.alertQuota()).toMatchObject({ kind: 'price', max: 1000, maxConditions: 3 });
  });
});
