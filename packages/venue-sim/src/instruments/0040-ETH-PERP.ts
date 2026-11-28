import { parseAmount } from '@intafaced/ledger-client/money';
import { VENUE_LISTED, type TestInstrument } from './shared.js';

const instrument: TestInstrument = {
  market: {
    // TEST: a perpetual of its own for the venue's trigger orders (J-derivatives-03): a take profit, a stop loss, a stop
    // market and a stop limit rest here, judged on the mark or the last trade, and only J-derivatives-03 trades it, so
    // moving its mark (/test/set-mark) or pulling a side of its ladder (/test/pull-ladder) reaches no other journey.
    symbol: 'ETH-PERP',
    kind: 'perpetual',
    baseAsset: 'ETH',
    quoteAsset: 'USDC',
    orderTypes: ['limit', 'market'],
    timeInForce: ['GTC', 'IOC'],
    marginModes: ['isolated'],
    maxLeverageBps: 200_000,
    tickSize: parseAmount('0.1'),
    lotSize: parseAmount('0.001'),
    makerFeeBps: { known: true, value: parseAmount('1.5') },
    takerFeeBps: { known: true, value: parseAmount('4.5') },
    builderFeeCapBps: { known: true, value: parseAmount('10') },
    maintenanceMarginRate: parseAmount('0.005'),
    markPrice: parseAmount('3000'),
    contractSize: parseAmount('1'),
    status: 'trading',
    maxOrderQty: parseAmount('1000'),
    maxOrderNotional: parseAmount('100000000'),
    listedBy: VENUE_LISTED,
    triggerSources: ['mark', 'last'],
    // TEST: priced by its TEST oracle, so a fill never moves its mark: a journey step moves it only by /test/set-mark.
    oracle: {},
  },
  ladder: { mid: parseAmount('3000'), step: parseAmount('1') },
};

export default instrument;
