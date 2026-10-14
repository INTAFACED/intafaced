// Illustrative data for the Coin page test only. NOT real balances or prices: invented but consistent, in the exact
// WIRE shapes the exchange REST API sends, so the real data layer and clients parse them. Markets, order preview and
// order placement come from the Buy card's own fixtures (../trade/buy/trade.fixtures.mjs).
import { book, markets as buyMarkets, wireTicker as buyTicker } from '../trade/buy/trade.fixtures.mjs';

export const HOUR = 3_600_000;
export const markets = buyMarkets;

// symbol -> [last, open 24 h ago, high 24 h, low 24 h, base volume 24 h]
const day = {
  'BTC/USDT': ['67812.40', '66000.00', '68100.50', '65800.25', '1234.5678'],
  'BTC/USDC': ['67790.10', '66010.00', '68090.00', '65810.00', '210.5'],
  'ETH/USDT': ['2602.31', '2594.00', '2640.10', '2560.00', '9120.25'],
  'ETH/USDC': ['2601.50', '2593.00', '2639.00', '2561.00', '1500'],
  'IFC/USDT': ['0.4120', '0.4210', '0.4300', '0.4050', '812345.5'],
};

/** /ticker/<symbol> and one entry of /tickers. `young` makes the window start three hours ago (a market listed today). */
export const wireTicker = (symbol, { young = false } = {}) => {
  const [last, open, high, low, volume] = day[symbol] ?? [];
  if (!last) return buyTicker(symbol);
  const now = Date.now();
  return {
    ...buyTicker(symbol),
    last,
    close: last,
    open,
    high,
    low,
    baseVolume: volume,
    quoteVolume: null,
    windowStart: young ? now - 3 * HOUR : now - 25 * HOUR,
  };
};
export const tickers = (options) => Object.fromEntries(Object.keys(day).map((symbol) => [symbol, wireTicker(symbol, options)]));

const STEP = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': HOUR, '4h': 4 * HOUR, '1d': 24 * HOUR, '1w': 7 * 24 * HOUR };

/**
 * /ohlcv/<symbol>: candles ending now on a gentle wave that finishes at the symbol's last price.
 * `history`: 'long' (as many as asked, weekly capped at 40 weeks), 'young' (three hours of trades), 'none' (never traded).
 */
export const candles = (symbol, timeframe, limit, history = 'long') => {
  const step = STEP[timeframe] ?? HOUR;
  const [last, open] = day[symbol] ?? ['100', '100'];
  const end = Math.floor(Date.now() / step) * step;
  let count = Math.min(limit, 1000);
  if (timeframe === '1w') count = Math.min(count, 40);
  if (history === 'none') return [];
  if (history === 'young') count = Math.max(1, Math.min(count, Math.ceil((3 * HOUR) / step)));
  const lastN = Number(last);
  const openN = Number(open);
  return Array.from({ length: count }, (_, i) => {
    const t = end - (count - 1 - i) * step;
    const progress = count === 1 ? 1 : i / (count - 1);
    const wave = Math.sin(i * 0.35) * 0.012 + Math.cos(i * 0.11) * 0.02;
    const level = openN + (lastN - openN) * progress;
    const close = i === count - 1 ? lastN : level * (1 + wave);
    const prior = i === 0 ? openN : level * (1 + wave * 0.9);
    const places = last.split('.')[1]?.length ?? 2;
    const f = (n) => n.toFixed(places);
    return [t, f(prior), f(Math.max(prior, close) * 1.002), f(Math.min(prior, close) * 0.998), i === count - 1 ? last : f(close), '1.25'];
  });
};

/** /account/trades: the person's fills, newest last in the list (the screen sorts them). BTC, ETH and a stale one. */
export const fills = () => {
  const now = Date.now();
  const make = (id, minutesAgo, symbol, side, price, amount) => {
    const cost = (Number(price) * Number(amount)).toFixed(6);
    const [base, quote] = symbol.split('/');
    return {
      id,
      order: `order-${id}`,
      timestamp: now - minutesAgo * 60_000,
      datetime: new Date(now - minutesAgo * 60_000).toISOString(),
      symbol,
      type: null,
      side,
      takerOrMaker: 'taker',
      price,
      amount,
      cost,
      fee:
        side === 'buy'
          ? { cost: (Number(amount) * 0.001).toFixed(8), currency: base, rate: '0.001' }
          : { cost: (Number(cost) * 0.001).toFixed(6), currency: quote, rate: '0.001' },
    };
  };
  return [
    make('f1', 5, 'BTC/USDT', 'buy', '67700.10', '0.00015'),
    make('f2', 55, 'ETH/USDT', 'buy', '2600.00', '0.5'),
    make('f3', 120, 'BTC/USDT', 'sell', '67500.00', '0.0002'),
    make('f4', 600, 'BTC/USDT', 'buy', '66900.00', '0.001'),
    make('f5', 1500, 'BTC/USDC', 'buy', '66500.00', '0.0004'),
    make('f6', 2900, 'BTC/USDT', 'buy', '65000.00', '0.002'),
    make('f7', 4300, 'BTC/USDT', 'sell', '64000.00', '0.0005'),
    make('f8', 5000, 'IFC/USDT', 'buy', '0.4100', '100'),
  ];
};

/** What the test account holds: 0.25 BTC, 2 ETH, 9,993 USDT, nothing of IFC. */
export const startingBalances = () => ({ USDT: '9993', BTC: '0.25', ETH: '2' });

export { book };
