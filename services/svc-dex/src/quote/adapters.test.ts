import { describe, expect, it } from 'vitest';
import { formatAmount } from '@intafaced/ledger-client/money';
import { IndexerQuoteVenue } from './indexer-venue.js';
import { MatchingQuoteVenue } from './matching-venue.js';
import { ExternalQuoteVenue, externalVenueConfigSchema, renderDepthUrl } from './external-venue.js';
import { parseLevels } from './wire.js';
import { VenueUnavailableError } from './venue.js';

/**
 * THE ADAPTERS, AGAINST A WIRE THAT MISBEHAVES.
 *
 * Every venue here answers over HTTP, so every one of them can be handed a
 * response that is late, wrong, empty, or subtly float-shaped. These drive the
 * real adapters with a fake `fetch` and assert the same thing throughout: a
 * response that cannot be trusted becomes a typed refusal, never a book.
 */

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const status = (code: number) => new Response('nope', { status: code });

/** Records the URLs and headers an adapter asked for. */
function recorder(handler: (url: string) => Response) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(url);
  }) as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

const levels = (l: readonly (readonly [string, string])[]) => l.map((x) => [...x]);

async function refusal(promise: Promise<unknown>): Promise<VenueUnavailableError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof VenueUnavailableError) return err;
    throw err;
  }
  throw new Error('expected a VenueUnavailableError, got a book');
}

// ── The wire ─────────────────────────────────────────────────────────────────

describe('a book is read off a wire suspiciously', () => {
  it('REFUSES a level carrying JSON numbers — the reason there is no ccxt client here', () => {
    // CCXT parses every venue's decimal strings into floats before a caller
    // sees them. This is the check that would have caught that, and it is why
    // these adapters read the venue's own strings instead.
    expect(() => parseLevels([[30000.5, 2.25]], 'asks', 'v')).toThrow(/not a pair of strings/);
  });

  it('refuses a malformed level rather than skipping it', () => {
    // Skipping would silently thin the book and quote a worse price as a better one.
    expect(() => parseLevels([['100']], 'asks', 'v')).toThrow(/not a \[price, quantity\] pair/);
    expect(() => parseLevels([['1e5', '2']], 'asks', 'v')).toThrow(/not a pair of decimal strings/);
    expect(() => parseLevels([['0', '2']], 'asks', 'v')).toThrow(/non-positive price/);
  });

  it('sorts asks ascending and bids descending, whatever order they arrived in', () => {
    // A sweep walks in order and stops when filled. Out-of-order levels produce
    // a cost that is confidently wrong, with no error anywhere.
    const asks = parseLevels(
      levels([
        ['102', '1'],
        ['100', '1'],
        ['101', '1'],
      ]),
      'asks',
      'v',
    );
    const bids = parseLevels(
      levels([
        ['98', '1'],
        ['100', '1'],
        ['99', '1'],
      ]),
      'bids',
      'v',
    );

    expect(asks.map((l) => formatAmount(l[0]))).toEqual(['100', '101', '102']);
    expect(bids.map((l) => formatAmount(l[0]))).toEqual(['100', '99', '98']);
  });

  it('drops empty levels, because a level with nothing on it is not depth', () => {
    expect(
      parseLevels(
        levels([
          ['100', '0'],
          ['101', '2'],
        ]),
        'asks',
        'v',
      ),
    ).toHaveLength(1);
  });
});

// ── svc-indexer: the on-chain book ───────────────────────────────────────────

const indexerVenue = (handler: (url: string) => Response, region?: string) => {
  const { calls, fetchImpl } = recorder(handler);
  const venue = new IndexerQuoteVenue({
    baseUrl: 'http://svc-indexer:4013',
    timeoutMs: 2_000,
    quoteTtlMs: 2_000,
    feeBps: 0,
    settlementCost: 0n,
    fetch: fetchImpl,
    ...(region ? { region } : {}),
  });
  return { venue, calls };
};

const trpc = (data: unknown) => ok({ result: { data } });
const liveStatus = { halted: null, indexedHeight: 42, finalizedHeight: 42 };

