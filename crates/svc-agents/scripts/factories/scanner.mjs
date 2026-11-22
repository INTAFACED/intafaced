// The scanner's parity cases (`record-factories.mjs`): every pure call under blank, partial and published laws, and
// the metered run's refusals before any session. A case's `port` is svc-trade's tickers answer, served to the real HTTP
// port by a fake fetch (`{ status, body }`, or `{ throws: true }`).

const SCANNER = (matrix) => JSON.stringify({ scanner: { published: true, matrix } });
const FULL = SCANNER({ basic: { maxSignals: 2, tools: ['trade.ticker', 'trade.markets.list', 'trade.book.top'] } });
const DEEP = SCANNER({ basic: { maxSignals: 5, tools: ['trade.ticker'] } });
const NO_TICKER = SCANNER({ basic: { maxSignals: 3, tools: ['trade.markets.list'] } });
const ZERO = SCANNER({ basic: { maxSignals: 0, tools: ['trade.ticker'] } });
const EMPTY = JSON.stringify({ scanner: { published: true, matrix: {} } });
const UNPUBLISHED = JSON.stringify({ scanner: { published: false } });
const SEALED = {
  published: true,
  p0_11: 'sealed',
  allowedInputs: ['last', 'volume24h', 'change24hBps'],
  rankingRecipeId: 'abs_change_x_log_volume',
};
const NOW = '2026-11-19T00:00:00.000Z';

const t = (marketId, last, volume24h, change24hBps, asOf = '2026-11-18T23:59:30.000Z', maxAgeMs = 120000) => ({
  marketId,
  last,
  volume24h,
  change24hBps,
  asOf,
  maxAgeMs,
});
const BOARD = [
  t('btc-usdt', '100', '1000', 50),
  t('eth-usdt', '10', '1000', -50),
  t('sol-usdt', '1', '50000', 20),
  t('BTC-usdt', '100', '1000', 50),
  t('ada-usdt', '0', '0', 0),
  t('dot-usdt', '-1', '10', 5),
  t('xrp-usdt', '1', '-5', 5),
  t('ltc-usdt', null, '10', 5),
  t('old-usdt', '1', '10', 5, '2026-11-18T23:00:00.000Z', 60000),
  t('fut-usdt', '1', '10', 5, '2026-11-19T00:00:01.000Z'),
  t('big-usdt', '12345678901234567890.123456789012345678', '99999999999999999999.999999999999999999', 9999),
  t('odd-usdt', '1', '1.5', 33, 'Nov 18 2026 23:59:00 GMT'),
  t('spc-usdt', '1', '2', 7, '2026-11-18 23:59:00'),
  t('bad-usdt', '1', '2', 7, 'not a date'),
];

