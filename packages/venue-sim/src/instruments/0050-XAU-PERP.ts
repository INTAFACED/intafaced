import { parseAmount } from '@intafaced/ledger-client/money';
import { type TestInstrument } from './shared.js';

const instrument: TestInstrument = {
  market: {
    symbol: 'XAU-PERP',
    kind: 'perpetual',
    baseAsset: 'XAU',
    quoteAsset: 'USDC',
    orderTypes: ['limit', 'market'],
    timeInForce: ['GTC', 'IOC'],
    marginModes: ['isolated'],
    maxLeverageBps: 100_000,
    tickSize: parseAmount('0.1'),
    lotSize: parseAmount('0.01'),
    makerFeeBps: { known: true, value: parseAmount('1') },
    takerFeeBps: { known: true, value: parseAmount('3') },
    // TEST: the same perpetual builder-fee cap as BTC-PERP.
    builderFeeCapBps: { known: true, value: parseAmount('10') },
    maintenanceMarginRate: parseAmount('0.01'),
    markPrice: parseAmount('2650'),
    // TEST: one contract is one unit of the base; no funding rate is published for it.
    contractSize: parseAmount('1'),
    status: 'trading',
    maxOrderQty: parseAmount('1000'),
    maxOrderNotional: parseAmount('10000000'),
    listedBy: { kind: 'hip3', name: 'TEST gold deployer' },
    oracleRule: "TEST oracle: one XAU/USD price, set by the simulator's TEST control; it reads no outside gold price.",
    markRule: 'The mark price is the oracle price; fills do not move it.',
    tradingHours: '24/7, no close',
    oracle: {
      staleRule: 'While the oracle is stale the mark holds at the last oracle price and only reduce-only orders are taken.',
    },
  },
  ladder: { mid: parseAmount('2650'), step: parseAmount('0.5') },
};

export default instrument;
