// The window J-algo-dev-16 #3 backtests and resamples, and the round trips its strategy closes on that window's bars.

/**
 * How far back #3's window reaches, in minutes: into the TEST chart history the stack was seeded with, not only into the
 * minutes this shard's market maker has traded. The history (`local-test-market.mjs history`: 210 bars of 15 minutes, two
 * TEST trades each, 7.5 minutes apart, so each its own 1m bar) ends when the stack was seeded, and a shard may start from
 * a snapshot seeded up to MAX_AGE_HOURS earlier (`local-test-snapshot.mjs`). A 60-minute window then held none of it,
 * only the dozen live minutes since the file began, as the files before it hold the market still: run 45320068609
 * (24 Nov 2026, a snapshot seeded 47 minutes before the build) found 2 round trips there for 12 minutes, twice. 600
 * minutes keeps over 50 history bars in the window for the oldest stack a shard can run on, and stays inside the 720
 * one-minute bars svc-quant's history read reaches back (`HISTORY_BARS_BACK`), with two hours to spare for the steps
 * between choosing the window and running the backtest (a window past it is refused, `quant.backtest_history_range`).
 * `resample-window.test.mjs` checks the history it holds.
 */
export const RESAMPLE_WINDOW_MINUTES = 600;

/**
 * The round trips #3's strategy closes on these 1m bars ([at, open, high, low, close, volume]). Its averages are 1 and 2
 * bars, so the fast one is above the slow one exactly when a bar closes above the one before: it buys when that starts
 * (a close above the one before, after one that was not) and sells when a close falls below the one before, and each
 * signal fills at a later bar's open, so the last bar fills nothing. Resampling needs at least 2 closed round trips
 * (`quant.montecarlo_trades_insufficient`), so #3 waits for a window holding one more than it needs; what #3 then reads
 * is the service's own count (`data-trips`).
 */
export function roundTrips(bars) {
  const close = (i) => Number(bars[i][4]);
  let long = false;
  let trips = 0;
  for (let i = 2; i < bars.length - 1; i++) {
    if (!long && close(i) > close(i - 1) && close(i - 1) <= close(i - 2)) long = true;
    else if (long && close(i) < close(i - 1)) {
      long = false;
      trips += 1;
    }
  }
  return trips;
}
