import { describe, expect, it } from 'vitest';
import { HttpTradeCancelPort } from './cod-cancel.js';
import { targetsFromCancel } from './cod.js';

describe('HttpTradeCancelPort', () => {
  it('maps 200 order list to reached ids', async () => {
    const port = new HttpTradeCancelPort({
      baseUrl: 'http://trade.test',
      fetch: async (input) => {
        expect(String(input)).toBe('http://trade.test/api/v1/orders');
        return new Response(JSON.stringify([{ id: 'o1' }, { orderId: 'o2' }]), { status: 200 });
      },
    });
    await expect(port.cancelAll({ accessToken: 'tok' })).resolves.toEqual({
      reached: true,
      status: 200,
      orders: [{ orderId: 'o1' }, { orderId: 'o2' }],
    });
  });

  it('network failure is not an invented empty cancel set', async () => {
    const port = new HttpTradeCancelPort({
      baseUrl: 'http://trade.test',
      fetch: async () => {
        throw new Error('down');
      },
    });
    await expect(port.cancelAll({ accessToken: 'tok' })).resolves.toEqual({
      reached: false,
      reason: 'cod.trade_not_reached',
    });
  });

  it('forwards market scope as symbol without claiming success on 503', async () => {
    const port = new HttpTradeCancelPort({
      baseUrl: 'http://trade.test',
      fetch: async (input) => {
        expect(String(input)).toContain('symbol=BTC-USDT');
        return new Response('no', { status: 503 });
      },
    });
    await expect(port.cancelAll({ accessToken: 'tok', marketId: 'BTC-USDT' })).resolves.toEqual({
      reached: true,
      status: 503,
      orders: [],
    });
  });

  it('a 200 array of junk objects is not a completed cancel, and an order id still returns', async () => {
    const junk = new HttpTradeCancelPort({
      baseUrl: 'http://trade.test',
      fetch: async () => new Response(JSON.stringify([{ nope: 1 }, { id: 2 }, null, 'x']), { status: 200 }),
    });
    const junkResult = await junk.cancelAll({ accessToken: 'tok' });
    expect(junkResult).toEqual({ reached: true, status: 200, orders: [] });
    const mapped = targetsFromCancel({ scope: 'account', result: junkResult });
    expect(mapped.tradeReached).toBe(true);
    expect(mapped.complete).toBe(false);
    expect(mapped.targets.filter((target) => target.outcome === 'APPLIED')).toEqual([]);

    const named = new HttpTradeCancelPort({
      baseUrl: 'http://trade.test',
      fetch: async () => new Response(JSON.stringify([{ orderId: 'ord-9' }]), { status: 200 }),
    });
    const namedResult = await named.cancelAll({ accessToken: 'tok' });
    expect(namedResult).toEqual({
      reached: true,
      status: 200,
      orders: [{ orderId: 'ord-9' }],
    });
    expect(targetsFromCancel({ scope: 'account', result: namedResult })).toEqual({
      tradeReached: true,
      complete: true,
      targets: [{ selector: 'ord-9', outcome: 'APPLIED' }],
    });
  });
});
