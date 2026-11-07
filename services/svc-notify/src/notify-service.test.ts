import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  MemoryEventBus,
  fillSettled,
  kycApproved,
  p2pEscrowLocked,
  p2pEscrowRefunded,
  p2pEscrowReleased,
  p2pTradeDisputed,
  rankUpdated,
  SECURITY_FACTOR_CHANGES,
  stakeCreated,
} from '@intafaced/events';
import { MemoryNotifyStore } from './store.js';
import { NotifyService } from './notify-service.js';
import { subscribeNotificationEvents } from './events.js';
import { isMessageKey } from '@intafaced/i18n';
import { categoryFromKind } from './preferences/categories.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const BUYER = '33333333-3333-4333-8333-333333333333';

function baseInsert(overrides: Partial<Parameters<NotifyService['create']>[0]> = {}) {
  return {
    userId: USER,
    kind: 'test',
    titleKey: 'notify.test.title',
    bodyKey: 'notify.test.body',
    sourceSubject: 'intafaced.trade.fill.settled',
    sourceIdempotencyKey: 'fill-1',
    ...overrides,
  };
}

describe('NotifyService — dedupe + self-only mark', () => {
  let store: MemoryNotifyStore;
  let notify: NotifyService;

  beforeEach(() => {
    store = new MemoryNotifyStore();
    notify = new NotifyService(store, { fanoutEnabled: true });
  });

  it('inserts a row once and ignores a second write with the same natural key', async () => {
    const first = await notify.create(baseInsert());
    expect(first.inserted).toBe(true);
    expect(first.notification?.id).toBeTruthy();

    const second = await notify.create(baseInsert());
    expect(second.inserted).toBe(false);
    expect(second.notification).toBeNull();

    const list = await notify.list({ userId: USER, limit: 10, unreadOnly: false });
    expect(list.items).toHaveLength(1);
  });

  it('allows the same source key for a different user', async () => {
    await notify.create(baseInsert({ userId: USER }));
    const other = await notify.create(baseInsert({ userId: OTHER }));
    expect(other.inserted).toBe(true);
  });

  it('skips inserts when fan-out is killed', async () => {
    const killed = new NotifyService(store, { fanoutEnabled: false });
    const result = await killed.create(baseInsert());
    expect(result.inserted).toBe(false);
    expect(await notify.unreadCount(USER)).toBe(0);
  });

  it('markRead only affects the principal rows — foreign ids are ignored', async () => {
    const mine = await notify.create(baseInsert({ sourceIdempotencyKey: 'a' }));
    const theirs = await notify.create(baseInsert({ userId: OTHER, sourceIdempotencyKey: 'b' }));

    const marked = await notify.markRead(USER, [mine.notification!.id, theirs.notification!.id]);
    expect(marked).toBe(1);

    expect(await notify.unreadCount(USER)).toBe(0);
    expect(await notify.unreadCount(OTHER)).toBe(1);
  });

  it('markAllRead is self-only', async () => {
    await notify.create(baseInsert({ sourceIdempotencyKey: 'a' }));
    await notify.create(baseInsert({ sourceIdempotencyKey: 'b' }));
    await notify.create(baseInsert({ userId: OTHER, sourceIdempotencyKey: 'c' }));

    const marked = await notify.markAllRead(USER);
    expect(marked).toBe(2);
    expect(await notify.unreadCount(USER)).toBe(0);
    expect(await notify.unreadCount(OTHER)).toBe(1);
  });

  it('list filters unreadOnly and paginates by cursor', async () => {
    for (let i = 0; i < 5; i++) {
      await notify.create(baseInsert({ sourceIdempotencyKey: `k${i}` }));
    }
    const first = await notify.list({ userId: USER, limit: 2, unreadOnly: false });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();

    const second = await notify.list({
      userId: USER,
      limit: 2,
      unreadOnly: false,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(2);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);

    await notify.markAllRead(USER);
    const unread = await notify.list({ userId: USER, limit: 10, unreadOnly: true });
    expect(unread.items).toHaveLength(0);
  });
});

describe('event fan-out', () => {
  it('writes a security inbox row for each sign-in factor change, pointing to Security, once per change, inbox only', async () => {
    const store = new MemoryNotifyStore();
    const notify = new NotifyService(store, { fanoutEnabled: true });
    const created = vi.spyOn(notify, 'create');
    const bus = new MemoryEventBus('svc-identity');
    await subscribeNotificationEvents(bus, notify);

    const change = (kind: (typeof SECURITY_FACTOR_CHANGES)[number], n: number) =>
      bus.publish(
        'securityFactorChanged',
        { userId: USER, change: kind, changedAt: new Date().toISOString(), noticeKey: `factor-changed:${USER}:${n}` },
        { idempotencyKey: `factor-changed:${USER}:${n}` },
      );
    for (const [i, kind] of SECURITY_FACTOR_CHANGES.entries()) await change(kind, i + 1);
    // A relay that publishes the same row again writes no second row.
    await change('totp_added', 1);

    const rows = (await notify.list({ userId: USER, limit: 10, unreadOnly: false })).items;
    expect(rows.map((r) => r.kind).sort()).toEqual(SECURITY_FACTOR_CHANGES.map((c) => `identity.security.${c}`).sort());
    for (const kind of SECURITY_FACTOR_CHANGES) {
      const row = rows.find((r) => r.kind === `identity.security.${kind}`)!;
      expect(row.titleKey).toBe(`notify.identity.security.${kind}.title`);
      // A password change says it was the password; every other change shares the factor body.
      expect(row.bodyKey).toBe(
        kind === 'password_changed' ? 'notify.identity.security.password_changed.body' : 'notify.identity.security.factor_changed.body',
      );
      expect(row.href).toBe('/uc/safe');
      expect(isMessageKey(row.titleKey) && isMessageKey(row.bodyKey)).toBe(true);
      expect(categoryFromKind(row.kind)).toBe('security');
    }
    // svc-identity mails the proved address itself, so the notice never goes out of app a second time.
    expect(created.mock.calls.every(([input]) => input.outOfApp === false)).toBe(true);
  });

  it('writes inbox rows from fillSettled / p2pEscrowLocked / kycApproved and dedupes redelivery', async () => {
    const store = new MemoryNotifyStore();
    const notify = new NotifyService(store, { fanoutEnabled: true });
    const bus = new MemoryEventBus('test-producer');
    await subscribeNotificationEvents(bus, notify);

    const fillId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await bus.publish('fillSettled', {
      fillId,
      orderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      userId: USER,
      marketId: 'BTC-USD',
      side: 'buy',
      liquidity: 'taker',
      price: '100',
      qty: '0.5',
      quoteAmount: '50',
      feeAsset: 'USD',
      feeAmount: '0.05',
      feeBps: 10,
      sequence: 1,
      ts: new Date().toISOString(),
    });
    // Redelivery
    await bus.publish('fillSettled', {
      fillId,
      orderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      userId: USER,
      marketId: 'BTC-USD',
      side: 'buy',
      liquidity: 'taker',
      price: '100',
      qty: '0.5',
      quoteAmount: '50',
      feeAsset: 'USD',
      feeAmount: '0.05',
      feeBps: 10,
      sequence: 1,
      ts: new Date().toISOString(),
    });

    expect(await notify.unreadCount(USER)).toBe(1);
    const fills = await notify.list({ userId: USER, limit: 10, unreadOnly: false });
    expect(fills.items[0]!.sourceSubject).toBe(fillSettled.subject);
    expect(fills.items[0]!.sourceIdempotencyKey).toBe(fillId);
    expect(fills.items[0]!.titleKey).toBe('notify.trade.fill.title');
    expect(fills.items[0]!.bodyKey).toBe('notify.trade.fill.body');

    const tradeId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await bus.publish('p2pEscrowLocked', {
      tradeId,
      offerId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      sellerId: USER,
      buyerId: BUYER,
      asset: 'BTC',
      amount: '1',
      fiatCurrency: 'USD',
      fiatAmount: '50000',
      paymentDeadline: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(await notify.unreadCount(USER)).toBe(2);
    expect(await notify.unreadCount(BUYER)).toBe(1);
    expect(p2pEscrowLocked.subject).toContain('p2p');
    const escrow = (await notify.list({ userId: USER, limit: 10, unreadOnly: false })).items.find((n) => n.kind === 'p2p.escrow.locked');
    expect(escrow?.titleKey).toBe('notify.p2p.escrow.locked.title');
    expect(escrow?.bodyKey).toBe('notify.p2p.escrow.locked.body');

    await bus.publish('kycApproved', {
      userId: USER,
      tier: 'basic',
      jurisdiction: 'DE',
    });
    expect(await notify.unreadCount(USER)).toBe(3);
    expect(kycApproved.subject).toContain('identity');
    const kyc = (await notify.list({ userId: USER, limit: 10, unreadOnly: false })).items.find((n) => n.kind === 'identity.kyc.approved');
    expect(kyc?.titleKey).toBe('notify.identity.kyc.approved.title');
    expect(kyc?.bodyKey).toBe('notify.identity.kyc.approved.body');
  });

  it('writes inbox rows from rankUpdated / stakeCreated / p2pEscrowReleased and dedupes redelivery', async () => {
    const store = new MemoryNotifyStore();
    const notify = new NotifyService(store, { fanoutEnabled: true });
    const bus = new MemoryEventBus('test-producer');
    await subscribeNotificationEvents(bus, notify);

    await bus.publish('rankUpdated', {
      userId: USER,
      rank: 2,
      previousRank: 1,
      xp: '1500',
    });
    await bus.publish('rankUpdated', {
      userId: USER,
      rank: 2,
      previousRank: 1,
      xp: '1500',
    });
    expect(await notify.unreadCount(USER)).toBe(1);
    expect(rankUpdated.subject).toContain('identity');
    const rank = (await notify.list({ userId: USER, limit: 10, unreadOnly: false })).items.find((n) => n.kind === 'identity.rank.updated');
    expect(rank?.sourceSubject).toBe(rankUpdated.subject);
    expect(rank?.sourceIdempotencyKey).toBe(`${USER}:1:2`);
    expect(rank?.titleKey).toBe('notify.identity.rank.updated.title');
    expect(rank?.bodyKey).toBe('notify.identity.rank.updated.body');
    expect(rank?.params).toMatchObject({ rank: 2, previousRank: 1, xp: '1500' });

    const stakeId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await bus.publish('stakeCreated', {
      stakeId,
      userId: USER,
      amount: '100',
      tier: 'm3',
      unlocksAt: new Date(Date.now() + 86_400_000 * 90).toISOString(),
    });
    await bus.publish('stakeCreated', {
      stakeId,
      userId: USER,
      amount: '100',
      tier: 'm3',
      unlocksAt: new Date(Date.now() + 86_400_000 * 90).toISOString(),
    });
    expect(await notify.unreadCount(USER)).toBe(2);
    expect(stakeCreated.subject).toContain('token');
    const stake = (await notify.list({ userId: USER, limit: 10, unreadOnly: false })).items.find((n) => n.kind === 'token.stake.created');
    expect(stake?.sourceSubject).toBe(stakeCreated.subject);
    expect(stake?.sourceIdempotencyKey).toBe(stakeId);
    expect(stake?.titleKey).toBe('notify.token.stake.created.title');
    expect(stake?.bodyKey).toBe('notify.token.stake.created.body');
    expect(stake?.params).toMatchObject({ amount: '100', tier: 'm3' });

    const tradeId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await bus.publish('p2pEscrowReleased', {
      tradeId,
      sellerId: USER,
      buyerId: BUYER,
      asset: 'BTC',
      amount: '1',
      fee: '0.01',
      resolvedBy: 'seller',
      releaseSeconds: 120,
    });
    await bus.publish('p2pEscrowReleased', {
      tradeId,
      sellerId: USER,
      buyerId: BUYER,
      asset: 'BTC',
      amount: '1',
      fee: '0.01',
      resolvedBy: 'seller',
      releaseSeconds: 120,
    });
    expect(await notify.unreadCount(USER)).toBe(3);
    expect(await notify.unreadCount(BUYER)).toBe(1);
    expect(p2pEscrowReleased.subject).toContain('p2p');
    const released = (await notify.list({ userId: USER, limit: 10, unreadOnly: false })).items.find(
      (n) => n.kind === 'p2p.escrow.released',
    );
    expect(released?.sourceSubject).toBe(p2pEscrowReleased.subject);
    expect(released?.sourceIdempotencyKey).toBe(`${tradeId}:seller`);
    expect(released?.titleKey).toBe('notify.p2p.escrow.released.title');
    expect(released?.bodyKey).toBe('notify.p2p.escrow.released.body');
    const buyerReleased = (await notify.list({ userId: BUYER, limit: 10, unreadOnly: false })).items.find(
      (n) => n.kind === 'p2p.escrow.released',
    );
    expect(buyerReleased?.sourceIdempotencyKey).toBe(`${tradeId}:buyer`);
  });

  it('writes inbox rows from p2pEscrowRefunded for seller and buyer and dedupes redelivery', async () => {
    const store = new MemoryNotifyStore();
    const notify = new NotifyService(store, { fanoutEnabled: true });
    const bus = new MemoryEventBus('test-producer');
    await subscribeNotificationEvents(bus, notify);

    const tradeId = '12121212-1212-4121-8121-121212121212';
    const payload = {
      tradeId,
      sellerId: USER,
      buyerId: BUYER,
      asset: 'BTC' as const,
      amount: '2',
      resolvedBy: 'timeout' as const,
      reason: 'payment_deadline',
    };
    await bus.publish('p2pEscrowRefunded', payload);
    await bus.publish('p2pEscrowRefunded', payload);

    expect(await notify.unreadCount(USER)).toBe(1);
    expect(await notify.unreadCount(BUYER)).toBe(1);
    expect(p2pEscrowRefunded.subject).toContain('p2p');

    const sellerRow = (await notify.list({ userId: USER, limit: 10, unreadOnly: false })).items.find(
      (n) => n.kind === 'p2p.escrow.refunded',
    );
    expect(sellerRow?.sourceSubject).toBe(p2pEscrowRefunded.subject);
    expect(sellerRow?.sourceIdempotencyKey).toBe(`${tradeId}:seller`);
    expect(sellerRow?.titleKey).toBe('notify.p2p.escrow.refunded.title');
    expect(sellerRow?.bodyKey).toBe('notify.p2p.escrow.refunded.body');
    expect(sellerRow?.params).toMatchObject({ amount: '2', reason: 'payment_deadline', resolvedBy: 'timeout' });

    const buyerRow = (await notify.list({ userId: BUYER, limit: 10, unreadOnly: false })).items.find(
      (n) => n.kind === 'p2p.escrow.refunded',
    );
    expect(buyerRow?.sourceIdempotencyKey).toBe(`${tradeId}:buyer`);
  });

  it('writes inbox row from p2pTradeDisputed for openedBy only and dedupes redelivery', async () => {
    const store = new MemoryNotifyStore();
    const notify = new NotifyService(store, { fanoutEnabled: true });
    const bus = new MemoryEventBus('test-producer');
    await subscribeNotificationEvents(bus, notify);

    const tradeId = '34343434-3434-4343-8343-343434343434';
    const disputeId = '45454545-4545-4545-8545-454545454545';
    const payload = {
      tradeId,
      disputeId,
      openedBy: USER,
      reason: 'payment_not_received',
      moderatorDeadline: '2026-08-01T12:00:00.000Z',
    };
    await bus.publish('p2pTradeDisputed', payload);
    await bus.publish('p2pTradeDisputed', payload);

    expect(await notify.unreadCount(USER)).toBe(1);
    expect(await notify.unreadCount(BUYER)).toBe(0);
    expect(await notify.unreadCount(OTHER)).toBe(0);
    expect(p2pTradeDisputed.subject).toContain('p2p');

    const row = (await notify.list({ userId: USER, limit: 10, unreadOnly: false })).items.find((n) => n.kind === 'p2p.trade.disputed');
    expect(row?.sourceSubject).toBe(p2pTradeDisputed.subject);
    expect(row?.sourceIdempotencyKey).toBe(disputeId);
    expect(row?.titleKey).toBe('notify.p2p.trade.disputed.title');
    expect(row?.bodyKey).toBe('notify.p2p.trade.disputed.body');
    expect(row?.severity).toBe('action');
    expect(row?.params).toMatchObject({
      tradeId,
      disputeId,
      reason: 'payment_not_received',
      moderatorDeadline: '2026-08-01T12:00:00.000Z',
    });
  });

  it('acks bus events without writing when fan-out is off', async () => {
    const store = new MemoryNotifyStore();
    const notify = new NotifyService(store, { fanoutEnabled: false });
    const bus = new MemoryEventBus('test-producer');
    await subscribeNotificationEvents(bus, notify);

    await bus.publish('kycApproved', {
      userId: USER,
      tier: 'full',
      jurisdiction: 'GB',
    });
    await bus.publish('rankUpdated', {
      userId: USER,
      rank: 3,
      previousRank: 2,
      xp: '3000',
    });
    await bus.publish('stakeCreated', {
      stakeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: USER,
      amount: '50',
      tier: 'flex',
      unlocksAt: null,
    });
    await bus.publish('p2pEscrowRefunded', {
      tradeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sellerId: USER,
      buyerId: BUYER,
      asset: 'BTC',
      amount: '1',
      resolvedBy: 'buyer',
      reason: 'cancelled',
    });
    await bus.publish('p2pTradeDisputed', {
      tradeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      disputeId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      openedBy: USER,
      reason: 'no_release',
      moderatorDeadline: '2026-08-02T00:00:00.000Z',
    });
    expect(await notify.unreadCount(USER)).toBe(0);
  });
});
