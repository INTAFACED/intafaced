/**
 * Live spot-ticker door for market scanner rank runs.
 *
 * Production leave this unset: live spot quotes are Class X. An unset port is
 * the honest refuse (`no_live_tickers`) — never a scraped fake API, never a
 * zero-filled ticker invented from silence.
 *
 * Caller-supplied tickers stay fixture/dark only. Live truth is this port.
 */

import { AgentError } from '../errors.js';
import type { TickerFixture } from './data-tools.js';

export type SpotTickersPort = {
  /**
   * Grounded live ticker fixtures. Empty array or throw = unavailable.
   * Never invent last/volume/change inside the port.
   * HTTP trade client requires owner-published `limit` (query `?limit=`).
   */
  sample(limit?: number): Promise<readonly TickerFixture[]>;
};

export type LiveSpotTickers =
  | { readonly ok: true; readonly tickers: readonly TickerFixture[] }
  | { readonly ok: false; readonly reason: 'no_live_tickers' }
  | { readonly ok: false; readonly reason: 'tickers_limit_unset' };

/** Null, blank, and whitespace-only last are not a price. Leave the row unchanged. */
function hasLiveLast(row: TickerFixture): boolean {
  const last = row.last;
  return typeof last === 'string' && last.trim() !== '';
}

/**
 * Resolve live ticker samples. Missing port, empty series, a sample whose rows
 * have no last, or sample failure all collapse to `no_live_tickers` — not an
 * empty board and not invented quotes.
 * Unset page size on the trade HTTP client is a distinct named refuse.
 */
export async function readLiveSpotTickers(port: SpotTickersPort | undefined, limit?: number): Promise<LiveSpotTickers> {
  if (port === undefined) {
    return { ok: false, reason: 'no_live_tickers' };
  }
  try {
    const tickers = await port.sample(limit);
    if (!Array.isArray(tickers)) {
      return { ok: false, reason: 'no_live_tickers' };
    }
    const live = tickers.filter(hasLiveLast);
    if (live.length === 0) {
      return { ok: false, reason: 'no_live_tickers' };
    }
    return { ok: true, tickers: live };
  } catch (err) {
    if (err instanceof AgentError && err.code === 'agents.tickers_limit_unset') {
      return { ok: false, reason: 'tickers_limit_unset' };
    }
    return { ok: false, reason: 'no_live_tickers' };
  }
}
