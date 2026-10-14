// LOCAL TEST DATA for the Playwright harness: made-up users, orders and prices, not from any service. Shapes follow the real
// svc-notify router (services/svc-notify/src/router.ts). Times are built from "now" so relative labels are stable.
export const USER = '00000000-0000-4000-8000-000000000001';
export const BTC_MARKET = '0f7bf12e-3e49-4ad6-920f-25dc5c39e860';
export const ETH_MARKET = '5a0c9b1e-7d44-4c0b-9d1f-2f6a3c1b8e77';

export const markets = [
  { id: BTC_MARKET, symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, paper: false },
  { id: ETH_MARKET, symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', spot: true, paper: false },
];

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

export const fill = (n, minutes, readAt = null) => ({
  id: uuid(100 + n),
  userId: USER,
  kind: 'trade.fill',
  titleKey: 'notify.trade.fill.title',
  bodyKey: 'notify.trade.fill.body',
  title: 'Order filled',
  body: `buy 0.00015 on ${BTC_MARKET} at 64733.35.`,
  params: { qty: '0.00015', side: 'buy', price: '64733.35', fillId: uuid(300 + n), orderId: uuid(200 + n), marketId: BTC_MARKET },
  href: `/trade/orders/${uuid(200 + n)}`,
  severity: 'info',
  readAt,
  sourceSubject: 'intafaced.trade.fill.settled',
  sourceIdempotencyKey: uuid(300 + n),
  createdAt: ago(minutes),
});

export const cancelled = (n, minutes, readAt = null) => ({
  id: uuid(400 + n),
  userId: USER,
  kind: 'trade.order.terminal',
  titleKey: 'notify.trade.order.terminal.title',
  bodyKey: 'notify.trade.order.terminal.body',
  title: 'Order cancelled',
  body: `buy 0.00017 on ${BTC_MARKET} is cancelled.`,
  params: {
    ts: ago(minutes),
    qty: '0.00017',
    side: 'buy',
    type: 'limit',
    price: '30000',
    status: 'cancelled',
    orderId: uuid(500 + n),
    marketId: BTC_MARKET,
    filledQty: '0',
    clientOrderId: `desk:${uuid(600 + n)}`,
  },
  href: `/trade/orders/${uuid(500 + n)}`,
  severity: 'info',
  readAt,
  sourceSubject: 'intafaced.trade.order.updated',
  sourceIdempotencyKey: `${uuid(500 + n)}:cancelled`,
  createdAt: ago(minutes),
});

export const verified = (minutes, readAt = null) => ({
  id: uuid(700),
  userId: USER,
  kind: 'identity.kyc.approved',
  titleKey: 'notify.identity.kyc.approved.title',
  bodyKey: 'notify.identity.kyc.approved.body',
  title: 'Verification approved',
  body: 'Your verification was approved.',
  params: { tier: 'basic', jurisdiction: 'XX' },
  href: '/settings/verification',
  severity: 'action',
  readAt,
  sourceSubject: 'intafaced.identity.kyc.approved',
  sourceIdempotencyKey: `${USER}:basic`,
  createdAt: ago(minutes),
});

/** 12 notifications, newest first: 3 unread (a fill, a cancelled order, a fill), then read ones. */
export function inbox() {
  return [
    fill(1, 2),
    cancelled(1, 18),
    fill(2, 95),
    verified(60 * 30, ago(60 * 29)),
    ...Array.from({ length: 8 }, (_, i) => (i % 2 ? cancelled(10 + i, 60 * 40 + i * 30, ago(1)) : fill(10 + i, 60 * 40 + i * 30, ago(1)))),
  ];
}

export const channelsOff = [
  { channel: 'inapp', configured: true, available: true, reason: null, requires: [], socket: null },
  { channel: 'email', configured: false, available: false, reason: 'channel.not_configured', requires: [], socket: 'socket.notify-email' },
  { channel: 'push', configured: false, available: false, reason: 'channel.not_configured', requires: [], socket: 'socket.notify-push' },
  { channel: 'sms', configured: false, available: false, reason: 'channel.not_configured', requires: [], socket: 'socket.notify-sms' },
];
export const channelsEmail = channelsOff.map((row) =>
  row.channel === 'email' ? { ...row, configured: true, available: true, reason: null } : row,
);
