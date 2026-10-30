import { describe, expect, it } from 'vitest';
import { notifyCopy } from './copy';
import type { Notification } from './notify-api';
import { carriesFigure, describe as describeNotification, linkFor, whenLabel, type NotifyMarket } from './notify-view';

const BTC_ID = '0f7bf12e-3e49-4ad6-920f-25dc5c39e860';
const markets = new Map<string, NotifyMarket>([[BTC_ID, { id: BTC_ID, base: 'BTC', quote: 'USDT' }]]);
const copy = notifyCopy;

const base: Notification = {
  id: '971d3bb5-edb2-40a1-b653-4741f2277d5b',
  userId: 'u',
  kind: 'trade.fill',
  titleKey: 'notify.trade.fill.title',
  bodyKey: 'notify.trade.fill.body',
  title: 'Order filled',
  body: `buy 0.00015 on ${BTC_ID} at 64733.35.`,
  params: { qty: '0.00015', side: 'buy', price: '64733.35', fillId: 'f', orderId: 'o', marketId: BTC_ID },
  href: '/trade/orders/o',
  severity: 'info',
  readAt: null,
  createdAt: '2026-10-13T19:49:41.524Z',
};

describe('describe', () => {
  it('writes a fill from its params, with the coin and the price in its quote coin, never the market id', () => {
    const text = describeNotification(base, markets, copy);
    expect(text.title).toBe('Order filled');
    expect(text.body).toBe('Bought 0.00015 BTC at 64,733.35 USDT');
    expect(text.icon).toBe('fill');
    expect(JSON.stringify(text)).not.toContain(BTC_ID);
  });

  it('says a sell as a sell, and falls back to a plain line while the market name is unknown', () => {
    expect(describeNotification({ ...base, params: { ...base.params, side: 'sell' } }, markets, copy).body).toBe(
      'Sold 0.00015 BTC at 64,733.35 USDT',
    );
    expect(describeNotification(base, new Map(), copy).body).toBe('Your buy order was filled.');
  });

  it('describes a cancelled limit order with its price, and says so only when part of it filled', () => {
    const cancelled: Notification = {
      ...base,
      kind: 'trade.order.terminal',
      title: 'Order cancelled',
      params: {
        status: 'cancelled',
        side: 'buy',
        type: 'limit',
        qty: '0.00017',
        price: '30000',
        filledQty: '0',
        marketId: BTC_ID,
        orderId: 'o',
      },
    };
    const text = describeNotification(cancelled, markets, copy);
    expect(text.title).toBe('Order cancelled');
    expect(text.body).toBe('Buy 0.00017 BTC at 30,000 USDT');
    expect(
      describeNotification({ ...cancelled, params: { ...cancelled.params, filledQty: '0.00005', status: 'expired' } }, markets, copy),
    ).toMatchObject({
      title: 'Order expired',
      body: 'Buy 0.00017 BTC at 30,000 USDT · 0.00005 filled',
    });
  });

  it('keeps a quote asset that is not a dollar coin as a unit after the price', () => {
    const eth = new Map([[BTC_ID, { id: BTC_ID, base: 'ETH', quote: 'BTC' }]]);
    expect(describeNotification(base, eth, copy).body).toBe('Bought 0.00015 ETH at 64,733.35 BTC');
  });

  it('uses a clean service sentence for other kinds, but never a catalogue key or an id', () => {
    const other: Notification = { ...base, kind: 'something.new', title: 'Welcome aboard', body: 'Thanks for joining.' };
    expect(describeNotification(other, markets, copy)).toMatchObject({
      title: 'Welcome aboard',
      body: 'Thanks for joining.',
      icon: 'bell',
    });
    const raw: Notification = { ...other, title: 'notify.something.new.title', body: `Thing ${BTC_ID}` };
    expect(describeNotification(raw, markets, copy)).toMatchObject({ title: 'Account update', body: '' });
  });
});

