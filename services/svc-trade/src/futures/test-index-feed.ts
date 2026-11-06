/**
 * THE TEST INDEX FEED: a labelled stand-in for `feed.market` on dev and test stacks only (J-derivatives-08).
 *
 * The outside index venue feed is not connected on main, so the funding rate computer refuses every period with
 * NotConnected `feed.market`. A journey that must see a funding period close needs an index, and a stand-in that never
 * invents a number: this feed quotes ONE source, `test:spot-book`, at the mid of the stack's own TEST spot book that
 * the perpetual is paired with (`TRADE_FUTURES_INDEX_SPOT_MARKETS`). An empty or one-sided book is no quote at all, and
 * the index builder then refuses as it would for a silent venue.
 *
 * `TRADE_FUTURES_TEST_INDEX_FEED=spot-book` turns it on. Unset, blank or `off` is off; any other value throws; and `on`
 * outside an explicit APP_ENV dev or test throws, so a production process cannot start with it.
 */
import { isExplicitDevOrTest } from '@intafaced/config';
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import type { EngineDepth } from '../spot/matching-client.js';
import type { IndexFeed, IndexQuote } from './index-construction.js';

export const TEST_INDEX_FEED_ENV = 'TRADE_FUTURES_TEST_INDEX_FEED' as const;
/** The one source this feed quotes. An operator's source list names it like any other source. */
export const TEST_SPOT_BOOK_SOURCE = 'test:spot-book' as const;

export class TestIndexFeedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TestIndexFeedError';
  }
}

/** Reads the flag from the RAW env (unset APP_ENV is not dev). True only for `spot-book` on a dev or test process. */
export function testIndexFeedEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[TEST_INDEX_FEED_ENV]?.trim().toLowerCase() ?? '';
  if (raw === '' || raw === 'off') return false;
  if (raw !== 'spot-book') {
    throw new TestIndexFeedError('trade.test_index_feed_invalid', `${TEST_INDEX_FEED_ENV} must be unset, off or spot-book`);
  }
  if (!isExplicitDevOrTest(env.APP_ENV)) {
    throw new TestIndexFeedError(
      'trade.test_index_feed_not_dev',
      `${TEST_INDEX_FEED_ENV}=spot-book is a local test stand-in for feed.market and is refused unless APP_ENV is dev or test (got ${JSON.stringify(env.APP_ENV ?? null)})`,
    );
  }
  return true;
}

function top(level: readonly [string, string] | undefined): Amount | null {
  if (!level) return null;
  try {
    const price = parseAmount(level[0]);
    const size = parseAmount(level[1]);
    return price > 0n && size > 0n ? price : null;
  } catch {
    return null;
  }
}

/** The mid of a two-sided book, rounded half-up at 18 decimals; null for an empty, one-sided or crossed book. */
export function bookMid(depth: EngineDepth | null): Amount | null {
  if (!depth) return null;
  const bid = top(depth.bids[0]);
  const ask = top(depth.asks[0]);
  if (bid === null || ask === null || bid > ask) return null;
  return (bid + ask + 1n) / 2n;
}

/**
 * The feed: `readBook(marketId)` gives the paired TEST spot book of a futures market (null when it has none). A source
 * other than `test:spot-book` is never quoted, so the builder treats it as silent.
 */
export function testSpotBookIndexFeed(deps: {
  readBook: (marketId: string) => Promise<EngineDepth | null>;
  now?: () => Date;
}): IndexFeed {
  return {
    async read({ marketId, sourceIds }) {
      const quotes: IndexQuote[] = [];
      if (sourceIds.includes(TEST_SPOT_BOOK_SOURCE)) {
        const mid = bookMid(await deps.readBook(marketId));
        if (mid !== null) quotes.push({ sourceId: TEST_SPOT_BOOK_SOURCE, price: mid, observedAt: (deps.now ?? (() => new Date()))() });
      }
      return { connected: true, quotes };
    },
  };
}
