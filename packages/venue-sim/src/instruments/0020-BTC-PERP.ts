import { parseAmount } from '@intafaced/ledger-client/money';
import { VENUE_LISTED, type TestInstrument } from './shared.js';

const instrument: TestInstrument = {
  market: {
    symbol: 'BTC-PERP',
    kind: 'perpetual',
    baseAsset: 'BTC',
    quoteAsset: 'USDC',
    orderTypes: ['limit', 'market'],
    timeInForce: ['GTC', 'IOC'],
    marginModes: ['isolated'],
    maxLeverageBps: 200_000,
    tickSize: parseAmount('1'),
    lotSize: parseAmount('0.0001'),
    makerFeeBps: { known: true, value: parseAmount('1.5') },
    takerFeeBps: { known: true, value: parseAmount('4.5') },
    // TEST: the venue's own cap on a builder fee, 0.1% on perpetuals (the figure Hyperliquid publishes for its builder codes).
    builderFeeCapBps: { known: true, value: parseAmount('10') },
    maintenanceMarginRate: parseAmount('0.005'),
    markPrice: parseAmount('60000'),
    // TEST: one contract is one BTC, and the venue publishes a TEST hourly funding rate of 0.00125% (it settles none).
    contractSize: parseAmount('1'),
    funding: { rate: parseAmount('0.0000125'), intervalSeconds: 3600 },
    status: 'trading',
    // TEST: roomy enough for every journey's TEST orders on the shared BTC markets (J-cex-spot-01 #8 sells 100 BTC);
    // J-cex-spot-16 proves the venue's own caps on TEST markets of its own (/test/market-add, /test/market-limits).
    maxOrderQty: parseAmount('1000'),
    maxOrderNotional: parseAmount('100000000'),
    listedBy: VENUE_LISTED,
  },
  ladder: { mid: parseAmount('60000'), step: parseAmount('10') },
};

export default instrument;
