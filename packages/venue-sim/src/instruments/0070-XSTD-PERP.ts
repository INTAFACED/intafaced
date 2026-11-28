import { parseAmount } from '@intafaced/ledger-client/money';
import { type TestInstrument } from './shared.js';

const instrument: TestInstrument = {
  market: {
    // J-derivatives-27 #7 to #10: a second TEST stock perpetual, listed by a TEST HIP-3 deployer that keeps its own margin
    // account for it (as a HIP-3 deployer's market is margined apart from the main account), with its own collateral and
    // margin mode and a cap on its open interest. Priced by the simulator's own TEST feed; it tracks no real company's share.
    symbol: 'XSTD-PERP',
    kind: 'perpetual',
    baseAsset: 'XSTD',
    quoteAsset: 'USDC',
    orderTypes: ['limit', 'market'],
    timeInForce: ['GTC', 'IOC'],
    marginModes: ['isolated'],
    maxLeverageBps: 100_000,
    tickSize: parseAmount('0.01'),
    lotSize: parseAmount('0.1'),
    makerFeeBps: { known: true, value: parseAmount('1') },
    takerFeeBps: { known: true, value: parseAmount('3') },
    // TEST: the same perpetual builder-fee cap as BTC-PERP.
    builderFeeCapBps: { known: true, value: parseAmount('10') },
    maintenanceMarginRate: parseAmount('0.02'),
    markPrice: parseAmount('100'),
    status: 'trading',
    maxOrderQty: parseAmount('1000'),
    maxOrderNotional: parseAmount('1000000'),
    listedBy: { kind: 'hip3', name: 'TEST stock margin deployer' },
    oracleRule:
      "TEST price feed: one XSTD/USD price for a TEST stock, set by the simulator's TEST control; it reads no outside share price.",
    markRule: 'The mark price is the feed price; fills do not move it.',
    tradingHours: '24/7 on the venue.',
    oracle: {
      staleRule: 'While the feed is stale the mark holds at the last feed price and only reduce-only orders are taken.',
    },
    marginAccount: { name: 'TEST stock margin deployer margin', collateralAsset: 'USDC', marginMode: 'isolated' },
    // TEST: room for every TEST order on it; J-derivatives-27 #8 lowers it for one step.
    openInterestCap: parseAmount('500'),
  },
  ladder: { mid: parseAmount('100'), step: parseAmount('0.1') },
};

export default instrument;