const rankCases = [
  ['law omitted', { fixtures: BOARD, limit: 5, now: NOW }],
  ['law null', { fixtures: BOARD, limit: 5, now: NOW, signalInputsLaw: null }],
  ['law unpublished', { fixtures: BOARD, limit: 5, now: NOW, signalInputsLaw: { published: false } }],
  ['inputs empty', { fixtures: BOARD, limit: 5, now: NOW, signalInputsLaw: { ...SEALED, allowedInputs: [] } }],
  ['required input missing', { fixtures: BOARD, limit: 5, now: NOW, signalInputsLaw: { ...SEALED, allowedInputs: ['last', 'spread'] } }],
  ['no limit', { fixtures: BOARD, now: NOW, signalInputsLaw: SEALED }],
  ['dark plane', { fixtures: BOARD, limit: 5, now: NOW, signalInputsLaw: SEALED, marketPlane: 'dark' }],
  ['the board', { fixtures: BOARD, limit: 20, now: NOW, signalInputsLaw: SEALED, marketPlane: 'live' }],
  ['the board, a page of 2', { fixtures: BOARD, limit: 2, now: NOW, signalInputsLaw: SEALED }],
  ['an allowlist', { fixtures: BOARD, limit: 5, now: NOW, signalInputsLaw: SEALED, marketAllowlist: ['sol-usdt', 'old-usdt', 'nope'] }],
  ['an empty allowlist', { fixtures: BOARD, limit: 5, now: NOW, signalInputsLaw: SEALED, marketAllowlist: [] }],
  ['an allowlist matching nothing', { fixtures: BOARD, limit: 5, now: NOW, signalInputsLaw: SEALED, marketAllowlist: ['nope'] }],
  ['nothing', { fixtures: [], limit: 5, now: NOW, signalInputsLaw: SEALED }],
  ['only stale', { fixtures: [BOARD[8]], limit: 5, now: NOW, signalInputsLaw: SEALED }],
  ['stale and incomplete', { fixtures: [BOARD[8], BOARD[7]], limit: 5, now: NOW, signalInputsLaw: SEALED }],
  ['the clock, no now', { fixtures: [t('btc-usdt', '1', '1', 1, '2026-11-18T23:59:59.000Z')], limit: 5, signalInputsLaw: SEALED }],
  [
    'ties: volume, then the id',
    {
      fixtures: [
        t('b-x', '1', '10', 10),
        t('a-x', '1', '10', 10),
        t('A-x', '1', '10', 10),
        t('c-x', '1', '20', 10),
        t('a_x', '1', '10', 10),
        t('a1', '1', '10', 10),
      ],
      limit: 10,
      now: NOW,
      signalInputsLaw: SEALED,
    },
  ],
  [
    'fractional volumes',
    {
      fixtures: [
        t('m1', '0.000000000000000001', '0.000000000000000001', 1),
        t('m2', '3', '0.5', 3),
        t('m3', '3', '123456.789', -7),
        t('m4', '3', '7', 0),
      ],
      limit: 10,
      now: NOW,
      signalInputsLaw: SEALED,
    },
  ],
];

const tool = (name, input, laws = FULL, extra = {}) => ({
  name,
  path: 'scanner.invokeDataTool',
  input: { now: NOW, ...input },
  laws,
  ...extra,
});
const ok = t('btc-usdt', '100', '1000', 50);

