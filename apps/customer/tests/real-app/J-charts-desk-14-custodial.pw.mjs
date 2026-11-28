// World: book
import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { api, otherTrader } from './stack.mjs';
import { awayBid, signUp, verify } from './desk.mjs';

// J-charts-desk-14's check of today's engine queue read, on our own BTC/USDT book: it works only while our own book runs,
// the custodial layer. The step itself, #8 (my place in the queue and the fill chance, read from the venue's own book), is
// proven custody off in J-charts-desk-14.pw.mjs. As a custodial part file this keeps today's custody switch
// (launch-custody.mjs CUSTODIAL_PART): its other person is the stack's TEST taker account, which the TEST market maker
// makes only with our own book on.
const J = 'J-charts-desk-14';
const SYMBOL = 'BTC/USDT';
const SMALL = '0.001';

test(`${J}, part of #8, checked on today's engine: another person's order id refuses exactly as one that does not exist, its owner reads it, and once cancelled it is not open`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  // A verified TEST account of my own, funded with nothing: the queue read needs only my session.
  const me = await signUp(page, 'jcd14e');
  await verify(page, me);
  const other = await api(otherTrader());
  const engine = await api(me);
  const away = await awayBid(85, SYMBOL);
  const rested = await other.post('/api/v1/orders', {
    symbol: SYMBOL,
    type: 'limit',
    side: 'buy',
    price: away,
    amount: SMALL,
    timeInForce: 'GTC',
    clientOrderId: `jcd14-q8-other-${randomBytes(4).toString('hex')}`,
  });
  expect(rested.status, JSON.stringify(rested.body).slice(0, 300)).toBeLessThan(300);
  const theirId = rested.body.id;
  let cancelled = false;
  try {
    const own = await other.get(`/api/v1/orders/${theirId}/queue`);
    expect(own.status, JSON.stringify(own.body).slice(0, 300)).toBe(200);
    const foreign = await engine.get(`/api/v1/orders/${theirId}/queue`);
    const missing = await engine.get(`/api/v1/orders/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/queue`);
    expect(foreign.status).toBe(404);
    expect(foreign.body.intafacedCode).toBe('trade.order_not_found');
    expect([missing.status, missing.body.intafacedCode]).toEqual([foreign.status, foreign.body.intafacedCode]);
    const del = await other.delete(`/api/v1/orders/${theirId}?symbol=${encodeURIComponent(SYMBOL)}`);
    expect(del.status, JSON.stringify(del.body).slice(0, 300)).toBeLessThan(300);
    cancelled = true;
    const closed = await other.get(`/api/v1/orders/${theirId}/queue`);
    expect(closed.status).toBe(409);
    expect(closed.body.intafacedCode).toBe('trade.order_not_open');
  } finally {
    if (!cancelled) await other.delete(`/api/v1/orders/${theirId}?symbol=${encodeURIComponent(SYMBOL)}`).catch(() => undefined);
  }
});
