/**
 * Live trade.copy leader performance fixtures door for copy-intel stats runs.
 *
 * Production leave this unset: live leader stats are Class X. An unset port is
 * the honest refuse (`no_live_leaders`) — never invented PnL or win rates.
 *
 * Caller-supplied fixtures stay fixture/dark only. Live truth is this port.
 */

import type { LeaderPerformanceFixture } from './stats.js';

export type CopyLeaderFixturesPort = {
  /**
   * Grounded live leader fixtures. An empty array is no rows.
   * Throw when the sample is unavailable. Never invent PnL inside the port.
   */
  sample(): Promise<readonly LeaderPerformanceFixture[]>;
};

export type LiveLeaderFixtures =
  | { readonly ok: true; readonly fixtures: readonly LeaderPerformanceFixture[] }
  | { readonly ok: false; readonly reason: 'no_live_leaders' };

/**
 * Resolve live fixtures. A missing port, a non-array sample, or a thrown
 * sample is `no_live_leaders`. An empty array is a successful read with no
 * rows. The caller returns unbilled empty once the plane is allowlisted.
 * Never invent PnL.
 */
export async function readLiveLeaderFixtures(port: CopyLeaderFixturesPort | undefined): Promise<LiveLeaderFixtures> {
  if (port === undefined) {
    return { ok: false, reason: 'no_live_leaders' };
  }
  try {
    const fixtures = await port.sample();
    if (!Array.isArray(fixtures)) {
      return { ok: false, reason: 'no_live_leaders' };
    }
    return { ok: true, fixtures };
  } catch {
    return { ok: false, reason: 'no_live_leaders' };
  }
}
