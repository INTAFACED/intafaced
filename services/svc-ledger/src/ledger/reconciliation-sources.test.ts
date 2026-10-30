import { describe, expect, it } from 'vitest';
import { reconciliationSourcesFrom } from './reconciliation-sources.js';

const readAt = new Date('2026-10-29T12:00:00.000Z');
const statement = (over: Record<string, unknown> = {}) => ({
  source: 'rail',
  rail: 'test',
  asOf: '2026-10-29T11:59:00.000Z',
  balances: [{ assetId: 'USDT', amount: '-125.50' }],
  ...over,
});

function fakeFetch(answer: (url: URL) => Response) {
  const calls: URL[] = [];
  const impl = (async (input: URL) => {
    calls.push(input);
    return answer(input);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('per-rail outside statements', () => {
  it("reads only the named rail's URL with rail and as-of, and keeps the signed amount as given", async () => {
    const fetch = fakeFetch(() => json(statement()));
    const sources = reconciliationSourcesFrom('http://127.0.0.1:9/book', new Map([['test', 'http://127.0.0.1:9/rails']]), fetch.impl);
    const read = await sources.railStatement(readAt, 'test');
    expect(read).toEqual({ kind: 'snapshot', asOf: '2026-10-29T11:59:00.000Z', balances: [{ assetId: 'USDT', amount: '-125.50' }] });
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.pathname).toBe('/rails');
    expect(fetch.calls[0]!.searchParams.get('rail')).toBe('test');
    expect(fetch.calls[0]!.searchParams.get('asOf')).toBe(readAt.toISOString());
  });

  it('is unset for a rail with no URL and never falls back to the whole-book snapshot', async () => {
    const fetch = fakeFetch(() => json({ source: 'rail', asOf: '2026-10-29T11:59:00.000Z', balances: [] }));
    const sources = reconciliationSourcesFrom('http://127.0.0.1:9/book', new Map([['test', 'http://127.0.0.1:9/rails']]), fetch.impl);
    expect(await sources.railStatement(readAt, 'crypto-native')).toEqual({ kind: 'unset' });
    expect(fetch.calls).toHaveLength(0);
  });

  it('is unavailable for a statement of another rail, a late as-of, a non-200, a malformed body or a failed fetch', async () => {
    const urls = new Map([['test', 'http://127.0.0.1:9/rails']]);
    const answers: Array<() => Response> = [
      () => json(statement({ rail: 'crypto-native' })),
      () => json(statement({ asOf: '2026-10-29T12:00:01.000Z' })),
      () => json(statement(), 503),
      () => json(statement({ balances: [{ assetId: 'USDT', amount: 12.5 }] })),
      () => json(statement({ extra: true })),
      () => {
        throw new Error('refused');
      },
    ];
    for (const answer of answers) {
      const sources = reconciliationSourcesFrom(undefined, urls, fakeFetch(answer).impl);
      expect(await sources.railStatement(readAt, 'test')).toEqual({ kind: 'unavailable' });
    }
  });

  it('keeps the whole-book snapshot read unchanged when no rail is named', async () => {
    const fetch = fakeFetch(() => json({ source: 'rail', asOf: '2026-10-29T11:00:00.000Z', balances: [{ assetId: 'BTC', amount: '2' }] }));
    const sources = reconciliationSourcesFrom('http://127.0.0.1:9/book', new Map([['test', 'http://127.0.0.1:9/rails']]), fetch.impl);
    expect((await sources.outsideBalance(readAt)).kind).toBe('snapshot');
    expect(fetch.calls[0]!.pathname).toBe('/book');
    expect(fetch.calls[0]!.searchParams.has('rail')).toBe(false);
    expect(await reconciliationSourcesFrom(undefined, new Map(), fetch.impl).outsideBalance(readAt)).toEqual({ kind: 'unset' });
  });
});

describe('per-rail open items (lead ruling 2026-10-30)', () => {
  const item = (id: string, signedAmount: string) => ({
    depositId: id,
    kind: signedAmount.startsWith('-') ? 'reversal_unfunded' : 'held',
    userId: 'u-1',
    assetId: 'USDT',
    networkId: 'ethereum',
    txHash: `0x${id}`,
    outputIndex: 0,
    amount: signedAmount.replace('-', ''),
    signedAmount,
    status: signedAmount.startsWith('-') ? 'needs_review' : 'held_travel_rule',
    reason: signedAmount.startsWith('-') ? 'reversal_unfunded' : null,
    detectedAt: '2026-10-29T11:00:00.000Z',
  });
  const sums = (held: string, unfunded: string, net: string) => [
    { networkId: 'ethereum', assetId: 'USDT', held, heldCount: 1, reversalUnfunded: unfunded, reversalUnfundedCount: 1, net },
  ];
  const urls = new Map([['test', 'http://127.0.0.1:9/items']]);
  function postFetch(answer: (body: { offset: number; limit: number }) => Response) {
    const bodies: string[] = [];
    const headers: Array<Record<string, string>> = [];
    const impl = (async (_input: string, init: RequestInit) => {
      bodies.push(String(init.body));
      headers.push(init.headers as Record<string, string>);
      return answer(JSON.parse(String(init.body)));
    }) as unknown as typeof fetch;
    return { impl, bodies, headers };
  }
  const sign = (payload: string) => ({ 'x-signed': payload });

  it('pages through every item, signs each exact body, and names each by id with its signed amount', async () => {
    const all = Array.from({ length: 201 }, (_, i) => item(`d${i}`, '1'));
    const fetch = postFetch(({ offset, limit }) =>
      json({ items: all.slice(offset, offset + limit), total: 201, sums: sums('201', '0', '201') }),
    );
    const read = await reconciliationSourcesFrom(undefined, new Map(), fetch.impl, 1000, { urls, sign }).openItems!('test');
    expect(read.kind).toBe('items');
    expect(read.items).toHaveLength(201);
    expect(read.items![200]).toEqual({ source: 'svc-pay', id: 'd200', kind: 'held', assetId: 'USDT', amount: '1' });
    expect(fetch.bodies).toEqual([
      JSON.stringify({ rail: 'test', offset: 0, limit: 200 }),
      JSON.stringify({ rail: 'test', offset: 200, limit: 200 }),
    ]);
    expect(fetch.headers.map((h) => h['x-signed'])).toEqual(fetch.bodies);
  });

  it('is unset for a rail with no URL or no source, and reads nothing', async () => {
    const fetch = postFetch(() => json({}));
    expect(await reconciliationSourcesFrom(undefined, new Map(), fetch.impl, 1000, { urls, sign }).openItems!('crypto-native')).toEqual({
      kind: 'unset',
    });
    expect(await reconciliationSourcesFrom(undefined, new Map(), fetch.impl).openItems!('test')).toEqual({ kind: 'unset' });
    expect(fetch.bodies).toHaveLength(0);
  });

  it('is unavailable, never a partial list, on a refusal, a bad body, a total or sums that move between pages, or items that miss the sums', async () => {
    const two = [item('a', '5'), item('b', '-2')];
    let page = 0;
    const answers: Array<(b: { offset: number; limit: number }) => Response> = [
      () => json({ error: 'pay.unauthenticated' }, 401),
      () => json({ items: two, total: 2, sums: sums('5', '2', '3'), extra: 1 }),
      () => {
        throw new Error('refused');
      },
      // The items add up to 3, the sums claim 4: the list is not the whole of them.
      () => json({ items: two, total: 2, sums: sums('6', '2', '4') }),
      // The total says 3 but only two items ever come.
      () => json({ items: page++ === 0 ? two : [], total: 3, sums: sums('5', '2', '3') }),
      // A duplicate id across pages.
      () => json({ items: [item('a', '5'), item('a', '5')], total: 2, sums: sums('10', '0', '10') }),
      // More than the cap: refused, not truncated.
      () => json({ items: [], total: 2001, sums: [] }),
    ];
    for (const answer of answers) {
      const read = await reconciliationSourcesFrom(undefined, new Map(), postFetch(answer).impl, 1000, { urls, sign }).openItems!('test');
      expect(read).toEqual({ kind: 'unavailable' });
    }
    // The total moves between page one and page two.
    const moving = postFetch(({ offset }) =>
      offset === 0
        ? json({ items: Array.from({ length: 200 }, (_, i) => item(`m${i}`, '1')), total: 201, sums: sums('201', '0', '201') })
        : json({ items: [item('m200', '1')], total: 202, sums: sums('202', '0', '202') }),
    );
    expect(await reconciliationSourcesFrom(undefined, new Map(), moving.impl, 1000, { urls, sign }).openItems!('test')).toEqual({
      kind: 'unavailable',
    });
  });
});
