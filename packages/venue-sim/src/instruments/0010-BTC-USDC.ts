import { parseAmount } from '@intafaced/ledger-client/money';
import { TEST_SPOT_RULES, type TestInstrument } from './shared.js';

const instrument: TestInstrument = {
  market: {
    symbol: 'BTC-USDC',
    kind: 'spot',
    baseAsset: 'BTC',
    quoteAsset: 'USDC',
    orderTypes: ['limit', 'market'],
    timeInForce: ['GTC', 'IOC', 'ALO'],
    marginModes: [],
    maxLeverageBps: null,
    tickSize: parseAmount('1'),
    lotSize: parseAmount('0.0001'),
    makerFeeBps: { known: true, value: parseAmount('1') },
    takerFeeBps: { known: true, value: parseAmount('3.5') },
    status: 'trading',
    // TEST: roomy enough for every journey's TEST orders on the shared BTC markets (J-cex-spot-01 #8 sells 100 BTC);
    // J-cex-spot-16 proves the venue's own caps on TEST markets of its own (/test/market-add, /test/market-limits).
    maxOrderQty: parseAmount('1000'),
    maxOrderNotional: parseAmount('100000000'),
    // TEST: the venue's own cap on a builder fee, 1% on spot (the figure Hyperliquid publishes for its builder codes).
    builderFeeCapBps: { known: true, value: parseAmount('100') },
    ...TEST_SPOT_RULES,
  },
  ladder: { mid: parseAmount('60000'), step: parseAmount('10') },
};

export default instrument;
