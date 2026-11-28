import { parseAmount } from '@intafaced/ledger-client/money';
import { TEST_SPOT_RULES, type TestInstrument } from './shared.js';

const instrument: TestInstrument = {
  market: {
    symbol: 'ETH-USDC',
    kind: 'spot',
    baseAsset: 'ETH',
    quoteAsset: 'USDC',
    orderTypes: ['limit', 'market'],
    timeInForce: ['GTC', 'IOC', 'ALO'],
    marginModes: [],
    maxLeverageBps: null,
    tickSize: parseAmount('0.1'),
    lotSize: parseAmount('0.001'),
    makerFeeBps: { known: true, value: parseAmount('1') },
    takerFeeBps: { known: true, value: parseAmount('3.5') },
    status: 'trading',
    maxOrderQty: parseAmount('500'),
    maxOrderNotional: parseAmount('2000000'),
    // TEST: the same spot builder-fee cap as BTC-USDC.
    builderFeeCapBps: { known: true, value: parseAmount('100') },
    ...TEST_SPOT_RULES,
  },
};

export default instrument;
