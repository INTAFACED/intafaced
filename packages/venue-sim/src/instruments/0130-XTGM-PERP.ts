import { parseAmount } from '@intafaced/ledger-client/money';
import { VENUE_LISTED, type TestInstrument } from './shared.js';

const instrument: TestInstrument = {
  market: {
    // J-charts-desk-21: a TEST perpetual of its own on isolated margin, so its position has a liquidation price, whose mark
    // the journey moves until the account's margin use passes 80% and then 90% for the read-only Telegram alerts, so moving
    // it reaches no other journey. Only J-charts-desk-21 trades it. Priced by its TEST oracle, so a fill never moves its mark; it tracks nothing outside the
    // simulator.
    symbol: 'XTGM-PERP',
    kind: 'perpetual',
    baseAsset: 'XTGM',
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
    maintenanceMarginRate: parseAmount('0.025'),
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
