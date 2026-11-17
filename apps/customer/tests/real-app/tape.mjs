import { expect } from './journey.mjs';
import { EDGE } from './stack.mjs';

// The TEST tape the algo journeys backtest on: closed 1m bars of BTC/USDT from the local TEST market maker.

/** A UTC minute as a datetime-local value, `minutesAgo` before the current minute. */
export function utcMinute(minutesAgo) {
  const at = Math.floor(Date.now() / 60_000) * 60_000 - minutesAgo * 60_000;
  return new Date(at).toISOString().slice(0, 16);
}

/** The TEST market maker's closed 1m bars of BTC/USDT since a datetime-local UTC minute, read from Edge's public route. */
export async function closedBarsSince(minute) {
  const since = Date.parse(`${minute}:00Z`);
  const res = await fetch(`${EDGE}/api/v1/ohlcv/${encodeURIComponent('BTC/USDT')}?timeframe=1m&since=${since}&limit=720`);
  if (!res.ok) return [];
  const rows = await res.json();
  return rows.filter(([at]) => at >= since && at + 60_000 <= Date.now());
}

/**
 * The last `minutes` of the TEST tape as a from/to window, fixed only once it holds enough: by default at least 8 closed
 * bars; `count` and `least` ask for something else the window's bars must hold (`what` names it in the failure). The
 * window is taken again on every poll, because a window fixed early (a shard that starts minutes after the market maker)
 * can never gain a bar.
 */
export async function tapeWindow(minutes, { least = 8, count = (bars) => bars.length, what = 'closed TEST bars of BTC/USDT' } = {}) {
  let window;
  await expect
    .poll(
      async () => {
        window = { from: utcMinute(minutes), to: utcMinute(0) };
        return count((await closedBarsSince(window.from)).filter(([at]) => at < Date.parse(`${window.to}:00Z`)));
      },
      {
        timeout: 12 * 60_000,
        intervals: [15_000],
        message: `the window needs at least ${least} ${what}; is the TEST market maker running (pnpm local:market)?`,
      },
    )
    .toBeGreaterThanOrEqual(least);
  return window;
}
