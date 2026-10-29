// Test harness only: answers every call the Options, Execution and Quote desk rooms make, so no service is contacted.
// Every figure comes from the rooms' own fixtures.ts (all TEST). The only numbers made up here are the TEST Greeks, the
// TEST wallet balances and the TEST last price, which no fixture file carries; they are marked TEST below.
//
// Wire shapes: tRPC answers are { result: { data } }; a refusal is HTTP 412 with
// { error: { message, code: -32012, data: { code: 'PRECONDITION_FAILED', httpStatus: 412, cause: { code } } } }.
import { Exchange, scaled, plain, tickers } from '../../desk/desk.fixtures.mjs';
import { testChain, testPolicyPaper, testPolicyLive } from '../../options/fixtures.ts';
import {
  TEST_NOW as EXEC_NOW,
  TEST_POLICY_ON,
  TEST_POLICY_OFF,
  TEST_MARKET,
  TEST_PARENTS,
  TEST_BATCH,
  TEST_ORDERS,
  TEST_SPINE,
} from '../../execution/fixtures.ts';
import { TEST_NOW as OTC_NOW, TEST_QUOTES, TEST_FILL } from '../../otc/fixtures.ts';

export { EXEC_NOW, OTC_NOW, TEST_MARKET, TEST_QUOTES, TEST_BATCH, testChain };
/** The fake signed-in user the harness page commits (main.tsx). */
export const USER_ID = '00000000-0000-4000-8000-000000000001';

const SCALE = 10n ** 18n;
const mul = (a, b) => (a * b) / SCALE;

// TEST Greeks (no fixture carries them). One answer per right, plainly illustrative.
// 'ok' answers carry only unsigned numbers;
// 'signed' answers carry the negative put delta and theta a real pricing library sends.
const TEST_GREEKS = {
  ok: {
    call: { npv: '1250.5', delta: '0.52', gamma: '0.0001', vega: '85.3', theta: '12.4' },
    put: { npv: '1180.25', delta: '0.48', gamma: '0.0001', vega: '85.3', theta: '11.9' },
  },
  signed: {
    call: { npv: '1250.5', delta: '0.52', gamma: '0.0001', vega: '85.3', theta: '-12.4' },
    put: { npv: '1180.25', delta: '-0.48', gamma: '0.0001', vega: '85.3', theta: '-11.9' },
  },
};
// TEST wallet and TEST last price for the Execution room (the fixtures hold no balance or ticker).
const TEST_BALANCES = { USDT: { free: '5000', used: '0', total: '5000' }, BTC: { free: '0.25', used: '0', total: '0.25' } };
const TEST_LAST = '60000';

/** A real spot listing in the exact JSON the exchange sends, built from the Execution TEST market. */
function wireSpot(m) {
  return {
    id: m.symbol,
    symbol: m.symbol,
    base: m.base,
    quote: m.quote,
    settle: null,
    baseId: m.base,
    quoteId: m.quote,
    type: 'spot',
    spot: true,
    swap: false,
    future: false,
    option: false,
    contract: false,
    linear: null,
    inverse: null,
    active: true,
    orderable: m.open,
    paper: false,
    schedule: 'crypto-24x7',
    sessionOpen: true,
    nextSessionChange: null,
    hours: { kind: 'continuous' },
    taker: m.taker,
    maker: m.maker,
    contractSize: null,
    expiry: null,
    expiryDatetime: null,
    strike: null,
    optionType: null,
    precisionMode: 'TICK_SIZE',
    precision: { amount: m.lotSize, price: m.tickSize },
    limits: {
      amount: { min: m.minAmount, max: null },
      price: { min: m.tickSize, max: null },
      cost: { min: m.minCost, max: null },
      leverage: { min: null, max: null },
    },
    lifecycle: { state: m.open ? 'OPEN' : 'REFUSED' },
  };
}

const trpcOk = (data) => ({ status: 200, json: { result: { data } } });
/** A typed refusal exactly as the trade service sends it. */
export const trpcRefusal = (code, message = 'Refused') => ({
  status: 412,
  json: { error: { message, code: -32012, data: { code: 'PRECONDITION_FAILED', httpStatus: 412, cause: { code } } } },
});

/** Preview for an option order: premium is price x size x contract size, the fee is the contract's own taker rate. */
function optionPreview(draft, market) {
  const price = scaled(draft.price);
  const amount = scaled(draft.amount);
  const size = scaled(market.contractSize ?? '1');
  const premium = mul(mul(price, amount), size);
  // The service holds nothing for a paper order (svc-trade order-preview-rest.ts: holdAmount is 0 for paper markets).
  const hold = market.paper ? 0n : draft.side === 'buy' ? premium : mul(mul(scaled(market.strike), amount), size);
  return {
    symbol: draft.symbol,
    side: draft.side,
    type: draft.type,
    amount: draft.amount,
    price: draft.price,
    timeInForce: draft.postOnly ? 'PO' : draft.timeInForce,
    holdAsset: market.quote,
    holdAmount: plain(hold),
    protectionPrice: null,
    estimatedFee: plain(mul(premium, scaled(market.taker))),
    feeAsset: market.quote,
    feeBps: Math.round(Number(market.taker) * 10000),
    feeRole: 'taker',
    orderable: true,
    refusals: [],
  };
}

