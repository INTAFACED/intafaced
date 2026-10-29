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
    const read = await sources.outsideBalance(readAt, 'test');
    expect(read).toEqual({ kind: 'snapshot', asOf: '2026-10-29T11:59:00.000Z', balances: [{ assetId: 'USDT', amount: '-125.50' }] });
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.pathname).toBe('/rails');
    expect(fetch.calls[0]!.searchParams.get('rail')).toBe('test');
    expect(fetch.calls[0]!.searchParams.get('asOf')).toBe(readAt.toISOString());
  });

  it('is unset for a rail with no URL and never falls back to the whole-book snapshot', async () => {
    const fetch = fakeFetch(() => json({ source: 'rail', asOf: '2026-10-29T11:59:00.000Z', balances: [] }));
    const sources = reconciliationSourcesFrom('http://127.0.0.1:9/book', new Map([['test', 'http://127.0.0.1:9/rails']]), fetch.impl);
    expect(await sources.outsideBalance(readAt, 'crypto-native')).toEqual({ kind: 'unset' });
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
      expect(await sources.outsideBalance(readAt, 'test')).toEqual({ kind: 'unavailable' });
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