export const cases = [
  { name: 'policy', path: 'scanner.policy' },
  { name: 'stage2Guardrail', path: 'scanner.stage2Guardrail' },
  { name: 'tierGate: no law', path: 'scanner.tierGate', input: {} },
  { name: 'tierGate: unpublished', path: 'scanner.tierGate', input: {}, laws: UNPUBLISHED },
  { name: 'tierGate: empty matrix', path: 'scanner.tierGate', input: {}, laws: EMPTY },
  { name: 'tierGate: granted', path: 'scanner.tierGate', input: {}, laws: FULL },
  { name: 'tierGate: another tier', path: 'scanner.tierGate', input: {}, laws: FULL, tier: 'full' },
  { name: 'tierGate: no tier', path: 'scanner.tierGate', input: {}, laws: FULL, tier: '' },
  { name: 'tierGate: a padded tier', path: 'scanner.tierGate', input: {}, laws: FULL, tier: ' basic ' },
  { name: 'tierGate: depth 0', path: 'scanner.tierGate', input: {}, laws: ZERO },
  ...rankCases.map(([name, input]) => ({ name: `rankFixtures: ${name}`, path: 'scanner.rankFixtures', input })),
  tool('a money write', { tool: 'ledger.post', plane: 'live' }),
  tool('a live write', { tool: 'trade.order', plane: 'dark' }),
  tool('dark', { tool: 'trade.ticker', plane: 'dark', ticker: ok }),
  tool('no law', { tool: 'trade.ticker', plane: 'live', ticker: ok }, null),
  tool('not granted', { tool: 'trade.ticker', plane: 'live', ticker: ok }, FULL, { tier: 'other' }),
  tool('undeclared', { tool: 'trade.funding', plane: 'live' }),
  tool('not in tier', { tool: 'trade.ticker', plane: 'live', ticker: ok }, NO_TICKER),
  tool('ticker: padded name', { tool: ' trade.ticker ', plane: 'live', ticker: ok }),
  tool('ticker: ok', { tool: 'trade.ticker', plane: 'live', ticker: ok }),
  tool('ticker: missing', { tool: 'trade.ticker', plane: 'live' }),
  tool('ticker: null', { tool: 'trade.ticker', plane: 'live', ticker: null }),
  tool('ticker: blank id', { tool: 'trade.ticker', plane: 'live', ticker: { ...ok, marketId: '  ' } }),
  tool('ticker: incomplete', { tool: 'trade.ticker', plane: 'live', ticker: { ...ok, change24hBps: null } }),
  tool('ticker: exponent', { tool: 'trade.ticker', plane: 'live', ticker: { ...ok, last: '1e5' } }),
  tool('ticker: negative', { tool: 'trade.ticker', plane: 'live', ticker: { ...ok, volume24h: '-1' } }),
  tool('ticker: 19 places', { tool: 'trade.ticker', plane: 'live', ticker: { ...ok, last: '1.1234567890123456789' } }),
  tool('ticker: 18 places', { tool: 'trade.ticker', plane: 'live', ticker: { ...ok, last: '1.123456789012345678' } }),
  tool('ticker: stale', { tool: 'trade.ticker', plane: 'live', ticker: { ...ok, asOf: '2026-11-18T00:00:00.000Z' } }),
  tool('ticker: future', { tool: 'trade.ticker', plane: 'live', ticker: { ...ok, asOf: '2026-11-19T00:00:00.001Z' } }),
  tool('ticker: unparsed time', { tool: 'trade.ticker', plane: 'live', ticker: { ...ok, asOf: 'yesterday' } }),
  tool('markets: ok', {
    tool: 'trade.markets.list',
    plane: 'live',
    markets: [
      { marketId: 'btc-usdt', symbol: 'BTC/USDT', status: 'open' },
      { marketId: 'x', symbol: 'X', status: 'halted' },
    ],
  }),
  tool('markets: none', { tool: 'trade.markets.list', plane: 'live', markets: [] }),
  tool('markets: absent', { tool: 'trade.markets.list', plane: 'live' }),
  tool('markets: blank symbol', {
    tool: 'trade.markets.list',
    plane: 'live',
    markets: [{ marketId: 'btc-usdt', symbol: ' ', status: 'open' }],
  }),
  tool('book: ok', {
    tool: 'trade.book.top',
    plane: 'live',
    bookTop: { marketId: 'btc-usdt', bid: '99.5', ask: '100.5', asOf: '2026-11-18T23:59:59.000Z', maxAgeMs: 5000 },
  }),
  tool('book: incomplete', {
    tool: 'trade.book.top',
    plane: 'live',
    bookTop: { marketId: 'btc-usdt', bid: null, ask: '1', asOf: NOW, maxAgeMs: 5000 },
  }),
  tool('book: invalid', {
    tool: 'trade.book.top',
    plane: 'live',
    bookTop: { marketId: 'btc-usdt', bid: '1', ask: '.5', asOf: NOW, maxAgeMs: 5000 },
  }),
  tool('book: stale', {
    tool: 'trade.book.top',
    plane: 'live',
    bookTop: { marketId: 'btc-usdt', bid: '1', ask: '2', asOf: '2026-11-18T23:00:00.000Z', maxAgeMs: 5000 },
  }),
  tool('book: missing', { tool: 'trade.book.top', plane: 'live' }),
  tool('book: clock', {
    tool: 'trade.book.top',
    plane: 'live',
    now: undefined,
    bookTop: { marketId: 'btc-usdt', bid: '1', ask: '2', asOf: '2026-11-18T23:59:59.000Z', maxAgeMs: 5000 },
  }),
  ...[
    ['law blank', { plane: 'live', tickers: BOARD.slice(0, 3), now: NOW }, DEEP],
    ['dark', { plane: 'dark', signalInputsLaw: SEALED, tickers: BOARD.slice(0, 3), now: NOW }, DEEP],
    ['no tier law', { plane: 'live', signalInputsLaw: SEALED, tickers: BOARD.slice(0, 3), now: NOW }, null],
    ['no ticker tool', { plane: 'live', signalInputsLaw: SEALED, tickers: BOARD.slice(0, 3), now: NOW }, NO_TICKER],
    ['the board', { plane: 'live', signalInputsLaw: SEALED, tickers: BOARD, now: NOW }, DEEP],
    ['the board, an allowlist', { plane: 'live', signalInputsLaw: SEALED, tickers: BOARD, now: NOW, marketAllowlist: ['eth-usdt'] }, DEEP],
    ['every ticker refused', { plane: 'live', signalInputsLaw: SEALED, tickers: [BOARD[7], BOARD[8]], now: NOW }, DEEP],
    ['no tickers', { plane: 'live', signalInputsLaw: SEALED, tickers: [], now: NOW }, DEEP],
  ].map(([name, input, laws]) => ({ name: `rankLive: ${name}`, path: 'scanner.rankLive', input, laws })),
  ...[
    ['law blank', { plane: 'live', tickers: [] }, DEEP],
    ['law unpublished', { plane: 'live', tickers: [], signalInputsLaw: { published: false } }, DEEP],
    ['dark', { plane: 'dark', signalInputsLaw: SEALED, tickers: [ok] }, DEEP],
    ['no tier law', { plane: 'live', signalInputsLaw: SEALED, tickers: [ok] }, null],
    [
      'another tier',
      { plane: 'live', signalInputsLaw: SEALED, tickers: [ok] },
      SCANNER({ full: { maxSignals: 3, tools: ['trade.ticker'] } }),
    ],
    ['depth 0', { plane: 'live', signalInputsLaw: SEALED, tickers: [ok] }, ZERO],
    ['no ticker tool', { plane: 'live', signalInputsLaw: SEALED, tickers: [ok] }, NO_TICKER],
    ['live, no port', { plane: 'live', signalInputsLaw: SEALED, tickers: [ok], tickersLimit: 5 }, DEEP],
    ['an unknown plane', { plane: 'fixtures', signalInputsLaw: SEALED, tickers: [] }, DEEP],
  ].map(([name, input, laws]) => ({ name: `runSession: ${name}`, path: 'scanner.runSession', input, laws })),
  ...[
    ['no page size', { plane: 'live', signalInputsLaw: SEALED, tickers: [] }, { status: 200, body: {} }],
    ['trade down', { plane: 'live', signalInputsLaw: SEALED, tickers: [], tickersLimit: 5 }, { throws: true }],
    ['trade 503', { plane: 'live', signalInputsLaw: SEALED, tickers: [], tickersLimit: 5 }, { status: 503, body: {} }],
    ['an array', { plane: 'live', signalInputsLaw: SEALED, tickers: [], tickersLimit: 5 }, { status: 200, body: [] }],
    [
      'no row with a last price',
      {
        plane: 'live',
        signalInputsLaw: SEALED,
        tickers: [ok],
        tickersLimit: 5,
      },
      {
        status: 200,
        body: {
          'BTC/USDT': { symbol: 'BTC/USDT', timestamp: 1, last: ' ', quoteVolume: '1', baseVolume: null, percentage: '1' },
          'ETH/USDT': { symbol: 'SOL/USDT', timestamp: 1, last: '1', quoteVolume: null, baseVolume: null, percentage: null },
          'X/Y': { symbol: 'X/Y', last: '1' },
        },
      },
    ],
    [
      'an invalid time',
      { plane: 'live', signalInputsLaw: SEALED, tickers: [], tickersLimit: 5 },
      {
        status: 200,
        body: { 'BTC/USDT': { symbol: 'BTC/USDT', timestamp: 9e15, last: '1', quoteVolume: '1', baseVolume: null, percentage: '1' } },
      },
    ],
  ].map(([name, input, port]) => ({ name: `runSession, live port: ${name}`, path: 'scanner.runSession', input, laws: DEEP, port })),
  {
    name: 'runSession: a key may not run',
    path: 'scanner.runSession',
    input: { plane: 'live', tickers: [] },
    laws: DEEP,
    scopes: ['agents:read'],
  },
];

export async function deps(c) {
  if (c.port === undefined) return {};
  const { createHttpSpotTickersPort } = await import(
    new URL('../../../../services/svc-agents/src/scanner/trade-tickers-http-port.ts', import.meta.url).href
  );
  const fetchImpl = async () => {
    if (c.port.throws) throw new Error('connect ECONNREFUSED');
    return new Response(JSON.stringify(c.port.body), { status: c.port.status, headers: { 'content-type': 'application/json' } });
  };
  return { spotTickersPort: createHttpSpotTickersPort({ tradeUrl: 'http://trade.test/', fetchImpl }) };
}
