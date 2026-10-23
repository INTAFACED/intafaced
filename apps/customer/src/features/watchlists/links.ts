/** Where a watchlist row goes, and the drag type a row carries onto a chart. Kept apart so the charts screen can import them alone. */
export const WATCHLIST_DRAG_TYPE = 'application/x-intafaced-symbol';

/** The workbench address of a market: `/charts/BTC-USDT`, with `?w=` only for a workbench other than the default. */
export function chartHrefFor(symbol: string, workbench = 'main'): string {
  const pair = symbol.replace('/', '-');
  return `/charts/${encodeURIComponent(pair)}${workbench !== 'main' ? `?w=${encodeURIComponent(workbench)}` : ''}`;
}
