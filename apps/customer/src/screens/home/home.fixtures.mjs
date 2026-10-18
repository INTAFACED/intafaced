// Illustrative data for the Home test only. Not real balances or prices: the numbers are invented but
// consistent, so the test can check the hero against the sum of its parts. These are WIRE shapes: the
// exact JSON the exchange REST API sends, so the real data layer (apps/customer/src/data) parses them.
export const HOUR = 3_600_000;

const wireMarket = (base, quote, tickSize, lotSize = '0.0001') => ({
  id: `${base}-${quote}`,
  symbol: `${base}-${quote}`,
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
  precision: { amount: lotSize, price: tickSize },
  limits: {
    amount: { min: null, max: null },
    price: { min: null, max: null },
    cost: { min: null, max: null },
    leverage: { min: null, max: null },
  },
});

export const markets = [
  wireMarket('BTC', 'USDT', '0.01'),
  wireMarket('ETH', 'USDT', '0.01'),
  wireMarket('IFC', 'USDT', '0.0001'),
  wireMarket('SOL', 'USDT', '0.01'),
  wireMarket('BTC', 'USDC', '0.01'),
  wireMarket('XRP', 'USDT', '0.0001'),
  wireMarket('DOGE', 'USDT', '0.00001'),
];

// symbol -> [last, open 24 h ago]
const prices = {
  'BTC-USDT': ['67812.40', '66000.00'],
  'ETH-USDT': ['3200.10', '3150.00'],
  'IFC-USDT': ['0.4120', '0.4210'],
  'SOL-USDT': ['142.55', '140.10'],
  'XRP-USDT': ['0.5230', '0.5120'],
  'DOGE-USDT': ['0.12345', '0.12987'],
};

const series = (seed, up) =>
  Array.from({ length: 24 }, (_, i) => {
    const wobble = Math.sin(i * 0.9 + seed) * 0.6 + Math.cos(i * 0.4 + seed * 2) * 0.4;
    return String(100 + (up ? i * 0.5 : -i * 0.5) + wobble * 3);
  });
const sparkline = {
  'BTC-USDT': series(1, true),
  'ETH-USDT': series(2, true),
  'IFC-USDT': series(3, false),
  'SOL-USDT': series(4, true),
  'XRP-USDT': series(5, true),
  'DOGE-USDT': series(6, false),
};

/** /tickers. `withOpen: false` leaves the 24 h fields empty, so the data layer derives them from hourly candles. `windowStart` is the server's own 24 h window start (epoch ms), as the live ticker sends it. */
export const tickers = ({ withOpen = true, windowStart = undefined } = {}) => {
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(prices).map(([symbol, [last, open]]) => [
      symbol,
      {
        symbol,
        timestamp: now,
        datetime: new Date(now).toISOString(),
        high: null,
        low: null,
        bid: null,
        bidVolume: null,
        ask: null,
        askVolume: null,
        vwap: null,
        open: withOpen ? open : null,
        close: last,
        last,
        previousClose: null,
        change: null,
        percentage: null,
        average: null,
        baseVolume: null,
        quoteVolume: null,
        sparkline: withOpen ? sparkline[symbol] : null,
        ...(windowStart === undefined ? {} : { windowStart }),
      },
    ]),
  );
};

/** /ohlcv/<symbol>: hourly candles starting `hours` hours ago, closing at the symbol's last price. */
export const hourlyCandles = (symbol, hours = 30) => {
  const [last, open] = prices[symbol] ?? ['1', '1'];
  const start = Math.floor((Date.now() - hours * HOUR) / HOUR) * HOUR;
  return Array.from({ length: hours + 1 }, (_, i) => [start + i * HOUR, open, last, open, i === hours ? last : open, '1']);
};

/** /account/balance */
export const balances = (extra = {}) => {
  const now = Date.now();
  const entry = (total) => ({ free: total, used: '0', total });
  return {
    timestamp: now,
    datetime: new Date(now).toISOString(),
    balances: { USDT: entry('4100.00'), BTC: entry('0.1'), ETH: entry('0.5'), ...extra },
  };
};
export const emptyBalances = () => ({ ...balances(), balances: {} });

// What the screen should show for the balances above (cents, no floats):
//   BTC 0.1 x 67812.40 = 6781.24, ETH 0.5 x 3200.10 = 1600.05, USDT 4100.00, total 12481.29.
//   Today = 0.1 x (67812.40 - 66000.00) + 0.5 x (3200.10 - 3150.00) = 181.24 + 25.05 = 206.29, on a prior 12275.00 (+1.68%).
export const holdings = [
  { asset: 'USDT', usdValue: '4100.00' },
  { asset: 'BTC', usdValue: '6781.24' },
  { asset: 'ETH', usdValue: '1600.05' },
];

// --- New-user checklist and activity (tRPC answers: { result: { data } }) --------------------------------------------
export const trpc = (data) => ({ result: { data } });

/** identity kyc.status */
export const kycAnswer = (tier = 'basic', records = []) => ({ tier, records });
export const kycPending = () =>
  kycAnswer('none', [
    {
      id: '00000000-0000-4000-8000-0000000000a1',
      userId: '00000000-0000-4000-8000-000000000001',
      tier: 'basic',
      jurisdiction: 'ID',
      status: 'pending',
      reviewedAt: null,
      expiresAt: null,
      createdAt: '2026-10-13T11:00:00Z',
    },
  ]);
/** identity webauthn.list */
export const passkeyList = (count = 1) =>
  Array.from({ length: count }, (_, index) => ({ credentialId: `cred${index}`, createdAt: '2026-10-13T11:00:00Z' }));
/** notify notify.alerts */
export const alertList = (items = [{ id: '00000000-0000-4000-8000-0000000000b1', kind: 'price', status: 'active' }]) => ({ items });
/** bank activity.list: newest first */
export const activityRow = (kind, direction, amount, asset = 'USDT', at = '2026-10-13T11:29:44Z') => ({
  id: `${kind}-${direction}-${amount}-${at}`,
  kind,
  direction,
  asset,
  amount,
  postedAt: at,
  txId: `tx-${kind}-${amount}`,
  counterparty: null,
  spaceName: null,
});
export const activityPage = (items, nextCursor = null) => ({ items, nextCursor });
export const establishedActivity = () =>
  activityPage([
    activityRow('trade', 'in', '0.1', 'BTC', '2026-10-13T12:00:00Z'),
    activityRow('trade', 'out', '6700', 'USDT', '2026-10-13T12:00:00Z'),
    activityRow('deposit', 'in', '10000', 'USDT', '2026-10-12T09:15:00Z'),
  ]);