describe('svc-indexer — the sovereign venue', () => {
  it('reads a projected book and pins it to the block height', async () => {
    const { venue } = indexerVenue((url) =>
      url.includes('/trpc/status')
        ? trpc(liveStatus)
        : trpc({ market: 'IFC-USD', asOfHeight: 42, asOfHash: '0x' + 'a'.repeat(64), bids: [['99', '5']], asks: [['101', '2']] }),
    );

    const book = await venue.depth('IFC-USD', 50);

    expect(book.asks.map((l) => formatAmount(l[0]))).toEqual(['101']);
    expect(book.sequence).toBe(42);
    expect(book.chainFinality).toBe('finalized');
    expect(venue.kind).toBe('external-dex');
  });

  it('REFUSES a projected book with no finalizedHeight — inclusion is not settlement', async () => {
    const { venue } = indexerVenue((url) =>
      url.includes('/trpc/status')
        ? trpc({ halted: null, indexedHeight: 42 })
        : trpc({ market: 'IFC-USD', asOfHeight: 42, bids: [['99', '5']], asks: [['101', '2']] }),
    );

    const err = await refusal(venue.depth('IFC-USD', 50));
    expect(err.reason).toBe('missing_finality');
    expect(err.message).toContain('finalizedHeight');
  });

  it('REFUSES a book above finalizedHeight — MEV/reorg can still revert it', async () => {
    const { venue } = indexerVenue((url) =>
      url.includes('/trpc/status')
        ? trpc({ halted: null, indexedHeight: 50, finalizedHeight: 40 })
        : trpc({ market: 'IFC-USD', asOfHeight: 50, bids: [['99', '5']], asks: [['101', '2']] }),
    );

    const err = await refusal(venue.depth('IFC-USD', 50));
    expect(err.reason).toBe('reorg_unconfirmed');
    expect(err.message).toContain('asOfHeight 50');
  });

  /**
   * THE STATE THIS ENVIRONMENT IS ACTUALLY IN.
   *
   * svc-indexer boots `NullChainSource` — SOCKET §13 `socket.evm-rpc`. Nothing
   * has ever been projected, so `asOfHeight` is null. An adapter that returned
   * the empty book anyway would report a market with no bids as a market with
   * no buyers, and the DEX would quote a sovereign price that does not exist.
   */
  it('REFUSES an empty index rather than reporting no-liquidity on a chain that is not there', async () => {
    const { venue } = indexerVenue((url) =>
      url.includes('/trpc/status')
        ? trpc({ halted: null, indexedHeight: null })
        : trpc({ asOfHeight: null, asOfHash: null, bids: [], asks: [] }),
    );

    const err = await refusal(venue.depth('IFC-USD', 50));

    expect(err.reason).toBe('not_ready');
    expect(err.message).toContain('socket.evm-rpc');
  });

  it('refuses a halted projection — it knows its own book is wrong', async () => {
    const { venue } = indexerVenue((url) =>
      url.includes('/trpc/status')
        ? trpc({ halted: { reason: 'reorg deeper than retained history', at: '2026-07-29T00:00:00.000Z' }, indexedHeight: 10 })
        : trpc({ asOfHeight: 10, bids: [['99', '5']], asks: [['101', '5']] }),
    );

    const err = await refusal(venue.depth('IFC-USD', 50));

    expect(err.reason).toBe('not_ready');
    expect(err.message).toContain('reorg deeper than retained history');
  });

  it('treats a 500 as unreachable, not as an empty market', async () => {
    const { venue } = indexerVenue(() => status(500));
    expect((await refusal(venue.depth('IFC-USD', 50))).reason).toBe('unreachable');
  });

  it('forwards the screened region so the upstream screens the same caller', async () => {
    const { venue, calls } = indexerVenue(
      (url) =>
        url.includes('/trpc/status') ? trpc(liveStatus) : trpc({ asOfHeight: 1, finalizedHeight: 42, bids: [], asks: [['100', '1']] }),
      'DE',
    );

    await venue.depth('IFC-USD', 50);

    expect(calls.every((c) => c.headers['x-intafaced-region'] === 'DE')).toBe(true);
  });
});

// ── svc-matching: our own book ───────────────────────────────────────────────

const matchingVenue = (handler: (url: string) => Response) => {
  const { calls, fetchImpl } = recorder(handler);
  return {
    calls,
    venue: new MatchingQuoteVenue({
      baseUrl: 'http://svc-matching:4005',
      timeoutMs: 2_000,
      quoteTtlMs: 2_000,
      feeBps: 20,
      fetch: fetchImpl,
    }),
  };
};

describe('svc-matching — the internal book', () => {
  it('reads engine depth and keeps the engine sequence', async () => {
    const { venue, calls } = matchingVenue(() => ok({ marketId: 'IFC-USD', sequence: 77, bids: [['99', '4']], asks: [['101', '3']] }));

    const book = await venue.depth('IFC-USD', 25);

    expect(book.sequence).toBe(77);
    expect(book.bids.map((l) => formatAmount(l[1]))).toEqual(['4']);
    expect(calls[0]!.url).toContain('/markets/IFC-USD/depth?limit=25');
  });

  it('is `internal`, and therefore custodial and disclosed as such', () => {
    const { venue } = matchingVenue(() => ok({ sequence: 1, bids: [], asks: [] }));
    expect(venue.kind).toBe('internal');
  });

  it('treats a market the engine has never seen as unreachable, not as an empty book', async () => {
    // "This engine has no such market" and "this market has no bids" are
    // different facts, and only one of them is a market condition.
    const { venue } = matchingVenue(() => status(404));
    expect((await refusal(venue.depth('NOPE-USD', 50))).reason).toBe('unreachable');
  });

  it('refuses a depth response with no engine sequence — provenance unknown', async () => {
    const { venue } = matchingVenue(() => ok({ bids: [['99', '1']], asks: [['101', '1']] }));
    expect((await refusal(venue.depth('IFC-USD', 50))).reason).toBe('malformed');
  });

  it('sends no credential, because reads need none and it holds none', async () => {
    const { venue, calls } = matchingVenue(() => ok({ sequence: 1, bids: [], asks: [['100', '1']] }));

    await venue.depth('IFC-USD', 50);

    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.headers['x-intafaced-service']).toBeUndefined();
  });
});

