import { parseAmount, ZERO } from '@intafaced/ledger-client/money';
import { VENUE_LISTED, type TestInstrument } from './shared.js';

const instrument: TestInstrument = {
  market: {
    // J-derivatives-14: a TEST perpetual of its own that a developer reads and trades through our API: its open interest
    // and long/short count come from positions only this journey opens, its funding periods only it closes, and it
    // publishes no margin tiers (the risk-limit ladder reads unset). Only J-derivatives-14 trades it, and it has no TEST
    // makers' ladder, so every position on it is one the journey opened. Priced by its TEST oracle, so a fill never moves
    // its mark.
    symbol: 'XDEV-PERP',
    kind: 'perpetual',
    baseAsset: 'XDEV',
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
    // TEST: open interest reported, with no deployer cap.
    openInterestCap: null,
    // TEST: hourly funding as on XFND-PERP.
    funding: {
      rate: ZERO,
      intervalSeconds: 3600,
      settles: {
        interestRate: parseAmount('0.0000125'),
        rateCap: parseAmount('0.04'),
        rule:
          'TEST rule: each hour the rate is the premium, (mark − index) ÷ index, plus the interest component, held within the ' +
          'cap either way; longs pay shorts on a positive rate and shorts pay longs on a negative one, on size × mark × rate.',
      },
    },
    status: 'trading',
    maxOrderQty: parseAmount('1000'),
    maxOrderNotional: parseAmount('1000000'),
    // TEST: a limit price more than 5% from the middle of its book is refused (the order price limit a developer reads).
    priceBandBps: parseAmount('500'),
    listedBy: VENUE_LISTED,
    oracle: {},
    // TEST: liquidated as XBIL-PERP is, so the venue publishes its liquidation and auto-deleveraging alerts here.
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
};

export default instrument;