/**
 * Install the mock on a page. `room` is options | execution | otc.
 *   options.policy   'paper' (default) | 'live'
 *   exec.policy      'on' (default) | 'off'
 *   exec.parents     TEST parents known to the service, by id (running / partial / halted)
 * Returns the live state so a scenario can steer it: `mock.state.greeks = 'refused'`, `mock.state.abortOnce.set('rfq.accept', { landed: false })`.
 */
export async function installMock(page, { room, now, optionsPolicy = 'paper', schedulerOn = true, emptyChain = false } = {}) {
  const exchange = new Exchange();
  const calls = [];
  const errors = [];
  const state = {
    greeks: 'ok', // 'ok' | 'signed' | 'refused'
    abortOnce: new Map(), // trpc procedure -> { landed }: the answer is lost; `landed` says whether the service acted first
    quotes: new Map(Object.values(TEST_QUOTES).map((q) => [q.quoteId, { ...q }])),
    algos: new Map(TEST_PARENTS.map((p) => [p.parent.id, { parent: { ...p.parent }, progress: { ...p.progress } }])),
    optionsPolicy,
    schedulerOn,
  };

  exchange.balances = JSON.parse(JSON.stringify(TEST_BALANCES));
  if (room === 'options') exchange.opts.markets = emptyChain ? [] : testChain;
  else exchange.opts.markets = [wireSpot(TEST_MARKET)];
  if (room === 'execution') {
    exchange.open = [TEST_ORDERS.scaledOpen, TEST_ORDERS.manual, TEST_ORDERS.algoChild].map((o) => ({ ...o }));
    exchange.closed = [{ ...TEST_ORDERS.scaledClosed }];
  }

  // The mock runs in Node, so orders it creates are stamped with the page's fixed clock, not the machine's.
  const commit = exchange.commit.bind(exchange);
  exchange.commit = (draft) => {
    const known = new Set([...exchange.open, ...exchange.closed]);
    const order = commit(draft);
    if (!known.has(order) && now !== undefined) Object.assign(order, { timestamp: now, datetime: new Date(now).toISOString() });
    return order;
  };

  page.on('pageerror', (error) => errors.push(error.message));
  page.on(
    'console',
    (message) => message.type() === 'error' && !/Failed to load resource/.test(message.text()) && errors.push(message.text()),
  );

  const send = async (route, result) => {
    if (result === 'abort') return route.abort('connectionreset');
    return route.fulfill(result);
  };

  // ---------- REST: /api/v1/** ----------
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const target = new URL(request.url());
    const path = decodeURIComponent(target.pathname.replace(/^\/api\/v1\//, ''));
    const method = request.method();
    const body = method === 'GET' ? undefined : request.postData() === null ? null : request.postDataJSON();
    calls.push({ kind: 'rest', method, name: path, body });
    const json = (value, status = 200) => ({ status, json: value });

    if (path.startsWith('ticker/')) {
      const row = tickers()['BTC/USDT'];
      return send(
        route,
        json({ ...row, symbol: decodeURIComponent(path.slice(7)), last: TEST_LAST, close: TEST_LAST, bid: '59999.9', ask: '60000.1' }),
      );
    }
    if (path === 'orders/preview' && method === 'POST' && room === 'options') {
      const market = testChain.find((m) => m.symbol === body.symbol);
      return send(route, json(optionPreview(body, market)));
    }
    if (path === 'orders/batch' && method === 'POST') {
      const results = body.orders.map((order, index) => {
        const fixture = TEST_BATCH[index] ?? TEST_BATCH[0];
        // A refused order never reaches the book; a placed one does, and so does the "unknown" one (its answer was lost).
        if (fixture.status === 'refused') return { index, clientOrderId: order.clientOrderId, status: 'refused', error: fixture.error };
        const placed = exchange.commit({ ...order, price: order.price });
        return fixture.status === 'unknown'
          ? { index, clientOrderId: order.clientOrderId, status: 'unknown' }
          : { index, clientOrderId: order.clientOrderId, status: 'success', order: { id: placed.id, status: placed.status } };
      });
      return send(route, json({ results }));
    }
    if (path === 'greeks/what-if' && method === 'POST') {
      if (state.greeks === 'refused')
        return send(
          route,
          json({ ok: false, code: 'trade.greeks_native_unlinked', message: 'The pricing library is not linked in this environment.' }),
        );
      return send(route, json({ ok: true, ...TEST_GREEKS[state.greeks][body.right] }));
    }
    const result = exchange.handle({ method, path, query: Object.fromEntries(target.searchParams), body, headers: request.headers() });
    return send(route, result);
  });

  // ---------- tRPC: /api/execution/trpc/execution.spine ----------
  await page.route('**/api/execution/trpc/execution.spine', async (route) => {
    calls.push({ kind: 'trpc', method: route.request().method(), name: 'execution.spine' });
    return send(route, trpcOk(TEST_SPINE));
  });

  // ---------- tRPC: /api/trade/trpc/<proc> ----------
  const quoteWith = (id, over) => {
    const next = { ...state.quotes.get(id), ...over };
    state.quotes.set(id, next);
    return next;
  };
  const bound = TEST_QUOTES.bound;
  const handlers = {
    'options.policy': () => trpcOk(state.optionsPolicy === 'live' ? testPolicyLive : testPolicyPaper),
    'algo.policy': () => trpcOk(state.schedulerOn ? TEST_POLICY_ON : TEST_POLICY_OFF),
    'algo.createTwap': () => trpcOk(state.algos.get('TEST-algo-running').parent),
    'algo.get': ({ algoId }) => (state.algos.has(algoId) ? trpcOk(state.algos.get(algoId).parent) : trpcRefusal('trade.algo_not_found')),
    'algo.progress': ({ algoId }) =>
      state.algos.has(algoId) ? trpcOk(state.algos.get(algoId).progress) : trpcRefusal('trade.algo_not_found'),
    ...Object.fromEntries(
      [
        ['pause', 'paused'],
        ['resume', 'active'],
        ['cancel', 'cancelled'],
      ].map(([action, status]) => [
        `algo.${action}`,
        ({ algoId }) => {
          const entry = state.algos.get(algoId);
          if (!entry) return trpcRefusal('trade.algo_not_found');
          entry.parent = { ...entry.parent, status, haltReason: status === 'active' ? null : entry.parent.haltReason };
          entry.progress = { ...entry.progress, status, haltReason: entry.parent.haltReason };
          return trpcOk(entry.parent);
        },
      ]),
    ),
    'otc.deskStatus': () =>
      trpcOk({
        published: true,
        statusLine: 'TEST desk',
        residual: null,
        makerRouting: { published: false, residual: null },
        midFeed: { wiring: 'TEST', published: true, residual: null },
      }),
    'otc.makers.list': () =>
      trpcOk({ published: true, makers: [{ id: 'house', name: 'House desk (TEST)', route: 'platform' }], selectCap: 1, emptyLabel: null }),
    'rfq.quote': (input) => {
      const source = input.side === 'sell' ? TEST_QUOTES.sell : TEST_QUOTES.open;
      state.quotes.set(source.quoteId, { ...source });
      return trpcOk(state.quotes.get(source.quoteId));
    },
    'rfq.get': ({ quoteId }) => (state.quotes.has(quoteId) ? trpcOk(state.quotes.get(quoteId)) : trpcRefusal('trade.otc_quote_missing')),
    'rfq.accept': ({ quoteId }) => {
      const q = state.quotes.get(quoteId);
      if (!q) return trpcRefusal('trade.otc_quote_missing');
      return trpcOk(quoteWith(quoteId, { status: 'bound', lifecycle: 'bound', acceptedAt: bound.acceptedAt, fillPrice: bound.fillPrice }));
    },
    'rfq.expire': ({ quoteId }) =>
      state.quotes.has(quoteId)
        ? trpcOk(quoteWith(quoteId, { status: 'expired', lifecycle: 'expired' }))
        : trpcRefusal('trade.otc_quote_missing'),
    'otc.settle': ({ quoteId }) => {
      if (!state.quotes.has(quoteId)) return trpcRefusal('trade.otc_quote_missing');
      quoteWith(quoteId, { status: 'settled', lifecycle: 'settled', acceptedAt: bound.acceptedAt, fillPrice: bound.fillPrice });
      return trpcOk({ ...TEST_FILL, quoteId });
    },
  };
  handlers['otc.accept'] = handlers['rfq.accept'];

  await page.route('**/api/trade/trpc/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const proc = decodeURIComponent(url.pathname.split('/trpc/')[1] ?? '');
    const raw = request.method() === 'GET' ? url.searchParams.get('input') : request.postData();
    const input = raw ? JSON.parse(raw) : {};
    calls.push({ kind: 'trpc', method: request.method(), name: proc, body: input });
    const handler = handlers[proc];
    if (!handler) return send(route, { status: 404, json: { error: { message: `not mocked: ${proc}` } } });
    // The answer never arrives: the browser cannot know the outcome. The service may or may not have acted first.
    if (request.method() === 'POST' && state.abortOnce.has(proc)) {
      const { landed } = state.abortOnce.get(proc);
      state.abortOnce.delete(proc);
      if (landed) handler(input);
      return send(route, 'abort');
    }
    return send(route, handler(input));
  });

  return {
    exchange,
    state,
    calls,
    errors,
    called: (name) => calls.filter((c) => c.name === name),
  };
}
