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

  // The lot book (svc-tax) for "Your position", and the asset registry (svc-bank) for the networks row: the TEST
  // holding's 0.25 BTC cost 15,000.00 in all; BTC moves on one network.
  const trpc = (json) => ({ status: 200, json: { result: { data: json } } });
  await page.route('**/api/tax/trpc/lotBook**', (route) => route.fulfill(trpc(overrides.lotBook ?? lotBook)));
  await page.route('**/api/bank/trpc/assets.list**', (route) => route.fulfill(trpc(overrides.assets ?? supportedAssets)));

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

export const lotBook = {
  method: 'FIFO',
  preview: false,
  choices: { status: 'unwired', code: 'tax.basis_store_unwired' },
  indicator: 'indicator_not_tax_advice',
  assets: [{ assetId: 'BTC', openQty: '0.25', openCostUsd: '15000', held: '0.25', uncountedQty: '0' }],
  sales: [],
  lots: [],
  realizedUsd: '0',
  includeTransfers: true,
  feesUsd: '0',
  termRule: { status: 'unset', code: 'tax.term_rule_unset' },
  residuals: [],
};

export const supportedAssets = {
  assets: [
    {
      assetId: 'BTC',
      kind: 'crypto',
      precision: 8,
      networks: [{ networkId: 'bitcoin', label: 'Bitcoin' }],
      defaultNetworkId: 'bitcoin',
      allowedActions: ['deposit', 'withdraw', 'trade', 'transfer'],
      state: 'active',
    },
  ],
};
