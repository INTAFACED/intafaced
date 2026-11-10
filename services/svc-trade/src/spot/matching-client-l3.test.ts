/** MatchingClient.l3Queue: the native L3 door only. A refused L3, a 5xx or a body without the book sequence is
 * `trade.queue_unavailable`; a 404 is no book; nothing ever comes back from the L2 /depth door. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMatchingClient, MatchingNoBookError, MatchingUnavailableError } from './matching-client.js';

const SECRET = 'matching-client-l3-test-secret-32-chars-xx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }),
  );
  return calls;
}

const L3 = {
  level: 'L3',
  marketId: 'm-1',
  sequence: 9,
  bids: [{ price: '100', orders: [{ orderId: 'o-1', remaining: '1', sequence: 3 }] }],
  asks: [],
};

describe('MatchingClient.l3Queue', () => {
  it('reads /depth/l3 with the asked limit and returns the queue with its sequence', async () => {
    const calls = stubFetch(200, L3);
    const queue = await createMatchingClient('http://matching.test', SECRET).l3Queue!('m-1', 500);
    expect(calls).toEqual(['http://matching.test/markets/m-1/depth/l3?limit=500']);
    expect(queue.sequence).toBe(9);
    expect(queue.bids[0]!.orders[0]!.orderId).toBe('o-1');
  });

  it.each([
    ['a refused L3', 200, { accepted: false, level: null, bids: [], asks: [], rejected: { code: 'l3_unavailable' } }],
    ['an L2-shaped body', 200, { marketId: 'm-1', bids: [['100', '1']], asks: [], sequence: 9 }],
    ['an L3 body without its sequence', 200, { ...L3, sequence: undefined }],
    ['a 5xx', 503, 'down'],
  ])('%s is trade.queue_unavailable', async (_name, status, body) => {
    stubFetch(status, body);
    const read = createMatchingClient('http://matching.test', SECRET).l3Queue!('m-1', 500);
    await expect(read).rejects.toBeInstanceOf(MatchingUnavailableError);
    await expect(read).rejects.toMatchObject({ code: 'trade.queue_unavailable' });
  });

  it('a 404 is no book', async () => {
    stubFetch(404, { code: 'MarketNotFound' });
    await expect(createMatchingClient('http://matching.test', SECRET).l3Queue!('m-1', 500)).rejects.toBeInstanceOf(MatchingNoBookError);
  });
});
