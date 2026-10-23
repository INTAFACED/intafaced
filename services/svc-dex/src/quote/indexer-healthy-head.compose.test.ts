/**
 * Unit card — a healthy indexer yields a quotable book
 *
 * 1. Promise: when svc-indexer is synced, not halted and has finalized blocks,
 *    the DEX quote adapter can price from it.
 * 2. Break: the indexer serves the book at its head height H while status says
 *    finalized = H - finalityDepth; the adapter rightly refuses any book above
 *    finalized, so every healthy head is refused as reorg_unconfirmed and the
 *    protocol DEX can never quote.
 * 3. Done bar: real Indexer + router (memory chain, finalityDepth 1) composed
 *    with the real IndexerQuoteVenue returns depth from a finalized book. The
 *    adapter's refusal of unfinalized books stays.
 * 4. Class M
 * 5. Paths: services/svc-indexer/src/router.ts, projection stores;
 *    services/svc-dex/src/quote/indexer-venue.ts
 * 6. RED on 11ab823a8: indexedHeight 2, finalizedHeight 1, book asOfHeight 2 → reorg_unconfirmed
 */
import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { MemoryProjectionStore } from '../../../svc-indexer/src/projection/memory-store.js';
import { MemoryChainSource } from '../../../svc-indexer/src/chain/memory-source.js';
import { Indexer } from '../../../svc-indexer/src/indexer.js';
import { createIndexerRouter } from '../../../svc-indexer/src/router.js';
import { IndexerQuoteVenue } from './indexer-venue.js';

process.env.INTAFACED_SCREENING_FAIL_CLOSED = 'off';

describe('DEX quote over a healthy indexer', () => {
  it('prices from a synced, unhalted indexer with finalized blocks', async () => {
    const store = new MemoryProjectionStore(31337);
    const source = new MemoryChainSource(31337);
    source.append([{ kind: 'book_level', logIndex: 0, market: 'IFC-USD', side: 'ask', price: '101', quantity: '2' }]);
    source.append([]);
    source.append([]);
    const indexer = new Indexer({ source, store, finalityDepth: 1, ingestEnabled: () => true, startHeight: 0 });
    await indexer.sync();
    const router = createIndexerRouter({ store, indexer, chainId: 31337, finalityDepth: 1, ingestEnabled: () => true, chainSource: 'memory' });
    const ctx = createEdgeContext({ secret: 'test-only-fixture-secret-32-bytes!', serviceName: 'svc-indexer' })({
      headers: { 'x-intafaced-region': 'DE' },
      id: 'fixture',
    } as never);
    const caller = router.createCaller(ctx);
    const fetcher = async (url: string | URL | Request) => {
      const data = String(url).includes('/status') ? await caller.status() : await caller.book({ market: 'IFC-USD', depth: 10 });
      return new Response(JSON.stringify({ result: { data } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const venue = new IndexerQuoteVenue({ baseUrl: 'http://memory-fixture', timeoutMs: 2000, quoteTtlMs: 2000, feeBps: 0, settlementCost: 0n, fetch: fetcher });

    const depth = await venue.depth('IFC-USD', 10);
    expect(depth.asks.length).toBeGreaterThan(0);
  });
});
