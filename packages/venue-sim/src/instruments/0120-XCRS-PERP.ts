import { parseAmount } from '@intafaced/ledger-client/money';
import { VENUE_LISTED, type TestInstrument } from './shared.js';

const instrument: TestInstrument = {
  market: {
    // J-derivatives-26: a TEST perpetual of its own on cross margin, which the TEST venue liquidates at the account's cross
    // liquidation level (simulator CROSS_RULE), so moving its mark reaches no other journey. Only J-derivatives-26 trades
    // it. Priced by its TEST oracle, so a fill never moves its mark; it tracks nothing outside the simulator.
    symbol: 'XCRS-PERP',
    kind: 'perpetual',
    baseAsset: 'XCRS',
    quoteAsset: 'USDC',
    orderTypes: ['limit', 'market'],
    timeInForce: ['GTC', 'IOC'],
    marginModes: ['cross'],
    maxLeverageBps: 200_000,
    tickSize: parseAmount('0.01'),
    lotSize: parseAmount('0.1'),
    makerFeeBps: { known: true, value: parseAmount('1.5') },
    takerFeeBps: { known: true, value: parseAmount('4.5') },
    builderFeeCapBps: { known: true, value: parseAmount('10') },
    // TEST: maintenance half the initial margin at the most leverage (20x).
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
        'TEST rule: on cross margin the venue judges the whole account, not one position: once the account’s equity falls to ' +
        'half its maintenance requirement, it closes every cross position at its mark.',
      feeRule:
        "TEST rule: a liquidation fee of 1% of each position's value at the mark, capped at what the account has left, paid " +
        "into the venue's TEST insurance fund.",
    },
  },
  ladder: { mid: parseAmount('100'), step: parseAmount('0.1') },
};

export default instrument;
