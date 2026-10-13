/**
 * Unit card — a healthy indexer yields a quotable book
 *
 * 1. Promise: when svc-indexer is synced, not halted and has finalized blocks,
 *    the DEX quote adapter can price from it.
 * 2. Break: the indexer served the book at its head height H while status says
 *    finalized = H - finalityDepth; the adapter rightly refuses any book above
 *    finalized, so every healthy head was refused as reorg_unconfirmed and the
 *    protocol DEX could never quote.
 * 3. Done bar: real Indexer + router (memory chain, finalityDepth 1) composed
 *    with the real IndexerQuoteVenue returns depth from a finalized book. The
 *    adapter's refusal of unfinalized books stays (svc-dex is not touched).
 *    The book is as of finalizedHeight, never includes a block above it, and a
 *    reorg above finalized leaves it unchanged.
 * 4. Class M
 * 5. Paths: services/svc-indexer/src/router.ts, projection stores;
 *    services/svc-dex/src/quote/indexer-venue.ts
 * 6. RED on 94403f7a: indexedHeight 2, finalizedHeight 1, book asOfHeight 2 → reorg_unconfirmed
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { MemoryProjectionStore } from './projection/memory-store.js';
import { MemoryChainSource } from './chain/memory-source.js';
import { Indexer } from './indexer.js';
import { createIndexerRouter } from './router.js';
import type { ChainEvent } from './chain/source.js';

/**
 * svc-dex's REAL adapter, loaded by path at run time. A static import would put
 * svc-dex sources under this package's `rootDir` and fail the tests' typecheck
 * (TS6059), and svc-indexer must not take a package dependency on its consumer.
 * Only the slice of the adapter this file calls is typed.
 */
interface QuoteVenue {
  depth(symbol: string, limit: number): Promise<{ asks: readonly unknown[]; bids: readonly unknown[] }>;
}
type QuoteVenueCtor = new (opts: {
  baseUrl: string;
  timeoutMs: number;
  quoteTtlMs: number;
  feeBps: number;
  settlementCost: bigint;
  fetch: (url: string | URL | Request) => Promise<Response>;
}) => QuoteVenue;
const venueModule = fileURLToPath(new URL('../../svc-dex/src/quote/indexer-venue.ts', import.meta.url));
const { IndexerQuoteVenue } = (await import(/* @vite-ignore */ venueModule)) as { IndexerQuoteVenue: QuoteVenueCtor };

process.env.INTAFACED_SCREENING_FAIL_CLOSED = 'off';

const ask = (price: string, quantity: string, logIndex = 0): ChainEvent => ({
  kind: 'book_level',
  logIndex,
  market: 'IFC-USD',
  side: 'ask',
  price,
  quantity,
});

async function harness(finalityDepth: number) {
  const store = new MemoryProjectionStore(31337);
  const source = new MemoryChainSource(31337);
  const indexer = new Indexer({ source, store, finalityDepth, ingestEnabled: () => true, startHeight: 0 });
  const router = createIndexerRouter({ store, indexer, chainId: 31337, finalityDepth, ingestEnabled: () => true, chainSource: 'memory' });
  const ctx = createEdgeContext({ secret: 'test-only-fixture-secret-32-bytes!', serviceName: 'svc-indexer' })({
    headers: { 'x-intafaced-region': 'DE' },
    id: 'fixture',
  } as never);
  const caller = router.createCaller(ctx);
  const fetcher = async (url: string | URL | Request) => {
    const data = String(url).includes('/status') ? await caller.status() : await caller.book({ market: 'IFC-USD', depth: 10 });
    return new Response(JSON.stringify({ result: { data } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const venue = new IndexerQuoteVenue({
    baseUrl: 'http://memory-fixture',
    timeoutMs: 2000,
    quoteTtlMs: 2000,
    feeBps: 0,
    settlementCost: 0n,
    fetch: fetcher,
  });
  return { source, indexer, caller, venue };
}

describe('DEX quote over a healthy indexer', () => {
  it('prices from a synced, unhalted indexer with finalized blocks', async () => {
    const { source, indexer, caller, venue } = await harness(1);
    source.append([ask('101', '2')]);
    source.append([]);
    source.append([]);
    await indexer.sync();

    const depth = await venue.depth('IFC-USD', 10);
    expect(depth.asks.length).toBeGreaterThan(0);

    const status = await caller.status();
    const book = await caller.book({ market: 'IFC-USD', depth: 10 });
    expect(status.indexedHeight).toBe(2);
    expect(status.finalizedHeight).toBe(1);
    // The served book is the finalized one, and says so.
    expect(book.asOfHeight).toBe(status.finalizedHeight);
  });

  it('never serves a block above finalized: head-only liquidity is absent from the quote', async () => {
    const { source, indexer, caller, venue } = await harness(1);
    source.append([ask('101', '2')]); // 0
    source.append([ask('101', '5')]); // 1 — finalized
    source.append([ask('101', '9'), ask('102', '4', 1)]); // 2 — head, not final
    await indexer.sync();

    const book = await caller.book({ market: 'IFC-USD', depth: 10 });
    expect(book.asOfHeight).toBe(1);
    expect(book.asks).toEqual([['101', '5']]);

    const depth = await venue.depth('IFC-USD', 10);
    expect(depth.asks).toHaveLength(1);
  });

  it('a reorg above finalized leaves the finalized book unchanged', async () => {
    const { source, indexer, caller, venue } = await harness(2);
    source.append([ask('101', '1')]); // 0
    source.append([ask('101', '2')]); // 1
    source.append([ask('101', '3')]); // 2 — finalized (head 4, depth 2)
    source.append([ask('101', '4')]); // 3
    source.append([ask('101', '5')]); // 4
    await indexer.sync();
    const before = await caller.book({ market: 'IFC-USD', depth: 10 });
    expect(before.asOfHeight).toBe(2);
    expect(before.asks).toEqual([['101', '3']]);

    // Blocks 3 and 4 are replaced; the fork is at 2, the finalized block.
    source.reorg(2, [[ask('101', '40'), ask('103', '1', 1)], [ask('101', '50')]]);
    const pass = await indexer.sync();
    expect(pass.reorgs).toBe(1);

    const after = await caller.book({ market: 'IFC-USD', depth: 10 });
    expect(after).toMatchObject({ asOfHeight: 2, asOfHash: before.asOfHash });
    expect(after.asks).toEqual(before.asks);
    expect((await venue.depth('IFC-USD', 10)).asks).toHaveLength(1);
  });

  it('with no finalized block yet it stays honestly empty and the adapter refuses', async () => {
    const { caller, venue } = await harness(1);
    const book = await caller.book({ market: 'IFC-USD', depth: 10 });
    expect(book).toMatchObject({ asOfHeight: null, asOfHash: null, bids: [], asks: [] });
    await expect(venue.depth('IFC-USD', 10)).rejects.toMatchObject({ reason: 'not_ready' });
  });
});
