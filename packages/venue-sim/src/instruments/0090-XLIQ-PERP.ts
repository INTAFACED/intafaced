import { parseAmount } from '@intafaced/ledger-client/money';
import { VENUE_LISTED, type TestInstrument } from './shared.js';

const instrument: TestInstrument = {
  market: {
    // J-derivatives-07: a TEST perpetual of its own that the TEST venue liquidates on, so moving its mark to a position's
    // liquidation price (/test/set-mark) reaches no other journey. Only J-derivatives-07 trades it. Priced by its TEST
    // oracle, so a fill never moves its mark; it tracks nothing outside the simulator.
    symbol: 'XLIQ-PERP',
    kind: 'perpetual',
    baseAsset: 'XLIQ',
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
    oracle: {},
    liquidation: {
      feeRate: parseAmount('0.01'),
      priceRule:
        "TEST rule: when the mark price reaches a position's liquidation price, the venue closes half the position at the " +
        'mark, and the rest at the next mark it sets; it takes no order, leverage or margin change on the position in between.',
      feeRule:
        "TEST rule: a liquidation fee of 1% of each part's value at the mark, capped at the margin that part leaves, paid " +
        "into the venue's TEST insurance fund.",
    },
  },
  ladder: { mid: parseAmount('100'), step: parseAmount('0.1') },
};

export default instrument;
