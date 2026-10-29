import { describe, expect, it } from 'vitest';
import { parseSymbol, formatSymbol, symbolsEqual, SymbolError } from './symbols.js';
import {
  createOrderRequestSchema,
  positiveDecimal,
  orderBookSchema,
  balancesSchema,
  decimal,
  TIMEFRAME_MS,
  TIMEFRAMES,
  EXCHANGE_ERROR_CODES,
  exchangeErrorSchema,
  marketSchema,
  orderSchema,
} from './schemas.js';
import { REST_ROUTES, WS_CHANNELS, RATE_LIMITS } from './api.js';

describe('CCXT unified symbols', () => {
  it('parses a spot pair', () => {
    expect(parseSymbol('BTC/USDT')).toMatchObject({ base: 'BTC', quote: 'USDT', settle: null, type: 'spot' });
  });

  it('parses a linear perpetual', () => {
    expect(parseSymbol('BTC/USDT:USDT')).toMatchObject({ type: 'swap', settle: 'USDT', linear: true, inverse: false });
  });

  it('parses an inverse perpetual', () => {
    expect(parseSymbol('BTC/USD:BTC')).toMatchObject({ type: 'swap', settle: 'BTC', linear: false, inverse: true });
  });

  it('parses a dated future', () => {
    expect(parseSymbol('BTC/USDT:USDT-251226')).toMatchObject({ type: 'future', expiry: '251226' });
  });

  it('parses an option', () => {
    expect(parseSymbol('BTC/USDT:USDT-251226-90000-C')).toMatchObject({
      type: 'option',
      expiry: '251226',
      strike: '90000',
      optionType: 'call',
    });
    expect(parseSymbol('BTC/USDT:USDT-251226-90000-P').optionType).toBe('put');
  });

  it('round-trips every form', () => {
    for (const symbol of ['BTC/USDT', 'ETH/USDT:USDT', 'BTC/USD:BTC', 'BTC/USDT:USDT-251226', 'BTC/USDT:USDT-251226-90000-C', 'IFC/USDT']) {
      expect(formatSymbol(parseSymbol(symbol))).toBe(symbol);
    }
  });

  it('rejects malformed symbols rather than guessing', () => {
    for (const bad of ['', 'BTCUSDT', 'BTC/', '/USDT', 'BTC/USDT/ETH', 'BTC/USDT:USDT:USDT', 'BTC/USDT:ETH']) {
      expect(() => parseSymbol(bad), bad).toThrow(SymbolError);
    }
  });

  it('rejects a settle asset that is neither base nor quote', () => {
    // A contract must settle in one of its own legs, or margining is undefined.
    expect(() => parseSymbol('BTC/USDT:DOGE')).toThrow(/must be either the base or the quote/);
  });

  it('rejects a bad expiry or option type', () => {
    expect(() => parseSymbol('BTC/USDT:USDT-2512')).toThrow(/YYMMDD/);
    expect(() => parseSymbol('BTC/USDT:USDT-251226-90000-X')).toThrow(/option type/);
  });

  it('rejects a fifth hyphen segment instead of the four-field call', () => {
    const extra = 'BTC/USDT:USDT-251226-90000-C-EXTRA';
    const call = 'BTC/USDT:USDT-251226-90000-C';
    expect(() => parseSymbol(extra)).toThrow(SymbolError);
    expect(symbolsEqual(extra, call)).toBe(false);
  });

  it('compares symbols case-insensitively', () => {
    expect(symbolsEqual('btc/usdt', 'BTC/USDT')).toBe(true);
    expect(symbolsEqual('BTC/USDT', 'BTC/USDT:USDT')).toBe(false);
    expect(symbolsEqual('nonsense', 'BTC/USDT')).toBe(false);
  });
});

describe('money crosses the boundary as a decimal string', () => {
  it('accepts full ledger precision', () => {
    expect(decimal.safeParse('1234.123456789012345678').success).toBe(true);
  });

  it('rejects floats, exponents and over-precision', () => {
    for (const bad of [1234.5, '1e18', '1.1234567890123456789', 'abc', '1,000']) {
      expect(decimal.safeParse(bad).success, String(bad)).toBe(false);
    }
  });
});

