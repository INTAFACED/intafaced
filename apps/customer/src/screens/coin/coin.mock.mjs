// Answers the calls the Coin page makes, for the Playwright tests. No service is contacted.
// It sits on top of the Buy card's mock (markets, order preview and placement, balance) and adds what the page itself
// reads: the ticker with 24 h figures, candles per range, and the person's fills. Overrides replace one answer: a JSON
// body, a function of the request, 'error' (500), 'hang' (held until release()), or { status, json }.
import { mock as tradeMock } from '../trade/buy/trade.mock.mjs';
import { book } from '../trade/buy/trade.fixtures.mjs';
import { candles, fills, markets, tickers, wireTicker } from './coin.fixtures.mjs';

export async function mock(page, overrides = {}, options = {}) {
  const world = { young: false, history: 'long', ...options };
  const base = await tradeMock(page, { markets: () => markets, tickers: () => tickers(world), ...(overrides.trade ?? {}) });
  const calls = [];
  const held = [];
  const fulfill = async (route, value, request) => {
    if (value === 'error') return route.fulfill({ status: 500, body: 'no' });
    const resolved = typeof value === 'function' ? await value(request) : value;
    if (resolved && typeof resolved === 'object' && 'status' in resolved && 'json' in resolved)
      return route.fulfill({ status: resolved.status, json: resolved.json });
    return route.fulfill({ status: 200, json: resolved });
  };
  const defaults = {
    markets: () => markets,
    tickers: () => tickers(world),
    ticker: ({ symbol }) => (symbol in book ? wireTicker(symbol, world) : undefined),
    ohlcv: ({ symbol, timeframe, limit }) => candles(symbol, timeframe, limit, world.history),
    fills: () => fills(),
  };
  const served = { ...defaults, ...overrides };
  delete served.trade;

  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let name = null;
    const request = { url, symbol: undefined, timeframe: undefined, limit: undefined };
    if (path === '/api/v1/markets') name = 'markets';
    else if (path === '/api/v1/tickers') name = 'tickers';
    else if (path.startsWith('/api/v1/ticker/')) {
      name = 'ticker';
      request.symbol = decodeURIComponent(path.slice('/api/v1/ticker/'.length));
    } else if (path.startsWith('/api/v1/ohlcv/')) {
      name = 'ohlcv';
      request.symbol = decodeURIComponent(path.slice('/api/v1/ohlcv/'.length));
      request.timeframe = url.searchParams.get('timeframe');
      request.limit = Number(url.searchParams.get('limit'));
    } else if (path === '/api/v1/account/trades') name = 'fills';
    if (name === null) return route.fallback();
    calls.push({ name, symbol: request.symbol, timeframe: request.timeframe, limit: request.limit });
    if (served[name] === 'hang') return void held.push({ route, name, request });
    return fulfill(route, served[name], request);
  });

  return {
    ...base,
    world,
    calls,
    /** Calls of one kind, newest last. */
    seen: (name) => calls.filter((call) => call.name === name),
    /** Replace an answer from now on. */
    set: (name, value) => {
      served[name] = value;
    },
    /** Answer every held request, and every later one, with the normal answer. */
    release: async () => {
      for (const key of Object.keys(served)) if (served[key] === 'hang') served[key] = defaults[key];
      for (const { route, name, request } of held.splice(0)) await fulfill(route, defaults[name], request);
      await base.release();
    },
  };
}
