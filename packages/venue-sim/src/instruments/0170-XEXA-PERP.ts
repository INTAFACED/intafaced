import { parseAmount } from '@intafaced/ledger-client/money';
import { VENUE_LISTED, type TestInstrument } from './shared.js';

const instrument: TestInstrument = {
  market: {
    // J-derivatives-32: a TEST perpetual of its own whose long's stop and target are dragged on the chart and moved to
    // breakeven, so moving its mark reaches no other journey. Only J-derivatives-32 trades it. Priced by its TEST oracle,
    // so a fill never moves its mark; its trigger orders are judged on the mark, as Hyperliquid judges them.
    symbol: 'XEXA-PERP',
    kind: 'perpetual',
    baseAsset: 'XEXA',
    quoteAsset: 'USDC',
    orderTypes: ['limit', 'market'],
    timeInForce: ['GTC', 'IOC'],
    marginModes: ['isolated'],
    maxLeverageBps: 200_000,
    tickSize: parseAmount('0.01'),
    lotSize: parseAmount('0.1'),
    makerFeeBps: { known: true, value: parseAmount('1.5') },
    takerFeeBps: { known: true, value: parseAmount('4.5') },
    builderFeeCapBps: { known: true, value: parseAmount('10') },
    maintenanceMarginRate: parseAmount('0.02'),
    markPrice: parseAmount('100'),
    contractSize: parseAmount('1'),
    status: 'trading',
    maxOrderQty: parseAmount('1000'),
    maxOrderNotional: parseAmount('1000000'),
    listedBy: VENUE_LISTED,
    triggerSources: ['mark'],
    oracle: {},
  },
  ladder: { mid: parseAmount('100'), step: parseAmount('0.1') },
};

export default instrument;
