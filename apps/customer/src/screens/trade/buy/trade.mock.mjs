// Answers the calls the Buy and Convert screens make, for the Playwright tests. No service is contacted.
//  - /api/v1/markets, /tickers, /ticker/<symbol>, /account/balance        (data layer)
//  - /api/v1/orders/preview, /orders, /orders/open, /orders/closed         (trade client)
//  - /api/trade/trpc/convert.quote (GET), convert.accept (POST), convert.list (GET)   (tool client)
// The mock keeps a small world (balances) that an accepted order or conversion really changes, so the balance the
// screen shows after "Done" is what the mock now holds. Overrides replace one answer: a JSON body, a function of the
// request, 'error' (500), 'hang' (held until release()), or { status, json, headers }. `oldServer: true` makes convert.quote
// refuse `quoteQty` the way an older trade service does.
import {
  book,
  fillFor,
  fillOf,
  markets,
  orderFor,
  previewFor,
  quoteFor,
  startingBalances,
  tickers,
  wireBalances,
  wireTicker,
  add,
  sub,
  mul,
} from './trade.fixtures.mjs';

export async function mock(page, overrides = {}) {
  const world = { balances: startingBalances(), quotes: new Map(), orders: [], trades: [], fills: new Map(), counter: 0 };
  const calls = [];
  const held = [];
  const answer = async (route, value, request) => {
    if (value === 'error') return route.fulfill({ status: 500, body: 'no' });
    if (value === 'abort') return route.abort('connectionreset');
    const resolved = typeof value === 'function' ? await value(request) : value;
    if (resolved && typeof resolved === 'object' && 'status' in resolved && 'json' in resolved)
      return route.fulfill({ status: resolved.status, json: resolved.json });
    return route.fulfill({ status: 200, json: resolved });
  };
  const trpc = (data) => ({ result: { data } });

  const defaults = {
    markets: () => markets,
    tickers: () => tickers(),
    ticker: ({ symbol }) => wireTicker(symbol),
    balance: () => wireBalances(world.balances),
    preview: ({ body }) => previewFor(body),
    place: ({ body }) => {
      const order = orderFor(body, `order-${(world.counter += 1)}`);
      const trade = fillOf(body, order.id);
      const [base, quote] = body.symbol.split('/');
      // The balance moves by what the FILL says (the order's own cost is the reserved price, not what was paid).
      if (body.side === 'buy') {
        world.balances[quote] = sub(world.balances[quote] ?? '0', trade.cost);
        world.balances[base] = add(world.balances[base] ?? '0', sub(trade.amount, trade.fee.cost));
      } else {
        world.balances[base] = sub(world.balances[base] ?? '0', trade.amount);
        world.balances[quote] = add(world.balances[quote] ?? '0', sub(trade.cost, trade.fee.cost));
      }
      world.orders.push(order);
      world.trades.push(trade);
      return order;
    },
    orders: () => world.orders,
    trades: () => world.trades,
    quote: ({ input }) => {
      // `oldServer: true` plays an older trade service: it drops `quoteQty` and refuses for the missing `qty` (a plain BAD_REQUEST).
      if (overrides.oldServer && input.quoteQty !== undefined)
        return {
          status: 400,
          json: { error: { message: 'Invalid input: expected string, received undefined', code: -32600, data: { code: 'BAD_REQUEST' } } },
        };
      const quote = quoteFor(input);
      if (!quote)
        return {
          status: 400,
          json: {
            error: {
              message: 'convert takes exactly one of qty or quoteQty',
              code: -32600,
              data: { intafacedCode: 'trade.convert_invalid_qty' },
            },
          },
        };
      world.quotes.set(quote.quoteId, quote);
      return trpc(quote);
    },
    // The service's convert history: one `settled` row per accepted quote, and every other quote the customer asked for as
    // `expired` (quotes that were never taken up are stored too). `convertList` is the wire name in `served`.
    convertList: ({ input }) => {
      const rows = [...world.quotes.values()].reverse().map((quote) => {
        const taken = world.fills.has(quote.quoteId);
        return {
          quoteId: quote.quoteId,
          inAsset: quote.inAsset,
          outAsset: quote.outAsset,
          inAmount: quote.inAmount,
          outAmount: quote.outAmount,
          lifecycle: taken ? 'settled' : 'expired',
          createdAt: input.to,
          expiresAt: input.to,
          acceptedAt: taken ? input.to : null,
          settledAt: taken ? input.to : null,
        };
      });
      return trpc({ rows, nextCursor: null });
    },
    accept: ({ body }) => {
      const quote = world.quotes.get(body.quoteId);
      if (!quote)
        return { status: 400, json: { error: { message: 'quote missing', data: { intafacedCode: 'trade.convert_quote_missing' } } } };
      const fill = world.fills.get(quote.quoteId) ?? fillFor(quote);
      if (!world.fills.has(quote.quoteId)) {
        world.fills.set(quote.quoteId, fill);
        world.balances[quote.inAsset] = sub(world.balances[quote.inAsset] ?? '0', quote.inAmount);
        world.balances[quote.outAsset] = add(world.balances[quote.outAsset] ?? '0', quote.outAmount);
      }
      return trpc(fill);
    },
  };
  const served = { ...defaults, ...overrides };

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    let name;
    const request = { method, url, body: undefined, input: undefined, symbol: undefined };
    if (method !== 'GET') {
      try {
        request.body = JSON.parse(route.request().postData() ?? 'null');
      } catch {
        request.body = null;
      }
    }
    if (path === '/api/v1/markets') name = 'markets';
    else if (path === '/api/v1/tickers') name = 'tickers';
    else if (path.startsWith('/api/v1/ticker/')) {
      name = 'ticker';
      request.symbol = decodeURIComponent(path.slice('/api/v1/ticker/'.length));
    } else if (path === '/api/v1/account/balance') name = 'balance';
    else if (path === '/api/v1/orders/preview') name = 'preview';
    else if (path === '/api/v1/orders' && method === 'POST') name = 'place';
    else if (path === '/api/v1/orders/open' || path === '/api/v1/orders/closed') name = 'orders';
    else if (path === '/api/v1/account/trades') name = 'trades';
    else if (path.endsWith('/convert.quote')) {
      name = 'quote';
      request.input = JSON.parse(url.searchParams.get('input') ?? 'null');
    } else if (path.endsWith('/convert.accept')) name = 'accept';
    else if (path.endsWith('/convert.list')) {
      name = 'convertList';
      request.input = JSON.parse(url.searchParams.get('input') ?? 'null');
    }
    calls.push({ name: name ?? path, method, body: request.body, input: request.input });
    if (!name || !(name in served)) return route.fulfill({ status: 404, json: { error: { message: 'not mocked' } } });
    if (served[name] === 'hang') return void held.push({ route, name, request });
    return answer(route, served[name], request);
  });

  return {
    world,
    calls,
    /** Calls of one kind, newest last. */
    of: (name) => calls.filter((call) => call.name === name),
    /** Replace an answer from now on. */
    set: (name, value) => {
      served[name] = value;
    },
    /** Answer every held request, and every later one, with the normal answer. */
    release: async () => {
      for (const key of Object.keys(served)) if (served[key] === 'hang') served[key] = defaults[key];
      for (const { route, name, request } of held.splice(0)) await answer(route, defaults[name], request);
    },
    book,
    mul,
  };
}

/** A typed refusal the way the REST trade routes send it: `{ error: <code>, message }`. */
export const refusal = (code, message = 'refused', status = 403) => ({
  status,
  json: { error: code, message },
});
export const trpcRefusal = (code, message = 'refused', status = 403) => ({
  status,
  json: { error: { message, code: -32600, data: { intafacedCode: code } } },
});
