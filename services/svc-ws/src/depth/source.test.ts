import { describe, expect, it } from 'vitest';
import { DEPTH_MARKET_HALTED } from '../matching-trading.js';
import { DepthL3UnavailableError, DepthNoBookError, DepthSourceError, HttpDepthSource, parseNativeL3 } from './source.js';

/**
 * The wire between two of our own services is still a wire.
 *
 * Everything here is about refusing a response rather than coercing one. A
 * depth response with a JSON number in it would become a float the moment it
 * was parsed, and a float in an order book is wrong in a way that shows up
 * eighteen decimal places later — long after anyone would look here.
 */

function respondWith(body: unknown, status = 200): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;
}

const source = (fetchImpl: typeof globalThis.fetch) => new HttpDepthSource({ baseUrl: 'http://matching.test/', fetch: fetchImpl });

describe('HttpDepthSource', () => {
  it('reads a depth response into a DepthSnapshot', async () => {
    const s = source(respondWith({ marketId: 'BTC-USDT', bids: [['100.5', '2']], asks: [['101', '1.5']], sequence: 42 }));

    await expect(s.snapshot('BTC-USDT', 50)).resolves.toEqual({
      type: 'snapshot',
      marketId: 'BTC-USDT',
      sequence: 42,
      bids: [['100.5', '2']],
      asks: [['101', '1.5']],
    });
  });

  it('refuses a level carrying a JSON number instead of a decimal string', async () => {
    const s = source(respondWith({ bids: [[100.5, 2]], asks: [], sequence: 1 }));
    await expect(s.snapshot('BTC-USDT', 50)).rejects.toThrow(/decimal strings/);
  });

  it("does not leave a refused book's trading flag in trading()", async () => {
    // The halt rides on the same body as the ladder. A refused ladder must not
    // store that body's flag: a market with no prior flag stays unknown, and a
    // prior flag stays as it was. Do not invent OPEN, and do not serve the halt
    // from the body that was refused.
    const fresh = source(
      respondWith({
        marketId: 'BTC-USDT',
        sequence: 9,
        bids: [['100', '1']],
        asks: [['101', 1]],
        halted: true,
      }),
    );
    await expect(fresh.snapshot('BTC-USDT', 50)).rejects.toThrow(/decimal strings/);
    expect(fresh.trading('BTC-USDT')).toBeNull();

    let serveGood = true;
    const held = source((async () => {
      const body = serveGood
        ? {
            marketId: 'BTC-USDT',
            sequence: 4,
            bids: [['100', '1']],
            asks: [['101', '1']],
            halted: true,
          }
        : {
            marketId: 'BTC-USDT',
            sequence: 5,
            bids: [['100', '1']],
            asks: [['101', 1]],
            delisted: true,
          };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch);

    await expect(held.snapshot('BTC-USDT', 50)).resolves.toEqual({
      type: 'snapshot',
      marketId: 'BTC-USDT',
      sequence: 4,
      bids: [['100', '1']],
      asks: [['101', '1']],
    });
    expect(held.trading('BTC-USDT')).toBe(DEPTH_MARKET_HALTED);

    serveGood = false;
    await expect(held.snapshot('BTC-USDT', 50)).rejects.toThrow(/decimal strings/);
    expect(held.trading('BTC-USDT')).toBe(DEPTH_MARKET_HALTED);
  });

  it('refuses a response with no integer sequence', async () => {
    // Without the engine's sequence there is no safe delta stream at all, and
    // inventing one would produce a book that drifts silently.
    const s = source(respondWith({ bids: [], asks: [] }));
    await expect(s.snapshot('BTC-USDT', 50)).rejects.toThrow(/integer sequence/);
  });

  it('carries the upstream status on a failure so a caller can tell 404 from 500', async () => {
    const s = source(respondWith({ error: 'nope' }, 503));
    await expect(s.snapshot('BTC-USDT', 50)).rejects.toMatchObject({ name: 'DepthSourceError', status: 503 });
  });

  it('reports an unreachable upstream as unreachable, not as a bad response', async () => {
    const s = source((async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch);

    await expect(s.snapshot('BTC-USDT', 50)).rejects.toThrow(/svc-matching unreachable/);
    await expect(s.snapshot('BTC-USDT', 50)).rejects.toBeInstanceOf(DepthSourceError);
  });

  it('rejects a 200 whose body is not JSON as DepthSourceError', async () => {
    // A body that will not parse is not a book. Letting response.json() throw
    // SyntaxError would look like a bug here, and filling in a ladder, a price,
    // or a sequence would invent one matching never sent.
    for (const body of ['{', 'not-json']) {
      const s = source((async () => new Response(body, { status: 200 })) as typeof globalThis.fetch);
      await expect(s.snapshot('BTC-USDT', 50)).rejects.toBeInstanceOf(DepthSourceError);
      await expect(s.snapshot('BTC-USDT', 50)).rejects.not.toBeInstanceOf(SyntaxError);
    }
  });

  it('treats a 200 whose JSON value is null as DepthSourceError, and a 404 as DepthNoBookError', async () => {
    // response.json() of the JSON value null returns null without throwing.
    // That is a malformed success, not matching holding no book. A 404 is the
    // absence signal. Neither path may invent a ladder, a price, or a sequence.
    const nullBody = source(respondWith(null));
    await expect(nullBody.snapshot('BTC-USDT', 50)).rejects.toMatchObject({
      name: 'DepthSourceError',
      status: null,
    });
    await expect(nullBody.snapshot('BTC-USDT', 50)).rejects.not.toBeInstanceOf(DepthNoBookError);

    const missing = source(respondWith({ code: 'MarketNotFound' }, 404));
    await expect(missing.snapshot('BTC-USDT', 50)).rejects.toBeInstanceOf(DepthNoBookError);
  });

  it('sends no credential of any kind', async () => {
    const seen: RequestInit[] = [];
    const s = source((async (_url: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response(JSON.stringify({ markets: ['BTC-USDT'] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch);

    await s.markets();

    // The whole security argument for this service is that it holds nothing.
    // A header added here later would quietly undo it.
    const headers = seen[0]?.headers;
    expect(headers).toBeUndefined();
  });

  it('percent-encodes the market id into the path', async () => {
    const urls: string[] = [];
    const s = source((async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ bids: [], asks: [], sequence: 0 }), { status: 200 });
    }) as unknown as typeof globalThis.fetch);

    await s.snapshot('BTC/USDT', 25);

    expect(urls[0]).toBe('http://matching.test/markets/BTC%2FUSDT/depth?limit=25');
  });

  it('refuses a market list that is not a list of strings', async () => {
    const s = source(respondWith({ markets: [1, 2] }));
    await expect(s.markets()).rejects.toThrow(DepthSourceError);
  });

  /**
   * A LISTED MARKET WITH NO BOOK IS NOT A ZERO BOOK.
   *
   * svc-matching answers 404 when it holds no book — correctly: reading must
   * not allocate. Coercing that into `{ bids: [], asks: [], sequence: 0 }`
   * would let a client treat absence as a live empty ladder.
   */
  it('throws DepthNoBookError on an upstream 404 rather than fabricating an empty book', async () => {
    const s = source(respondWith({ code: 'MarketNotFound' }, 404));

    await expect(s.snapshot('7b64a76b-0000-0000-0000-000000000000', 50)).rejects.toMatchObject({
      name: 'DepthNoBookError',
      status: 404,
      marketId: '7b64a76b-0000-0000-0000-000000000000',
    });
    await expect(s.snapshot('7b64a76b-0000-0000-0000-000000000000', 50)).rejects.toBeInstanceOf(DepthNoBookError);
  });

  it('still fails loudly on every other upstream status', async () => {
    // Only 404 carries that meaning. A 500 is svc-matching being broken, and it
    // must never be drawn as a market that simply has no quotes.
    for (const status of [400, 500, 502, 503]) {
      const s = source(respondWith({ error: 'nope' }, status));
      await expect(s.snapshot('BTC-USDT', 50)).rejects.toMatchObject({ name: 'DepthSourceError', status });
    }
  });

  it('does not turn a 404 on the market list into an empty exchange', async () => {
    // "No book" is a fact about one market. A market list that 404s is a
    // misconfigured URL, and reporting it as zero markets would delist the fleet.
    const s = source(respondWith({}, 404));
    await expect(s.markets()).rejects.toThrow(/no market list/);
  });

  it('does not invent sequence 0 when matching has no book', async () => {
    const s = source(respondWith({ code: 'MarketNotFound' }, 404));
    await expect(s.snapshot('never-traded', 50)).rejects.toBeInstanceOf(DepthNoBookError);
  });

  it('reads matching native L3 from /depth/l3 — not /depth', async () => {
    const urls: string[] = [];
    const s = source((async (url: unknown) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          level: 'L3',
          marketId: 'BTC-USDT',
          bids: [],
          asks: [{ price: '100.5', orders: [{ orderId: 'o1', remaining: '1.25', sequence: 7 }] }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch);

    await expect(s.l3Queue('BTC-USDT', 50)).resolves.toEqual({
      level: 'L3',
      marketId: 'BTC-USDT',
      bids: [],
      asks: [{ price: '100.5', orders: [{ orderId: 'o1', remaining: '1.25', sequence: 7 }] }],
    });
    expect(urls).toEqual(['http://matching.test/markets/BTC-USDT/depth/l3?limit=50']);
  });

  it('refuses matching l3_unavailable and does not copy L2 tuples', async () => {
    const s = source(
      respondWith({ accepted: false, level: null, bids: [], asks: [], rejected: { code: 'l3_unavailable', message: 'no hitch' } }),
    );
    await expect(s.l3Queue('BTC-USDT', 50)).rejects.toBeInstanceOf(DepthL3UnavailableError);
  });

  it('refuses an L2-shaped body as L3 — never synthesizes queue from size tuples', () => {
    expect(() => parseNativeL3({ level: 'L2', bids: [['100', '3']], asks: [] }, 'BTC-USDT')).toThrow(DepthL3UnavailableError);
    expect(() => parseNativeL3({ bids: [['100', '3']], asks: [] }, 'BTC-USDT')).toThrow(DepthL3UnavailableError);
    expect(() => parseNativeL3({ level: 'L3', bids: [['100', '3']], asks: [] }, 'BTC-USDT')).toThrow(DepthL3UnavailableError);
  });

  it('refuses L3 remaining as a JSON number', () => {
    expect(() =>
      parseNativeL3(
        { level: 'L3', bids: [], asks: [{ price: '100', orders: [{ orderId: 'o1', remaining: 1.25, sequence: 1 }] }] },
        'BTC-USDT',
      ),
    ).toThrow(/decimal string/);
  });
});
