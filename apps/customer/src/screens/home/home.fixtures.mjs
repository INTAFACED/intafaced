// Illustrative data for the Home test only. Not real balances or prices: the numbers are invented
// but consistent, so the test can check the hero against the sum of its parts.
const market = (base, quote, tickSize, lotSize = '0.0001') => ({
  symbol: `${base}-${quote}`,
  base,
  quote,
  orderable: true,
  tickSize,
  lotSize,
  minAmount: null,
  listedAt: null,
});

export const markets = [
  market('BTC', 'USDT', '0.01'),
  market('ETH', 'USDT', '0.01'),
  market('IFC', 'USDT', '0.0001'),
  market('SOL', 'USDT', '0.01'),
  market('BTC', 'USDC', '0.01'),
  market('XRP', 'USDT', '0.0001'),
  market('DOGE', 'USDT', '0.00001'),
];

const ticker = (symbol, last, open, windowStart = null) => ({
  symbol,
  last,
  bid: null,
  ask: null,
  open24h: open,
  high24h: null,
  low24h: null,
  change24h: null,
  changePct24h: null,
  baseVolume24h: null,
  quoteVolume24h: null,
  windowStart,
  source: 'derived',
});
const withPct = (row, pct) => ({ ...row, changePct24h: pct });

export const tickers = {
  'BTC-USDT': withPct(ticker('BTC-USDT', '67812.40', '66000.00'), '0.02746'),
  'ETH-USDT': withPct(ticker('ETH-USDT', '3200.10', '3150.00'), '0.0159'),
  'IFC-USDT': withPct(ticker('IFC-USDT', '0.4120', '0.4210'), '-0.02138'),
  'SOL-USDT': withPct(ticker('SOL-USDT', '142.55', '140.10'), '0.01749'),
  'XRP-USDT': withPct(ticker('XRP-USDT', '0.5230', '0.5120'), '0.02148'),
  'DOGE-USDT': withPct(ticker('DOGE-USDT', '0.12345', '0.12987'), '-0.04943'),
};

const series = (seed, up) =>
  Array.from({ length: 24 }, (_, i) => {
    const wobble = Math.sin(i * 0.9 + seed) * 0.6 + Math.cos(i * 0.4 + seed * 2) * 0.4;
    return String(100 + (up ? i * 0.5 : -i * 0.5) + wobble * 3);
  });
export const sparklines = {
  'BTC-USDT': series(1, true),
  'ETH-USDT': series(2, true),
  'IFC-USDT': series(3, false),
  'SOL-USDT': series(4, true),
  'XRP-USDT': series(5, true),
  'DOGE-USDT': series(6, false),
};

const holding = (asset, cls, total, usdValue, usdChange24h, share, priceSymbol) => ({
  asset,
  class: cls,
  total,
  available: total,
  inOrders: '0',
  usdValue,
  usdChange24h,
  share,
  priceSymbol,
});
export const holdings = [
  holding('USDT', 'cash', '4100.00', '4100.00', '0', '0.3285', null),
  holding('BTC', 'crypto', '0.1', '6781.24', '181.24', '0.5433', 'BTC-USDT'),
  holding('ETH', 'crypto', '0.5', '1600.05', '25.05', '0.1282', 'ETH-USDT'),
];
export const portfolio = {
  totalUsd: '12481.29',
  change24hUsd: '206.25',
  change24hPct: '0.0168',
  cashUsd: '4100.00',
  cryptoUsd: '8381.29',
  holdings,
  unpriced: [],
  source: 'derived',
  asOf: 0,
};

export const movers = {
  gainers: ['BTC-USDT', 'XRP-USDT', 'SOL-USDT', 'ETH-USDT'].map((s) => tickers[s]),
  losers: ['DOGE-USDT', 'IFC-USDT'].map((s) => tickers[s]),
};

export const ready = (data) => ({ kind: 'ready', data });
export const scenario = {
  portfolio: ready(portfolio),
  markets: ready(markets),
  tickers: ready(tickers),
  sparklines: ready(sparklines),
  movers: ready(movers),
};
