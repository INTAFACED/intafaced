import { parseAmount, ZERO } from '@intafaced/ledger-client/money';
import { VENUE_LISTED, type TestInstrument } from './shared.js';

const instrument: TestInstrument = {
  market: {
    // J-derivatives-12: a TEST perpetual of its own on which the TEST venue settles funding and liquidates, so one account
    // gets a funding payment, a close and a liquidation on its bills, and moving its mark or closing its period reaches no
    // other journey. Only J-derivatives-12 trades it. Priced by its TEST oracle, so a fill never moves its mark.
    symbol: 'XBIL-PERP',
    kind: 'perpetual',
    baseAsset: 'XBIL',
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
    // TEST: the venue takes USDC alone as margin here, at no haircut.
    collateral: [{ asset: 'USDC', haircut: { known: true, value: parseAmount('0') } }],
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