describe('linkFor', () => {
  it('opens a fill in Activity Trades and an ended order in Activity Orders', () => {
    expect(linkFor(base)).toBe('/money/activity?tab=trades');
    expect(linkFor({ kind: 'trade.order.terminal', href: '/trade/orders/o' })).toBe('/money/activity?tab=orders');
  });
  it('filters a fill to its coin when the market is known; an ended order gets no coin filter (Orders has none)', () => {
    expect(linkFor(base, markets)).toBe('/money/activity?tab=trades&asset=BTC');
    expect(linkFor({ ...base, kind: 'trade.order.terminal', params: { marketId: BTC_ID } }, markets)).toBe('/money/activity?tab=orders');
    expect(linkFor({ ...base, params: { marketId: 'unknown' } }, markets)).toBe('/money/activity?tab=trades');
  });
  it('opens verification and rank on live screens', () => {
    expect(linkFor({ kind: 'identity.kyc.approved', href: '/settings/verification' })).toBe('/verification');
    expect(linkFor({ kind: 'identity.rank.updated', href: '/profile/rank' })).toBe('/uc/account');
  });
  // Every target svc-notify emits today (services/svc-notify/src/events.ts, market-halt-notice.ts, alerts/service.ts).
  it('opens a live room for every target svc-notify emits', () => {
    const emitted: Array<[string, string]> = [
      ['/trade/orders/o1', '/trade/orders/o1'],
      ['/trade/futures', '/trade/futures'],
      ['/p2p/orders/t1', '/p2p/orders/t1'],
      ['/uc/ad', '/uc/ad'],
      ['/verification', '/verification'],
      ['/uc/safe', '/uc/safe'],
      ['/uc/account', '/uc/account'],
      ['/token', '/token'],
      ['/pay/request/r1', '/pay/request/r1'],
      ['/money/activity?tab=transfers', '/money/activity?tab=transfers'],
      ['/uc/recharge?asset=BTC&network=btc', '/uc/recharge?asset=BTC&network=btc'],
      ['/bank/transfers', '/bank/transfers'],
      ['/support', '/support'],
      // The detail rows IA-SPEC gives other modules, with no room yet: their list room.
      ['/bank/loans/l1', '/bank/loans'],
      ['/agents/sessions/s1', '/agents'],
      // A market by its id: its desk when the market is known, else Markets.
      [`/trade/${BTC_ID}`, '/trade/spot/BTC-USDT'],
      [`/markets/${BTC_ID}`, '/trade/spot/BTC-USDT'],
    ];
    for (const [href, room] of emitted) expect(linkFor({ kind: 'x', href }, markets), href).toBe(room);
    expect(linkFor({ kind: 'x', href: '/markets/unknown' }, markets)).toBe('/trade');
    expect(linkFor({ kind: 'x', href: `/trade/${BTC_ID}` })).toBe('/trade');
  });
  // Rows stored before svc-notify moved its targets (#5435) are never rewritten: each still opens a live room.
  it('opens a live room for a stored old-style link', () => {
    expect(linkFor({ kind: 'p2p.escrow.locked', href: '/p2p/trades/t1' })).toBe('/p2p/orders/t1');
    expect(linkFor({ kind: 'x', href: '/settings/verification' })).toBe('/verification');
    expect(linkFor({ kind: 'x', href: '/profile/rank' })).toBe('/uc/account');
    expect(linkFor({ kind: 'x', href: '/token/stakes/s1' })).toBe('/token/stakes/s1');
    expect(linkFor({ kind: 'x', href: '/trade/futures/positions/p1' })).toBe('/trade/futures');
  });
  it('gives no link to an unknown or outside address', () => {
    expect(linkFor({ kind: 'x', href: null })).toBeNull();
    expect(linkFor({ kind: 'x', href: '//evil.example/path' })).toBeNull();
    expect(linkFor({ kind: 'x', href: '/p2p/trades/a\\b' })).toBeNull();
    expect(linkFor({ kind: 'x', href: '/nowhere/at/all' })).toBeNull();
  });
});

describe('whenLabel', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  it('counts up from "Just now"', () => {
    expect(whenLabel(at(0), now, 'device', copy)).toBe('Just now');
    expect(whenLabel(at(5), now, 'device', copy)).toBe('5 min ago');
    expect(whenLabel(at(125), now, 'device', copy)).toBe('2 h ago');
    expect(whenLabel(at(60 * 30), now, 'device', copy)).toBe('Yesterday');
  });
  it('then shows the date in the picked zone, and "—" for an unreadable time', () => {
    expect(whenLabel('2026-10-10T23:30:00Z', now, 'UTC+8', copy)).toBe('11 Oct, 07:30 UTC+8');
    expect(whenLabel('not a date', now, 'device', copy)).toBe('—');
  });
});

describe('carriesFigure', () => {
  it('is true for a row that names an amount or a quantity', () => {
    expect(carriesFigure({ params: { asset: 'USDT', amount: '100' } })).toBe(true);
    expect(carriesFigure({ params: { qty: '0.5' } })).toBe(true);
  });
  it('is false for a row with no figure, or a figure that is not a decimal', () => {
    expect(carriesFigure({ params: {} })).toBe(false);
    expect(carriesFigure({ params: { amount: '' } })).toBe(false);
    expect(carriesFigure({ params: { amount: 100 } })).toBe(false);
    expect(carriesFigure({ params: { amount: 'lots' } })).toBe(false);
  });
});
