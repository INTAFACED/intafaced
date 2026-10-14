// Illustrative data for the Markets test only. Not real prices: the numbers are invented but consistent.
// These are WIRE shapes: the exact JSON the exchange REST API sends, so the real data layer parses them.

export const wireMarket = (base, quote, tickSize, extra = {}) => ({
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
  taker: '0.001',
  maker: '0.001',
  contractSize: null,
  expiry: null,
  expiryDatetime: null,
  strike: null,
  optionType: null,
  precisionMode: 'TICK_SIZE',
  precision: { amount: '0.0001', price: tickSize },
  limits: {
    amount: { min: null, max: null },
    price: { min: null, max: null },
    cost: { min: null, max: null },
    leverage: { min: null, max: null },
  },
  ...extra,
});

// symbol -> [tick, open 24h ago, last, low, high, quote volume]
const table = {
  'BTC/USDT': ['0.01', '66000.00', '67812.40', '65800.00', '68200.00', '91234567.00'],
  'ETH/USDT': ['0.01', '3150.00', '3200.10', '3120.00', '3240.00', '41234567.00'],
  'IFC/USDT': ['0.0001', '0.4210', '0.4120', '0.4050', '0.4300', '1234567.00'],
  'SOL/USDT': ['0.01', '140.10', '142.55', '138.00', '144.00', '8765432.00'],
  'XRP/USDT': ['0.0001', '0.5120', '0.5230', '0.5050', '0.5300', '5234567.00'],
  'DOGE/USDT': ['0.00001', '0.12987', '0.12345', '0.12100', '0.13100', '3234567.00'],
  'BTC/USDC': ['0.01', '66010.00', '67800.00', '65900.00', '68150.00', '765432.00'],
  'ETH/USDC': ['0.01', '3150.50', '3199.00', '3125.00', '3235.00', '165432.00'],
};

export const markets = [
  ...Object.keys(table).map((symbol) => {
    const [base, quote] = symbol.split('/');
    const extra =
      base === 'IFC' ? { listedAt: '2026-10-09T08:00:00.000Z' } : base === 'SOL' ? { listedAt: '2026-09-28T08:00:00.000Z' } : {};
    return wireMarket(base, quote, table[symbol][0], extra);
  }),
  // Never shown: a simulated market, a market that is not open, and one the service will not take orders on.
  wireMarket('SIM', 'USDT', '0.01', { paper: true }),
  wireMarket('HALT', 'USDT', '0.01', { lifecycle: { state: 'HALTED' } }),
  wireMarket('LOCK', 'USDT', '0.01', { orderable: false }),
];

const series = (seed, up) =>
  Array.from({ length: 24 }, (_, i) => {
    const wobble = Math.sin(i * 0.9 + seed) * 0.6 + Math.cos(i * 0.4 + seed * 2) * 0.4;
    return String(100 + (up ? i * 0.5 : -i * 0.5) + wobble * 3);
  });

const wireTicker = (symbol, now, [, open, last, low, high, quoteVolume], seed) => ({
  symbol,
  timestamp: now,
  datetime: new Date(now).toISOString(),
  high,
  low,
  bid: null,
  bidVolume: null,
  ask: null,
  askVolume: null,
  vwap: null,
  open,
  close: last,
  last,
  previousClose: null,
  change: null,
  percentage: null,
  average: null,
  baseVolume: '1234.5',
  quoteVolume,
  sparkline: series(seed, Number(last) >= Number(open)),
});

/** /tickers for the named markets. */
export const tickers = (rows = table) => {
  const now = Date.now();
  return Object.fromEntries(Object.entries(rows).map(([symbol, row], i) => [symbol, wireTicker(symbol, now, row, i + 1)]));
};

/** `count` extra dollar markets (COIN001/USDT ...), to exercise the windowed table past 50 rows. */
export const manyMarkets = (count) => {
  const rows = Array.from({ length: count }, (_, i) => {
    const base = `COIN${String(i + 1).padStart(3, '0')}`;
    return [`${base}/USDT`, ['0.01', '10.00', String(10 + (i % 7) - 3) + '.00', '9.00', '14.00', String(1000 + i * 10) + '.00']];
  });
  return {
    markets: [...markets, ...rows.map(([symbol, row]) => wireMarket(symbol.split('/')[0], 'USDT', row[0]))],
    tickers: tickers({ ...table, ...Object.fromEntries(rows) }),
  };
};
