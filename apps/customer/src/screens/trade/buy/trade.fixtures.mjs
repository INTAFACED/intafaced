// Illustrative data for the Buy and Convert tests only. NOT real balances or prices: invented but consistent, in the
// exact WIRE shapes the exchange REST API and the trade module send, so the real data layer and clients parse them.
// Limits match the local test stack's published ones (lot, tick, smallest order and smallest order value).
const SCALE = 10n ** 18n;
export const dec = (value) => {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
};
export const str = (value) => {
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
};
export const mul = (a, b) => str((dec(a) * dec(b)) / SCALE);
export const div = (a, b) => str((dec(a) * SCALE) / dec(b));
export const add = (a, b) => str(dec(a) + dec(b));
export const sub = (a, b) => str(dec(a) - dec(b));

const limits = (amountMin, costMin) => ({
  amount: { min: amountMin, max: null },
  price: { min: '0.01', max: null },
  cost: { min: costMin, max: null },
  leverage: { min: null, max: null },
});
const wireMarket = (base, quote, tickSize, lotSize, costMin = '5', extra = {}) => ({
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
  orderable: true,
  paper: false,
  schedule: 'crypto-24x7',
  sessionOpen: true,
  nextSessionChange: null,
  hours: { kind: 'continuous' },
  taker: '0.002',
  maker: '0.002',
  contractSize: null,
  expiry: null,
  expiryDatetime: null,
  strike: null,
  optionType: null,
  precisionMode: 'TICK_SIZE',
  precision: { amount: lotSize, price: tickSize },
  limits: limits(lotSize, costMin),
  lifecycle: { state: 'OPEN' },
  ...extra,
});

export const markets = [
  wireMarket('BTC', 'USDT', '0.01', '0.00001'),
  wireMarket('BTC', 'USDC', '0.01', '0.00001'),
  wireMarket('ETH', 'USDT', '0.01', '0.0001'),
  wireMarket('ETH', 'USDC', '0.01', '0.0001'),
  wireMarket('IFC', 'USDT', '0.0001', '0.01'),
  // Present on the stack but not open: must never be offered.
  wireMarket('BRENT', 'USD', '0.01', '1', '10', { lifecycle: { state: 'REFUSED' } }),
];

// symbol -> [bid, ask, last, open 24 h ago]
export const book = {
  'BTC/USDT': ['65070.29', '65083.66', '64815.49', '65205.40'],
  'BTC/USDC': ['65060.00', '65090.00', '64820.00', '65200.00'],
  'ETH/USDT': ['2601.95', '2602.84', '2602.31', '2594.00'],
  'ETH/USDC': ['2600.00', '2604.00', '2602.00', '2594.00'],
  'IFC/USDT': ['0.4110', '0.4130', '0.4120', '0.4210'],
};

export const wireTicker = (symbol) => {
  const [bid, ask, last, open] = book[symbol];
  const now = Date.now();
  return {
    symbol,
    timestamp: now,
    datetime: new Date(now).toISOString(),
    high: null,
    low: null,
    bid,
    bidVolume: '0.04',
    ask,
    askVolume: '0.04',
    vwap: null,
    open,
    close: last,
    last,
    previousClose: null,
    change: null,
    percentage: null,
    average: null,
    baseVolume: '1.5',
    quoteVolume: '100000',
    sparkline: null,
    windowStart: now - 25 * 3600_000,
  };
};
export const tickers = () => Object.fromEntries(Object.keys(book).map((symbol) => [symbol, wireTicker(symbol)]));

export const wireBalances = (balances) => {
  const now = Date.now();
  return {
    timestamp: now,
    datetime: new Date(now).toISOString(),
    balances: Object.fromEntries(Object.entries(balances).map(([asset, free]) => [asset, { free, used: '0', total: free }])),
  };
};
/** The test account of the stack: 10,000 USDT-ish, 0.25 BTC, 2 ETH (less a few small test transfers). */
export const startingBalances = () => ({ USDT: '9993', BTC: '0.25', ETH: '2' });

/** What the service's order preview says: fee 0.1 % in the coin for a buy and in dollars for a sell, protection 0.5 % past the touch. */
export const previewFor = (draft, overrides = {}) => {
  const [bid, ask] = book[draft.symbol];
  const buy = draft.side === 'buy';
  const protection = buy ? mul(ask, '1.005') : mul(bid, '0.995');
  const base = draft.symbol.split('/')[0];
  const quote = draft.symbol.split('/')[1];
  return {
    symbol: draft.symbol,
    side: draft.side,
    type: draft.type,
    amount: draft.amount,
    price: null,
    timeInForce: draft.timeInForce,
    holdAsset: buy ? quote : base,
    holdAmount: buy ? mul(draft.amount, protection) : draft.amount,
    protectionPrice: protection,
    estimatedFee: buy ? mul(draft.amount, '0.001') : mul(mul(draft.amount, bid), '0.001'),
    feeAsset: buy ? base : quote,
    feeBps: 10,
    feeRole: 'taker',
    orderable: true,
    refusals: [],
    ...overrides,
  };
};