// ── External venues: the §27 fabric ──────────────────────────────────────────

describe('external venues — configured, never hardcoded, never credentialled', () => {
  it('refuses a protocol venue with unset settlement cost rather than quoting gas as zero', () => {
    const parsed = externalVenueConfigSchema.safeParse({
      id: 'amm-a',
      kind: 'amm',
      depthUrl: 'https://example.invalid/d',
      feeBps: 30,
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an explicit protocol settlement cost, including honest zero', () => {
    const parsed = externalVenueConfigSchema.safeParse({
      id: 'amm-a',
      kind: 'amm',
      depthUrl: 'https://example.invalid/d',
      feeBps: 30,
      settlementCost: '0',
    });
    expect(parsed.success).toBe(true);
  });

  it('substitutes every symbol spelling a venue might use', () => {
    const template = '{symbol}|{symbolCompact}|{symbolLower}|{symbolUnderscore}|{symbolDash}|{limit}';
    expect(renderDepthUrl(template, 'BTC/USDT', 50)).toBe('BTC%2FUSDT|BTCUSDT|btcusdt|BTC_USDT|BTC-USDT|50');
  });

  it('reads a book nested under a venue-specific path, with venue-specific field names', async () => {
    const { calls, fetchImpl } = recorder(() => ok({ result: { b: [['99.5', '2']], a: [['100.5', '3']], seq: 9 } }));
    const venue = new ExternalQuoteVenue({
      config: {
        id: 'venue-a',
        depthUrl: 'https://example.invalid/depth?symbol={symbolCompact}&limit={limit}',
        feeBps: 10,
        bookPath: 'result',
        bidsField: 'b',
        asksField: 'a',
        sequencePath: 'result.seq',
      },
      baseUrl: 'https://example.invalid',
      timeoutMs: 2_000,
      quoteTtlMs: 2_000,
      fetch: fetchImpl,
    });

    const book = await venue.depth('BTC/USDT', 20);

    expect(calls[0]!.url).toBe('https://example.invalid/depth?symbol=BTCUSDT&limit=20');
    expect(book.asks.map((l) => formatAmount(l[0]))).toEqual(['100.5']);
    expect(book.sequence).toBe(9);
    expect(venue.kind).toBe('external-cex');
  });

  it('sends no API key, because public depth needs none', async () => {
    const { calls, fetchImpl } = recorder(() => ok({ bids: [], asks: [['100', '1']] }));
    const venue = new ExternalQuoteVenue({
      config: { id: 'venue-b', depthUrl: 'https://example.invalid/d?s={symbolCompact}', feeBps: 5 },
      baseUrl: 'https://example.invalid',
      timeoutMs: 2_000,
      quoteTtlMs: 2_000,
      fetch: fetchImpl,
    });

    await venue.depth('BTC/USDT', 10);

    expect(Object.keys(calls[0]!.headers)).toEqual(['accept']);
  });

  it('refuses a venue that publishes floats rather than quoting one', async () => {
    const { fetchImpl } = recorder(() => ok({ bids: [], asks: [[100.5, 1.25]] }));
    const venue = new ExternalQuoteVenue({
      config: { id: 'floaty', depthUrl: 'https://example.invalid/d?s={symbolCompact}', feeBps: 5 },
      baseUrl: 'https://example.invalid',
      timeoutMs: 2_000,
      quoteTtlMs: 2_000,
      fetch: fetchImpl,
    });

    const err = await refusal(venue.depth('BTC/USDT', 10));
    expect(err.reason).toBe('malformed');
    expect(err.message).toContain('not a pair of strings');
  });

  it('refuses when the configured book path finds nothing', async () => {
    const { fetchImpl } = recorder(() => ok({ somethingElse: true }));
    const venue = new ExternalQuoteVenue({
      config: { id: 'wrong-path', depthUrl: 'https://example.invalid/d', feeBps: 5, bookPath: 'data.0' },
      baseUrl: 'https://example.invalid',
      timeoutMs: 2_000,
      quoteTtlMs: 2_000,
      fetch: fetchImpl,
    });

    expect((await refusal(venue.depth('BTC/USDT', 10))).reason).toBe('malformed');
  });

  it('degrades a throttled venue to unreachable rather than serving a bad price', async () => {
    // There is no rate-limit governor yet (§27). A 429 must therefore drop the
    // venue from routing, not produce a stale or partial book.
    const { fetchImpl } = recorder(() => status(429));
    const venue = new ExternalQuoteVenue({
      config: { id: 'throttled', depthUrl: 'https://example.invalid/d', feeBps: 5 },
      baseUrl: 'https://example.invalid',
      timeoutMs: 2_000,
      quoteTtlMs: 2_000,
      fetch: fetchImpl,
    });

    expect((await refusal(venue.depth('BTC/USDT', 10))).reason).toBe('unreachable');
  });
});
