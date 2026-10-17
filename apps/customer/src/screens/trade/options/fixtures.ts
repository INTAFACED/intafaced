/**
 * TEST data for the harness and the tests. Every symbol starts with `TEST-` so nothing here can be mistaken for a real
 * listing. The real walk lists no option market; these rows stand in for one so the chain, ticket and orders can be seen.
 */
import type { ListedMarket, OptionsPolicy } from '../rooms/api';

type Row = Partial<ListedMarket> & Pick<ListedMarket, 'symbol' | 'optionType' | 'strike' | 'expiryDatetime'>;

function row(partial: Row): ListedMarket {
  const expiry = partial.expiryDatetime ? Date.parse(partial.expiryDatetime) : null;
  return {
    id: partial.symbol,
    base: 'BTC',
    quote: 'USDT',
    settle: 'USDT',
    baseId: 'BTC',
    quoteId: 'USDT',
    type: 'option',
    spot: false,
    swap: false,
    future: false,
    option: true,
    contract: true,
    linear: true,
    inverse: false,
    active: true,
    paper: true,
    schedule: 'crypto-24x7',
    sessionOpen: true,
    nextSessionChange: null,
    hours: { kind: 'continuous' },
    taker: '0.0003',
    maker: '0.0002',
    contractSize: '0.1',
    expiry,
    precisionMode: 'TICK_SIZE',
    precision: { amount: '0.1', price: '0.5' },
    limits: {
      amount: { min: '0.1', max: null },
      price: { min: null, max: null },
      cost: { min: null, max: null },
      leverage: { min: null, max: null },
    },
    orderable: true,
    ...partial,
  };
}

/** TEST contracts: paper calls and puts over two expiries, one live contract, one with incomplete terms, one closed. */
export const testChain: ListedMarket[] = [
  row({ symbol: 'TEST-BTC-25DEC26-60000-C', optionType: 'call', strike: '60000', expiryDatetime: '2026-12-25T08:00:00.000Z' }),
  row({ symbol: 'TEST-BTC-25DEC26-60000-P', optionType: 'put', strike: '60000', expiryDatetime: '2026-12-25T08:00:00.000Z' }),
  row({ symbol: 'TEST-BTC-25DEC26-70000-C', optionType: 'call', strike: '70000', expiryDatetime: '2026-12-25T08:00:00.000Z' }),
  row({ symbol: 'TEST-BTC-25DEC26-70000-P', optionType: 'put', strike: '70000', expiryDatetime: '2026-12-25T08:00:00.000Z' }),
  row({ symbol: 'TEST-BTC-26MAR27-65000-C', optionType: 'call', strike: '65000', expiryDatetime: '2027-03-26T08:00:00.000Z' }),
  row({ symbol: 'TEST-BTC-26MAR27-65000-P', optionType: 'put', strike: '65000', expiryDatetime: '2027-03-26T08:00:00.000Z' }),
  row({
    symbol: 'TEST-ETH-25DEC26-3000-C',
    base: 'ETH',
    baseId: 'ETH',
    optionType: 'call',
    strike: '3000',
    expiryDatetime: '2026-12-25T08:00:00.000Z',
    contractSize: '1',
  }),
  row({ symbol: 'TEST-BTC-LIVE-65000-C', optionType: 'call', strike: '65000', expiryDatetime: '2026-12-25T08:00:00.000Z', paper: false }),
  row({ symbol: 'TEST-BTC-NOTERMS-C', optionType: null, strike: null, expiryDatetime: null, contractSize: null }),
  row({
    symbol: 'TEST-BTC-CLOSED-80000-C',
    optionType: 'call',
    strike: '80000',
    expiryDatetime: '2026-12-25T08:00:00.000Z',
    sessionOpen: false,
    orderable: false,
  }),
];

/** TEST policy as it reads once paper options are allowed and live is still blocked. */
export const testPolicyPaper: OptionsPolicy = {
  settlementAssetLawStamped: false,
  settlementFixingConfigured: false,
  blockers: ['settlement asset law', 'fixing source'],
  residual: 'TEST policy: paper options allowed, live blocked.',
  statusLine: 'TEST',
  allowed: { optionsOrders: true, paperOptionsOrders: true, liveOptionsOrders: false },
  europeanOnly: true,
  fullCollateralV1: true,
};

/** TEST policy with live orders on, to see the live ticket path. */
export const testPolicyLive: OptionsPolicy = {
  ...testPolicyPaper,
  settlementAssetLawStamped: true,
  settlementFixingConfigured: true,
  blockers: [],
  allowed: { optionsOrders: true, paperOptionsOrders: true, liveOptionsOrders: true },
};