describe('order validation at the boundary', () => {
  const base = { symbol: 'BTC/USDT', side: 'buy', amount: '1', clientOrderId: 'cli-1' } as const;

  it('accepts a well-formed limit order', () => {
    expect(createOrderRequestSchema.safeParse({ ...base, type: 'limit', price: '90000' }).success).toBe(true);
  });

  it('rejects a limit order with no price — the classic integration bug', () => {
    const result = createOrderRequestSchema.safeParse({ ...base, type: 'limit' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/requires a price/);
  });

  it('rejects a market order carrying a price', () => {
    const result = createOrderRequestSchema.safeParse({ ...base, type: 'market', price: '90000' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/must not carry a price/);
  });

  it('requires a stop price on stop orders', () => {
    expect(createOrderRequestSchema.safeParse({ ...base, type: 'stop' }).success).toBe(false);
    expect(createOrderRequestSchema.safeParse({ ...base, type: 'stop', stopPrice: '85000' }).success).toBe(true);
  });

  it('refuses postOnly combined with an immediate time-in-force', () => {
    expect(createOrderRequestSchema.safeParse({ ...base, type: 'limit', price: '90000', postOnly: true, timeInForce: 'IOC' }).success).toBe(
      false,
    );
    expect(createOrderRequestSchema.safeParse({ ...base, type: 'limit', price: '90000', postOnly: true, timeInForce: 'GTC' }).success).toBe(
      true,
    );
  });

  it('carries a client order id for idempotent retries', () => {
    const parsed = createOrderRequestSchema.parse({ ...base, type: 'market', clientOrderId: 'bot-42' });
    expect(parsed.clientOrderId).toBe('bot-42');
  });

  it('refuses a create without clientOrderId — retry would double-hold', () => {
    const { clientOrderId: _omit, ...noId } = base;
    const result = createOrderRequestSchema.safeParse({ ...noId, type: 'market' });
    expect(result.success).toBe(false);
  });

  it('refuses a zero or negative amount, price, or stopPrice, and refuses postOnly on a market order when time in force is omitted', () => {
    const nonPositive = ['0', '0.0', '000', '-0', '-1'] as const;

    for (const amount of nonPositive) {
      const result = createOrderRequestSchema.safeParse({ ...base, type: 'market', amount });
      expect(result.success, `amount ${amount}`).toBe(false);
    }

    for (const price of nonPositive) {
      const result = createOrderRequestSchema.safeParse({ ...base, type: 'limit', price });
      expect(result.success, `price ${price}`).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path[0] === 'price' && /requires a price/.test(issue.message))).toBe(false);
      }
    }

    for (const stopPrice of nonPositive) {
      const result = createOrderRequestSchema.safeParse({ ...base, type: 'stop', stopPrice });
      expect(result.success, `stopPrice ${stopPrice}`).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path[0] === 'stopPrice' && /requires a stopPrice/.test(issue.message))).toBe(
          false,
        );
      }
    }

    const marketPostOnly = createOrderRequestSchema.safeParse({ ...base, type: 'market', postOnly: true });
    expect(marketPostOnly.success).toBe(false);

    expect(
      createOrderRequestSchema.safeParse({
        ...base,
        type: 'limit',
        amount: '0.000000000000000001',
        price: '0.000000000000000001',
      }).success,
    ).toBe(true);
    expect(createOrderRequestSchema.safeParse({ ...base, type: 'stop', stopPrice: '0.000000000000000001' }).success).toBe(true);
  });

  it('names a bad amount, price or stopPrice even when another field has already failed (one refusal, every field)', () => {
    const result = createOrderRequestSchema.safeParse({ ...base, type: 'limit', side: 'sideways', amount: '-1', price: '0' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const byField = new Map(result.error.issues.map((issue) => [String(issue.path[0]), issue.message]));
      expect([...byField.keys()].sort()).toEqual(['amount', 'price', 'side']);
      expect(byField.get('amount')).toBe('amount must be a positive decimal string');
      expect(byField.get('price')).toBe('price must be a positive decimal string');
    }
    const stop = createOrderRequestSchema.safeParse({ ...base, type: 'stop', side: 'sideways', stopPrice: '-5' });
    expect(stop.success).toBe(false);
    if (!stop.success) expect(stop.error.issues.map((issue) => issue.path[0]).sort()).toEqual(['side', 'stopPrice']);
    // A sign failure does not stop the cross-field checks: a negative amount on a priceless limit names both.
    const both = createOrderRequestSchema.safeParse({ ...base, type: 'limit', amount: '-1' });
    expect(both.success).toBe(false);
    if (!both.success) {
      expect(both.error.issues.map((issue) => [issue.path[0], issue.message])).toEqual([
        ['amount', 'amount must be a positive decimal string'],
        ['price', 'a limit order requires a price'],
      ]);
    }
  });

  it('exports the positive-decimal check it uses, by characters only', () => {
    for (const ok of ['1', '0.000000000000000001', '010']) expect(positiveDecimal(ok), ok).toBe(true);
    for (const bad of ['0', '0.0', '000', '-0', '-1']) expect(positiveDecimal(bad), bad).toBe(false);
  });

  it('carries the typed self-trade mode, tag and request deadline and refuses a malformed one', () => {
    const ok = createOrderRequestSchema.safeParse({
      ...base,
      type: 'limit',
      price: '90000',
      stpMode: 'cancel_both',
      tag: 'desk-1',
      requestDeadline: new Date(1750000000000).toISOString(),
    });
    expect(ok.success).toBe(true);
    for (const bad of [{ stpMode: 'cancel_everything' }, { tag: '' }, { tag: 'x'.repeat(17) }, { requestDeadline: 'soon' }]) {
      expect(createOrderRequestSchema.safeParse({ ...base, type: 'limit', price: '90000', ...bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  it('carries a fee currency on create', () => {
    expect(createOrderRequestSchema.safeParse({ ...base, type: 'limit', price: '90000', feeCurrency: 'USDT' }).success).toBe(true);
    expect(createOrderRequestSchema.safeParse({ ...base, type: 'limit', price: '90000', feeCurrency: '' }).success).toBe(false);
  });

  it('carries a typed stop trigger source and refuses an unknown one', () => {
    for (const triggerBy of ['last', 'mark', 'index']) {
      expect(createOrderRequestSchema.safeParse({ ...base, type: 'stop', stopPrice: '90', triggerBy }).success, triggerBy).toBe(true);
    }
    expect(createOrderRequestSchema.safeParse({ ...base, type: 'stop', stopPrice: '90', triggerBy: 'twap' }).success).toBe(false);
  });

  it('rejects a GTD order with expireAt "soon"', () => {
    const result = createOrderRequestSchema.safeParse({
      ...base,
      type: 'limit',
      price: '90000',
      timeInForce: 'GTD',
      expireAt: 'soon',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a GTD order with expireAt "0"', () => {
    const result = createOrderRequestSchema.safeParse({
      ...base,
      type: 'limit',
      price: '90000',
      timeInForce: 'GTD',
      expireAt: '0',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a GTD order with an offset expireAt', () => {
    const result = createOrderRequestSchema.safeParse({
      ...base,
      type: 'limit',
      price: '90000',
      timeInForce: 'GTD',
      expireAt: new Date(1750000000000).toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('still refuses a GTD order that omits expireAt', () => {
    const result = createOrderRequestSchema.safeParse({
      ...base,
      type: 'limit',
      price: '90000',
      timeInForce: 'GTD',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message === 'GTD/GTT requires expireAt; the engine does not invent one')).toBe(true);
    }
  });
});

describe('response shapes', () => {
  it('accepts a well-formed order book with a resync nonce', () => {
    const book = {
      symbol: 'BTC/USDT',
      bids: [['89999.5', '1.25']],
      asks: [['90000.5', '0.75']],
      timestamp: 1750000000000,
      datetime: new Date(1750000000000).toISOString(),
      nonce: 42,
    };
    expect(orderBookSchema.safeParse(book).success).toBe(true);
  });

  it('rejects an order book level with a float price', () => {
    const book = {
      symbol: 'BTC/USDT',
      bids: [[89999.5, 1.25]],
      asks: [],
      timestamp: 1750000000000,
      datetime: new Date(1750000000000).toISOString(),
      nonce: 1,
    };
    expect(orderBookSchema.safeParse(book).success).toBe(false);
  });

  it('projects ledger account kinds into the CCXT free/used/total shape', () => {
    const balances = {
      timestamp: 1750000000000,
      datetime: new Date(1750000000000).toISOString(),
      balances: {
        USDT: { free: '1000', used: '250', total: '1250' },
        IFC: { free: '0', used: '4000', total: '4000' },
      },
    };
    expect(balancesSchema.safeParse(balances).success).toBe(true);
  });
});

describe('API surface', () => {
  it('leaves market data public and gates account data', () => {
    expect(REST_ROUTES.fetchOrderBook.scope).toBeNull();
    expect(REST_ROUTES.fetchMarkets.scope).toBeNull();
    expect(REST_ROUTES.fetchBalance.scope).toBe('trade:read');
    expect(REST_ROUTES.createOrder.scope).toBe('trade:write');
  });

  it('exposes no withdrawal route — an API key must never move value off-platform', () => {
    const paths = Object.values(REST_ROUTES).map((r) => r.path);
    expect(paths.some((p) => /withdraw|payout|transfer/i.test(p))).toBe(false);
  });

  it('marks private WS channels as scoped', () => {
    expect(WS_CHANNELS.orderbook.private).toBe(false);
    expect(WS_CHANNELS.positions.private).toBe(true);
  });

  it('publishes the edge-enforced 300/min — not a dead 1200/600/20 contract', () => {
    expect(RATE_LIMITS.publicPerMinute).toBe(300);
    expect(RATE_LIMITS.privatePerMinute).toBe(300);
    expect('ordersPerSecond' in RATE_LIMITS).toBe(false);
    expect('weightPerMinute' in RATE_LIMITS).toBe(false);
  });

  it('declares a millisecond span for every timeframe', () => {
    for (const tf of TIMEFRAMES) {
      expect(TIMEFRAME_MS[tf], tf).toBeGreaterThan(0);
    }
  });

  it('keeps the CCXT error taxonomy so bot retry logic keeps working', () => {
    for (const code of ['InsufficientFunds', 'InvalidOrder', 'OrderNotFound', 'RateLimitExceeded'] as const) {
      expect(EXCHANGE_ERROR_CODES).toContain(code);
    }
  });

  /**
   * A capability this venue will never serve in its current shape is not a
   * retryable outage and not a bad request. Without its own class, a spot-only
   * venue has to answer `setLeverage` with something that reads as either
   * "try again" or "you sent that wrong", and a client acts on both.
   */
  it('carries NotSupported, distinct from every retryable class', () => {
    expect(EXCHANGE_ERROR_CODES).toContain('NotSupported');
    const parsed = exchangeErrorSchema.safeParse({
      code: 'NotSupported',
      message: 'BTC/USDT is a spot market and has no funding rate',
      intafacedCode: 'trade.funding_rate_spot_market',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an error code that is not in the CCXT taxonomy', () => {
    // Publishing our internal code as the class is the exact regression the
    // schema exists to stop.
    expect(exchangeErrorSchema.safeParse({ code: 'trade.market_not_found', message: 'x' }).success).toBe(false);
    expect(exchangeErrorSchema.safeParse({ code: 'MarketNotFound', message: 'x' }).success).toBe(false);
  });
});

describe('market precision', () => {
  function market(precision: { amount: unknown; price: unknown }) {
    return {
      id: 'm-1',
      symbol: 'EUR/USD',
      base: 'EUR',
      quote: 'USD',
      settle: null,
      baseId: 'EUR',
      quoteId: 'USD',
      type: 'spot',
      spot: true,
      swap: false,
      future: false,
      option: false,
      contract: false,
      linear: null,
      inverse: null,
      active: true,
      paper: false,
      schedule: 'fx-global' as const,
      sessionOpen: true,
      nextSessionChange: null,
      hours: {
        kind: 'sessions' as const,
        timezone: 'America/New_York',
        windows: [{ open: { day: 0, time: '17:00' }, close: { day: 5, time: '17:00' } }],
        holidays: [] as string[],
      },
      taker: '0.001',
      maker: '0.0005',
      contractSize: null,
      expiry: null,
      expiryDatetime: null,
      strike: null,
      optionType: null,
      precisionMode: 'TICK_SIZE',
      precision,
      limits: {
        amount: { min: '1000', max: null },
        price: { min: '0.00001', max: null },
        cost: { min: '1000', max: null },
        leverage: { min: null, max: null },
      },
    };
  }

  /**
   * Precision must be able to carry a lot size of 1000 — six of our own live
   * forex listings have exactly that. As a count of decimal places it collapses
   * to 0, and a client that rounds an amount to 0 places builds a quantity the
   * engine has to reject.
   */
  it('carries a tick and a lot as decimal strings, including values above one', () => {
    expect(marketSchema.safeParse(market({ amount: '1000', price: '0.00001' })).success).toBe(true);
    expect(marketSchema.safeParse(market({ amount: '10', price: '0.001' })).success).toBe(true);
    expect(marketSchema.safeParse(market({ amount: '0.0001', price: '0.01' })).success).toBe(true);
  });

  it('refuses a decimal-places integer where a tick size belongs', () => {
    expect(marketSchema.safeParse(market({ amount: 4, price: 2 })).success).toBe(false);
  });
});

describe('order exit marker', () => {
  const order = {
    id: 'o-1',
    clientOrderId: 'oco-1',
    timestamp: 1_760_000_000_000,
    datetime: '2025-10-09T08:53:20.000Z',
    lastTradeTimestamp: null,
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'sell',
    timeInForce: 'GTC',
    postOnly: false,
    reduceOnly: false,
    price: '110',
    stopPrice: null,
    average: null,
    amount: '1',
    filled: '0',
    remaining: '1',
    cost: '0',
    status: 'open',
    fee: null,
    trades: [],
  };

  it('carries the take-profit and stop-loss of an OCO parent, and the buy side stop-loss limit', () => {
    const parsed = orderSchema.parse({ ...order, exit: { kind: 'oco', takeProfit: '110', stopLoss: '90', stopLossLimit: null } });
    expect(parsed.exit).toEqual({ kind: 'oco', takeProfit: '110', stopLoss: '90', stopLossLimit: null });
    const buy = orderSchema.parse({
      ...order,
      side: 'buy',
      exit: { kind: 'bracket_exit', takeProfit: '90', stopLoss: '120', stopLossLimit: '125' },
    });
    expect(buy.exit?.stopLossLimit).toBe('125');
  });

  it('carries the caller tag on the order wire, null when none, absent on older wires', () => {
    expect(orderSchema.parse({ ...order, tag: 'desk-1' }).tag).toBe('desk-1');
    expect(orderSchema.parse({ ...order, tag: null }).tag).toBeNull();
    expect(orderSchema.parse(order).tag).toBeUndefined();
  });

  it('is absent on a plain order and on wires from before the field', () => {
    expect(orderSchema.parse(order).exit).toBeUndefined();
    expect(orderSchema.parse({ ...order, exit: null }).exit).toBeNull();
  });

  it('refuses a JSON-number price in the marker', () => {
    expect(() => orderSchema.parse({ ...order, exit: { kind: 'oco', takeProfit: 110, stopLoss: '90', stopLossLimit: null } })).toThrow();
    expect(() =>
      orderSchema.parse({ ...order, exit: { kind: 'trailing', takeProfit: '110', stopLoss: '90', stopLossLimit: null } }),
    ).toThrow();
  });
});
