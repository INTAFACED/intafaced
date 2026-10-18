import { afterEach, describe, expect, it, vi } from 'vitest';
import { SERVICE_BODY_DIGEST_HEADER, SERVICE_HEADER, SERVICE_SIGNATURE_HEADER } from '@intafaced/contracts';
import { DarkTicketOrderSource, SUPPORT_ORDER_READ_PATH, createTicketOrderClient } from './ticket-order.js';

const ORDER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const SECRET = 'an-internal-service-secret-long-enough';

const snapshot = {
  orderId: ORDER,
  userId: USER,
  status: 'recovery_required',
  symbol: 'BTC/USDT',
  side: 'buy',
  filledQuantity: '0.00',
  feeAsset: 'USDT',
  feeAmount: '0.00',
};

function stubFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (url: unknown, init: unknown) => impl(String(url), (init ?? {}) as RequestInit));
  vi.stubGlobal('fetch', spy);
  return spy;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ticket order read port', () => {
  it('a dark source is unknown and does not invent cancelled', async () => {
    expect(await new DarkTicketOrderSource().read(ORDER)).toEqual({ kind: 'unknown', reason: 'trade_silent' });
  });

  it('an empty secret does not call trade', async () => {
    const spy = stubFetch(() => json(snapshot));
    const client = createTicketOrderClient('http://trade:4011', '');
    expect(await client.read(ORDER)).toEqual({ kind: 'unknown', reason: 'trade_silent' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('reads with GET and service credentials', async () => {
    const spy = stubFetch(() => json(snapshot));
    const client = createTicketOrderClient('http://trade:4011/', SECRET);
    expect(await client.read(ORDER)).toEqual({ kind: 'order', order: snapshot });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe(`http://trade:4011${SUPPORT_ORDER_READ_PATH}${ORDER}`);
    expect((init as RequestInit).method).toBe('GET');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers[SERVICE_HEADER]).toBe('svc-support');
    expect(headers[SERVICE_SIGNATURE_HEADER]).toBeTruthy();
    expect(headers[SERVICE_BODY_DIGEST_HEADER]).toBeTruthy();
  });

  it('matcher down is unknown and does not send a delete', async () => {
    const spy = stubFetch(() => json({ code: 'matcher_down' }, 503));
    const client = createTicketOrderClient('http://trade:4011', SECRET);
    expect(await client.read(ORDER)).toEqual({ kind: 'unknown', reason: 'matcher_down' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0]![1] as RequestInit).method).toBe('GET');
  });

  it('a named matcher_down on a failed response is unknown', async () => {
    const spy = stubFetch(() => json({ code: 'matcher_down' }, 502));
    expect(await createTicketOrderClient('http://trade:4011', SECRET).read(ORDER)).toEqual({
      kind: 'unknown',
      reason: 'matcher_down',
    });
    expect((spy.mock.calls[0]![1] as RequestInit).method).toBe('GET');
  });

  it('silence, a bad shape, and a JSON number are unknown, not cancelled', async () => {
    const cases: Array<[string, () => Response | Promise<Response>]> = [
      ['transport', () => Promise.reject(new Error('ECONNREFUSED'))],
      ['not json', () => new Response('nope', { status: 200 })],
      ['fee amount as a number', () => json({ ...snapshot, feeAmount: 0 })],
      ['filled quantity as a number', () => json({ ...snapshot, filledQuantity: 0 })],
      ['different order id', () => json({ ...snapshot, orderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })],
      ['status missing', () => json({ orderId: ORDER, userId: USER })],
    ];
    for (const [name, impl] of cases) {
      stubFetch(impl);
      expect(await createTicketOrderClient('http://trade:4011', SECRET).read(ORDER), name).toEqual({
        kind: 'unknown',
        reason: 'trade_silent',
      });
      vi.unstubAllGlobals();
    }
  });

  it('encodes the order id into the path', async () => {
    const spy = stubFetch(() => json({ ...snapshot, orderId: ORDER }));
    await createTicketOrderClient('http://trade:4011', SECRET).read(ORDER);
    expect(String(spy.mock.calls[0]![0])).toBe(`http://trade:4011/internal/orders/${ORDER}`);
  });
});