/**
 * A filled market order as the service really returns it (checked on the local stack): `cost` comes from the reserved
 * protection price, not from the fills; `average`, `fee` and `trades` are empty. The real record is the fill below.
 */
export const orderFor = (draft, id = 'order-1') => {
  const [bid, ask] = book[draft.symbol];
  const reserved = draft.side === 'buy' ? mul(ask, '1.005') : mul(bid, '0.995');
  const now = Date.now();
  return {
    id,
    clientOrderId: draft.clientOrderId,
    timestamp: now,
    datetime: new Date(now).toISOString(),
    lastTradeTimestamp: null,
    symbol: draft.symbol,
    type: 'market',
    side: draft.side,
    timeInForce: 'IOC',
    postOnly: false,
    reduceOnly: false,
    price: null,
    stopPrice: null,
    average: null,
    amount: draft.amount,
    filled: draft.amount,
    remaining: '0',
    cost: mul(draft.amount, reserved),
    status: 'closed',
    fee: null,
    trades: [],
    recoveryRequired: false,
    recoveryReason: null,
    reconciliationKey: null,
  };
};

/** The ledger's record of that order: the price really paid, its cost and its fee (0.1 %, in the coin on a buy, in dollars on a sell). */
export const fillOf = (draft, orderId) => {
  const [bid, ask] = book[draft.symbol];
  const price = draft.side === 'buy' ? ask : bid;
  const cost = mul(draft.amount, price);
  const [base, quote] = draft.symbol.split('/');
  const now = Date.now();
  return {
    id: `fill-of-${orderId}`,
    order: orderId,
    timestamp: now,
    datetime: new Date(now).toISOString(),
    symbol: draft.symbol,
    type: null,
    side: draft.side,
    takerOrMaker: 'taker',
    price,
    amount: draft.amount,
    cost,
    fee:
      draft.side === 'buy'
        ? { cost: mul(draft.amount, '0.001'), currency: base, rate: '0.001' }
        : { cost: mul(cost, '0.001'), currency: quote, rate: '0.001' },
  };
};

let quoteCounter = 0;
/** A firm convert quote: the book price plus a 20 bps spread, held 15 s. */
export const quoteFor = ({ symbol, side, qty }, { ttlMs = 15_000, spreadBps = 20 } = {}) => {
  const [bid, ask] = book[symbol];
  const [base, quote] = symbol.split('/');
  const now = Date.now();
  const touch = side === 'buy' ? ask : bid;
  const bookNotional = mul(qty, touch);
  const factor =
    side === 'buy' ? add('1', str((BigInt(spreadBps) * SCALE) / 10_000n)) : sub('1', str((BigInt(spreadBps) * SCALE) / 10_000n));
  const userNotional = mul(bookNotional, factor);
  quoteCounter += 1;
  return {
    quoteId: `quote-${quoteCounter}`,
    symbol,
    side,
    requestedQty: qty,
    filledQty: qty,
    bookNotional,
    userNotional,
    avgPrice: div(userNotional, qty),
    fullyFilled: true,
    convertSpreadBps: spreadBps,
    expiresAt: new Date(now + ttlMs).toISOString(),
    source: { kind: 'book', symbol, asOf: new Date(now).toISOString() },
    inAsset: side === 'buy' ? quote : base,
    outAsset: side === 'buy' ? base : quote,
    inAmount: side === 'buy' ? userNotional : qty,
    outAmount: side === 'buy' ? qty : userNotional,
  };
};

export const fillFor = (quote) => {
  const now = new Date().toISOString();
  return {
    quoteId: quote.quoteId,
    fillId: `fill-${quote.quoteId}`,
    takerOrderId: `taker-${quote.quoteId}`,
    makerOrderId: `maker-${quote.quoteId}`,
    symbol: quote.symbol,
    side: quote.side,
    inAsset: quote.inAsset,
    outAsset: quote.outAsset,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    fillPrice: quote.avgPrice,
    fillNotional: quote.userNotional,
    convertSpreadBps: quote.convertSpreadBps,
    source: quote.source,
    expiresAt: quote.expiresAt,
    acceptedAt: now,
    settledAt: now,
  };
};
