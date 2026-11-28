import { parseAmount } from '@intafaced/ledger-client/money';
import { VENUE_LISTED, type TestInstrument } from './shared.js';

const instrument: TestInstrument = {
  market: {
    // J-charts-desk-20: a TEST perpetual of its own for replaying a journal trade. Only J-charts-desk-20 trades it, and
    // it has no TEST makers' ladder, so every fill and every print on it (its bars) is one that journey made at a price it
    // chose. Priced by its TEST oracle, so a fill never moves its mark and a stop resting on the mark never fires by itself.
    symbol: 'XRPY-PERP',
    kind: 'perpetual',
    baseAsset: 'XRPY',
    quoteAsset: 'USDC',
    orderTypes: ['limit', 'market'],
    timeInForce: ['GTC', 'IOC'],
    marginModes: ['isolated'],
    maxLeverageBps: 100_000,
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
    // A stop on the mark rests here (the journey's own stops), and never fires: the mark stays at its TEST oracle's 100.
    triggerSources: ['mark'],
    oracle: {},
  },
};

export default instrument;
