// Illustrative data for the desk test only. Not real balances, prices or orders: the numbers are invented but
// consistent. These are WIRE shapes: the exact JSON the exchange REST API sends, so the real data layer and the
// real trade client (apps/customer/src) parse them. `Exchange` is a small stateful stand-in for the service so
// the order flows (preview, place, cancel, reconcile) can be walked end to end without any real service.
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
const SCALE = 10n ** 18n;

/** Decimal string to scaled bigint, and back (trailing zeros trimmed). Test helpers only. */
export const scaled = (text) => {
  const negative = String(text).startsWith('-');
  const [whole, fraction = ''] = String(text).replace(/^-/, '').split('.');
  const value = BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0').slice(0, 18));
  return negative ? -value : value;
};
export const plain = (value) => {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const fraction = (abs % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${abs / SCALE}${fraction ? `.${fraction}` : ''}`;
};
const mulFloor = (a, b) => (a * b) / SCALE;

const wireMarket = ({ base, quote, tick, lot, minAmount, minCost, open = true, band = 'not set', cap = 'not set' }) => ({
  id: `${base}/${quote}`,
  symbol: `${base}/${quote}`,
  base,
  quote,
  settle: null,
  baseId: base,
  quoteId: quote,
  type: 'spot',
  spot: true,
  swap: false,
  future: false,
  option: false,
  contract: false,
  linear: null,
  inverse: null,
  active: true,
  orderable: open,
  paper: false,
  schedule: 'crypto-24x7',
  sessionOpen: true,
  nextSessionChange: null,
  hours: { kind: 'continuous' },
  taker: '0.002',
  maker: '0.001',
  contractSize: null,
  expiry: null,
  expiryDatetime: null,
  strike: null,
  optionType: null,
  precisionMode: 'TICK_SIZE',
  precision: { amount: lot, price: tick },
  limits: {
    amount: { min: minAmount, max: null },
    price: { min: tick, max: null },
    cost: { min: minCost, max: null },
    leverage: { min: null, max: null },
  },
  lifecycle: { state: open ? 'OPEN' : 'REFUSED' },
  pairRules: {
    tick,
    lot,
    minQty: minAmount,
    minNotional: minCost,
    maxQty: 'not set',
    protection: { collar: band, fatFinger: 'not set', slippageCapBps: 'not set', openOrdersPerMarket: cap },
    riskVersion: band === 'not set' && cap === 'not set' ? '0' : '1',
  },
});

export const markets = ({ btcOpen = true } = {}) => [
  wireMarket({
    base: 'BTC',
    quote: 'USDT',
    tick: '0.01',
    lot: '0.00001',
    minAmount: '0.00001',
    minCost: '5',
    open: btcOpen,
    // TEST values: a fixture-fed band and cap, not anything published.
    band: '0.1',
    cap: '20',
  }),
  wireMarket({ base: 'ETH', quote: 'USDT', tick: '0.01', lot: '0.0001', minAmount: '0.0001', minCost: '5' }),
  wireMarket({ base: 'IFC', quote: 'USDT', tick: '0.0001', lot: '0.01', minAmount: '0.01', minCost: '5' }),
  wireMarket({ base: 'BTC', quote: 'USDC', tick: '0.01', lot: '0.00001', minAmount: '0.00001', minCost: '5' }),
];

// symbol -> [last, open 24h ago, high, low, base volume, quote volume]
const prices = {
  'BTC/USDT': ['65000.00', '64500.00', '65400.00', '64100.00', '1.88944', '123053.19'],
  'ETH/USDT': ['3200.10', '3250.00', '3300.00', '3150.00', '40.5', '129604.05'],
  'IFC/USDT': ['0.4120', '0.4210', '0.4300', '0.4000', '10000', '4120'],
  'BTC/USDC': ['65010.00', '64510.00', '65410.00', '64110.00', '0.5', '32505'],
};

export const tickers = ({ windowStart } = {}) => {
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(prices).map(([symbol, [last, open, high, low, baseVolume, quoteVolume]]) => {
      const change = plain(scaled(last) - scaled(open));
      return [
        symbol,
        {
          symbol,
          timestamp: now,
          datetime: new Date(now).toISOString(),
          high,
          low,
          bid: plain(scaled(last) - scaled('0.1')),
          bidVolume: '1',
          ask: plain(scaled(last) + scaled('0.1')),
          askVolume: '1',
          vwap: null,
          open,
          close: last,
          last,
          previousClose: null,
          change,
          percentage: plain((scaled(change) * 100n * SCALE) / scaled(open)),
          average: null,
          baseVolume,
          quoteVolume,
          sparkline: null,
          windowStart: windowStart ?? now - 30 * HOUR,
        },
      ];
    }),
  );
};

/** Order book around 65,000: best bid 64,999.90, best ask 65,000.10, levels 0.10 apart. */
export const book = ({ empty = false } = {}) => {
  const now = Date.now();
  const bids = [];
  const asks = [];
  if (!empty)
    for (let i = 0; i < 40; i += 1) {
      bids.push([plain(scaled('64999.9') - scaled('0.1') * BigInt(i)), plain(scaled('0.05') + scaled('0.011') * BigInt(i % 7))]);
      asks.push([plain(scaled('65000.1') + scaled('0.1') * BigInt(i)), plain(scaled('0.04') + scaled('0.013') * BigInt(i % 5))]);
    }
  return { symbol: 'BTC/USDT', bids, asks, timestamp: now, datetime: new Date(now).toISOString(), nonce: 100 };
};

export const tape = (symbol = 'BTC/USDT') =>
  Array.from({ length: 30 }, (_, i) => ({
    id: `trade-${i}`,
    order: null,
    timestamp: Date.now() - i * 20_000,
    datetime: new Date(Date.now() - i * 20_000).toISOString(),
    symbol,
    type: null,
    side: i % 3 === 0 ? 'sell' : 'buy',
    takerOrMaker: null,
    price: plain(scaled('65000') + scaled('0.1') * BigInt(i % 9) - scaled('0.3')),
    amount: plain(scaled('0.01') + scaled('0.003') * BigInt(i % 4)),
    cost: '650',
    fee: null,
  }));

const STEP = {
  '1m': MINUTE,
  '3m': 3 * MINUTE,
  '5m': 5 * MINUTE,
  '15m': 15 * MINUTE,
  '30m': 30 * MINUTE,
  '1h': HOUR,
  '2h': 2 * HOUR,
  '4h': 4 * HOUR,
  '6h': 6 * HOUR,
  '12h': 12 * HOUR,
  '1d': 24 * HOUR,
  '1w': 7 * 24 * HOUR,
};
/** /ohlcv: `count` candles ending now, a gentle wave around 65,000 closing at the ticker's last price. */
export const candles = (timeframe = '15m', count = 200) => {
  const step = STEP[timeframe] ?? 15 * MINUTE;
  const end = Math.floor(Date.now() / step) * step;
  return Array.from({ length: count }, (_, i) => {
    const t = end - (count - 1 - i) * step;
    const base = 65000 + Math.sin(i / 9) * 350 + Math.cos(i / 4) * 120;
    const open = i === 0 ? base : base + Math.sin(i * 1.7) * 40;
    const close = i === count - 1 ? 65000 : base + Math.cos(i * 1.3) * 45;
    const high = Math.max(open, close) + 60 + (i % 5) * 10;
    const low = Math.min(open, close) - 60 - (i % 3) * 10;
    const fix = (value) => value.toFixed(2);
    return [t, fix(open), fix(high), fix(low), fix(close), (0.2 + (i % 7) * 0.13).toFixed(4)];
  });
};

const entry = (total, used = '0') => ({ free: plain(scaled(total) - scaled(used)), used, total });

/** The fields svc-trade's order preview accepts (spot/order-preview-rest.ts ALLOWED_FIELDS). */
const PREVIEW_FIELDS = new Set([
  'symbol',
  'side',
  'type',
  'amount',
  'price',
  'stopPrice',
  'exit',
  'maxSlippageBps',
  'timeInForce',
  'expireAt',
  'postOnly',
  'reduceOnly',
  'clientOrderId',
  'subAccountId',
]);

/** A small stateful stand-in for the exchange REST API (the /api/v1 paths the desk calls). */
export class Exchange {
  constructor() {
    this.balances = { USDT: entry('4100'), BTC: entry('0.25') };
    this.open = [];
    this.closed = [];
    this.fills = [];
    this.requests = [];
    this.nextId = 1;
    /** Behaviours a test can switch. */
    this.opts = {
      markets: markets(),
      book: book(),
      refusal: null, // { code, message } for the preview to refuse with
      placeMode: 'ok', // 'ok' | 'abort' (taken, answer lost) | 'lose' (never arrived) | { status, json }
      delayPlace: 0, // ms the order's answer is held back
      previewError: false,
      fail: {}, // { orderbook: 500, ohlcv: 500, ... } answers that read with a server error
      hideOrders: false, // the order lists come back empty (an order the service took is not found)
      windowStart: undefined, // epoch ms the tickers' 24h figures start at (a young market's "since")
    };
  }

  wireOrder(draft, extra) {
    const now = Date.now();
    return {
      id: `order-${this.nextId++}`,
      clientOrderId: draft.clientOrderId,
      timestamp: now,
      datetime: new Date(now).toISOString(),
      lastTradeTimestamp: null,
      symbol: draft.symbol,
      type: draft.type,
      side: draft.side,
      timeInForce: draft.postOnly ? 'PO' : draft.timeInForce,
      postOnly: Boolean(draft.postOnly),
      reduceOnly: false,
      price: draft.price ?? null,
      stopPrice: null,
      average: null,
      amount: draft.amount,
      filled: '0',
      remaining: draft.amount,
      cost: '0',
      status: 'open',
      fee: null,
      trades: [],
      recoveryRequired: false,
      recoveryReason: null,
      reconciliationKey: null,
      tag: draft.tag ?? null,
      ...extra,
    };
  }

  preview(draft) {
    const market = this.opts.markets.find((m) => m.symbol === draft.symbol);
    const bid = scaled(this.opts.book.bids[0]?.[0] ?? '0');
    const ask = scaled(this.opts.book.asks[0]?.[0] ?? '0');
    const amount = scaled(draft.amount);
    const limit = draft.type === 'limit';
    const protection = draft.side === 'buy' ? (ask * 101n) / 100n : (bid * 99n) / 100n;
    const price = limit ? scaled(draft.price) : protection;
    // Like the real service: the fee rate comes from the owner schedule (10 bps, not the /markets listing), a buy holds
    // price x amount and pays its fee in the base asset, and a market sell holds its amount and is valued at its floor.
    const rate = ((this.opts.feeBps ?? 10n) * SCALE) / 10000n;
    const value = mulFloor(price, amount);
    const fee = draft.side === 'buy' ? mulFloor(amount, rate) : mulFloor(value, rate);
    const refused = this.opts.refusal;
    return {
      symbol: draft.symbol,
      side: draft.side,
      type: draft.type,
      amount: draft.amount,
      price: limit ? draft.price : null,
      timeInForce: draft.postOnly ? 'PO' : draft.timeInForce,
      holdAsset: draft.side === 'buy' ? market.quote : market.base,
      holdAmount: draft.side === 'buy' ? plain(value) : plain(amount),
      protectionPrice: limit ? null : plain(protection),
      estimatedFee: plain(fee),
      feeAsset: draft.side === 'buy' ? market.base : market.quote,
      feeBps: Number((rate * 10000n) / SCALE),
      feeRole: draft.postOnly ? 'maker' : 'taker',
      orderable: !refused,
      refusals: refused
        ? [{ code: refused.code, field: 'order', message: refused.message ?? 'refused', ...(refused.data ? { data: refused.data } : {}) }]
        : [],
    };
  }

  /** Answer one request: { status, json } or 'abort' to drop the connection. */
  handle({ method, path, query, body, headers = {} }) {
    this.requests.push({ method, path, body });
    const json = (value, status = 200) => ({ status, json: value });
    const name = path.split('/')[0];
    if (this.opts.fail[name]) return json({ error: { message: 'down' } }, this.opts.fail[name]);
    if (path === 'markets') return json(this.opts.markets);
    const all = () => tickers({ windowStart: this.opts.windowStart });
    if (path === 'tickers') return json(all());
    if (path.startsWith('ticker/')) return json(all()[decodeURIComponent(path.slice(7))] ?? all()['BTC/USDT']);
    if (path.startsWith('orderbook/')) return json(this.opts.book === 'error' ? null : { ...this.opts.book, timestamp: Date.now() });
    if (path.startsWith('trades/')) return json(tape(decodeURIComponent(path.slice(7))));
    if (path.startsWith('ohlcv/')) return json(candles(query.timeframe ?? '15m', Number(query.limit ?? 200)));
    if (path === 'account/balance') {
      const now = Date.now();
      return json({ timestamp: now, datetime: new Date(now).toISOString(), balances: this.balances });
    }
    if (path === 'orders/open') return json(this.opts.hideOrders ? [] : this.open);
    if (path === 'orders/closed') return json(this.opts.hideOrders ? [] : this.closed);
    if (path === 'account/trades') return json(this.fills);
    if (/^orders\/[^/]+$/.test(path) && method === 'GET') {
      const found = [...this.open, ...this.closed].find((row) => row.id === decodeURIComponent(path.slice(7)));
      return found ? json(found) : json({ error: { message: 'gone', code: 'trade.order_not_found' } }, 404);
    }
    if (path === 'account/fees')
      return json(
        this.opts.fees === false ? {} : { 'BTC/USDT': { symbol: 'BTC/USDT', maker: '0.0008', taker: '0.0012', percentage: true } },
      );
    if (path === 'orders/preview' && method === 'POST') {
      if (this.opts.previewError) return json({ error: { message: 'down' } }, 503);
      // Like the real service: the preview takes only the fields that price an order, and refuses any other.
      const unknown = Object.keys(body ?? {}).filter((key) => !PREVIEW_FIELDS.has(key));
      if (unknown.length > 0)
        return json(
          { code: 'BadRequest', message: `unsupported fields: ${unknown}`, intafacedCode: 'trade.order_preview_server_values_only' },
          400,
        );
      return json(this.preview(body));
    }
    if (path === 'orders' && method === 'POST') {
      if (this.opts.placeMode === 'abort') {
        // The service did take the order, but the answer never arrives: the outcome is unknown to the browser.
        this.commit(body);
        return 'abort';
      }
      if (this.opts.placeMode === 'lose') return 'abort';
      if (this.opts.placeMode !== 'ok') return json(this.opts.placeMode.json, this.opts.placeMode.status);
      return json(this.commit(body));
    }
    if (path === 'orders/batch-cancel' && method === 'POST') {
      // Each id on its own, in order: cancelled, or refused (an id that is not open), never rolled back.
      const results = (body?.ids ?? []).map((id, index) => {
        const at = this.open.findIndex((order) => order.id === id);
        if (at === -1)
          return {
            index,
            orderId: id,
            status: 'refused',
            error: { code: 'OrderNotFound', message: 'gone', intafacedCode: 'trade.order_not_found' },
          };
        const [order] = this.open.splice(at, 1);
        const cancelled = { ...order, status: 'canceled' };
        this.releaseHold(order);
        this.closed.unshift(cancelled);
        return { index, orderId: id, status: 'success', order: cancelled };
      });
      return json({ atomic: false, results });
    }
    if (path === 'orders' && method === 'DELETE') {
      // Cancel every open order in one market, or in every market (no symbol). Every fixture market is spot, so
      // `kind=spot` is every market here too; any other kind is refused as the service does.
      if (query.kind !== undefined && !['spot', 'futures', 'options'].includes(query.kind))
        return json({ code: 'BadRequest', message: 'kind', intafacedCode: 'trade.invalid_filter' }, 400);
      const inScope = (order) => (query.symbol ? order.symbol === query.symbol : query.kind === undefined || query.kind === 'spot');
      const gone = this.open.filter(inScope);
      this.open = this.open.filter((order) => !inScope(order));
      const cancelled = gone.map((order) => ({ ...order, status: 'canceled' }));
      for (const order of gone) this.releaseHold(order);
      this.closed.unshift(...cancelled);
      return json(cancelled);
    }
    if (/^orders\/[^/]+$/.test(path) && method === 'PATCH') {
      // Native amend: the amount left on the order changes, the place in the queue is kept.
      const order = this.open.find((row) => row.id === decodeURIComponent(path.slice(7)));
      if (!order) return json({ error: { message: 'gone', code: 'trade.order_not_found' } }, 404);
      this.releaseHold(order);
      order.amount = body.qty;
      order.remaining = body.qty;
      if (order.side === 'buy' && order.price) {
        const hold = mulFloor(scaled(order.price), scaled(order.amount));
        this.balances.USDT = entry(this.balances.USDT.total, plain(scaled(this.balances.USDT.used) + hold));
      }
      return json({
        accepted: true,
        idempotent: false,
        code: 'AMENDED',
        reasonCode: null,
        reconciliationRequired: false,
        path: 'NATIVE',
        priority: 'retained',
        orderId: order.id,
        order,
      });
    }
    if (/^orders\/[^/]+\/replace$/.test(path) && method === 'POST') {
      // Cancel and replace: the old order is cancelled first, then the new one is placed.
      const id = decodeURIComponent(path.split('/')[1]);
      const at = this.open.findIndex((row) => row.id === id);
      if (at === -1) return json({ error: { message: 'gone', code: 'trade.order_not_found' } }, 404);
      const [old] = this.open.splice(at, 1);
      const original = { ...old, status: 'canceled' };
      this.closed.unshift(original);
      this.releaseHold(old);
      // What svc-trade answers when the posting freeze stops the original's release after the engine cancelled it.
      if (this.opts.replaceError)
        return json(
          {
            code: 'ExchangeNotAvailable',
            message:
              'ledger.frozen; the order reached the engine and its settlement is not confirmed: read the order before sending it again',
            intafacedCode: 'trade.settlement_pending',
          },
          503,
        );
      const replacement = this.commit(body);
      return json({
        accepted: true,
        idempotent: false,
        code: 'REPLACED',
        reasonCode: null,
        reconciliationRequired: false,
        path: 'CANCEL_REPLACE',
        originalOrderId: original.id,
        originalState: original.status,
        replacementOrderId: replacement.id,
        replacementState: replacement.status,
        original,
        replacement,
      });
    }
    if (path.startsWith('orders/') && method === 'DELETE') {
      // The real trade service refuses a DELETE that says it is JSON but has no body. The app now sends neither.
      if ((body === null || body === undefined) && /json/.test(headers['content-type'] ?? ''))
        return json(
          {
            statusCode: 400,
            code: 'FST_ERR_CTP_EMPTY_JSON_BODY',
            error: 'Bad Request',
            message: 'Body cannot be empty when content-type is set to application/json',
          },
          400,
        );
      const id = decodeURIComponent(path.slice(7));
      const at = this.open.findIndex((order) => order.id === id);
      if (at === -1) return json({ error: { message: 'gone', code: 'trade.order_not_found' } }, 404);
      const [order] = this.open.splice(at, 1);
      const cancelled = { ...order, status: 'canceled' };
      this.closed.unshift(cancelled);
      this.releaseHold(order);
      return json(cancelled);
    }
    return json({ error: { message: 'not mocked' } }, 404);
  }

  releaseHold(order) {
    if (order.side === 'buy' && order.price) {
      const hold = mulFloor(scaled(order.price), scaled(order.amount));
      this.balances.USDT = entry(this.balances.USDT.total, plain(scaled(this.balances.USDT.used) - hold));
    }
  }

  /** The service answers with an order that ended at once (rejected, or cancelled with nothing or part filled). */
  finish(draft, extra) {
    const order = this.wireOrder(draft, extra);
    this.closed.unshift(order);
    return order;
  }

  /** The service accepts an order: a limit rests in the book, a market order fills at the best price. */
  commit(draft) {
    const existing = [...this.open, ...this.closed].find((order) => order.clientOrderId === draft.clientOrderId);
    if (existing) return existing;
    const ask = this.opts.book.asks[0];
    const bid = this.opts.book.bids[0];
    const crosses =
      draft.type === 'limit' && (draft.side === 'buy' ? scaled(draft.price) >= scaled(ask[0]) : scaled(draft.price) <= scaled(bid[0]));
    const touch = draft.side === 'buy' ? ask : bid;
    const room = scaled(touch[1]);
    const wanted = scaled(draft.amount);
    const tif = draft.postOnly ? 'PO' : draft.timeInForce;
    if (tif === 'PO' && crosses) return this.finish(draft, { status: 'rejected' });
    if (tif === 'FOK' && (draft.type === 'market' || crosses) && wanted > room) return this.finish(draft, { status: 'rejected' });
    if (tif === 'FOK' && draft.type === 'limit' && !crosses) return this.finish(draft, { status: 'rejected' });
    if (tif === 'IOC' && draft.type === 'limit') {
      if (!crosses) return this.finish(draft, { status: 'canceled' });
      if (wanted > room) {
        const part = plain(room);
        return this.finish(draft, {
          status: 'canceled',
          filled: part,
          remaining: plain(wanted - room),
          average: touch[0],
          cost: plain(mulFloor(scaled(touch[0]), room)),
        });
      }
    }
    if (draft.type === 'limit' && !(tif === 'IOC' || tif === 'FOK')) {
      // A resting order says what it holds, as the service does: a buy its price x amount in quote, a sell its amount.
      const [base, quote] = draft.symbol.split('/');
      const order = this.wireOrder(draft, {
        hold:
          draft.side === 'buy'
            ? { asset: quote, amount: plain(mulFloor(scaled(draft.price), scaled(draft.amount))) }
            : { asset: base, amount: draft.amount },
      });
      this.open.unshift(order);
      if (draft.side === 'buy') {
        const hold = mulFloor(scaled(draft.price), scaled(draft.amount));
        this.balances.USDT = entry(this.balances.USDT.total, plain(scaled(this.balances.USDT.used) + hold));
      }
      return order;
    }
    const fillPrice = draft.side === 'buy' ? this.opts.book.asks[0][0] : this.opts.book.bids[0][0];
    const cost = plain(mulFloor(scaled(fillPrice), scaled(draft.amount)));
    const fill = {
      id: `fill-${this.nextId++}`,
      order: null,
      timestamp: Date.now(),
      datetime: new Date().toISOString(),
      symbol: draft.symbol,
      type: 'market',
      side: draft.side,
      takerOrMaker: 'taker',
      price: fillPrice,
      amount: draft.amount,
      cost,
      fee: { cost: plain(mulFloor(scaled(cost), scaled('0.002'))), currency: 'USDT', rate: '0.002' },
    };
    const order = this.wireOrder(draft, {
      status: 'closed',
      filled: draft.amount,
      remaining: '0',
      average: fillPrice,
      cost,
      trades: [fill],
    });
    this.closed.unshift(order);
    this.fills.unshift({ ...fill, order: order.id });
    const base = scaled(this.balances.BTC.total);
    const quote = scaled(this.balances.USDT.total);
    const sign = draft.side === 'buy' ? 1n : -1n;
    this.balances.BTC = entry(plain(base + sign * scaled(draft.amount)));
    this.balances.USDT = entry(plain(quote - sign * scaled(cost)), this.balances.USDT.used);
    return order;
  }
}
