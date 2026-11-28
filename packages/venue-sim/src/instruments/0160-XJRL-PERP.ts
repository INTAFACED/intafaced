import { parseAmount, ZERO } from '@intafaced/ledger-client/money';
import { VENUE_LISTED, type TestInstrument } from './shared.js';

const instrument: TestInstrument = {
  market: {
    // J-portfolio-18: a TEST perpetual of its own whose trades fill the person's journal, so moving its ladder, closing
    // its funding period and taking its history away (/test/history-kept) reach no other journey. Only J-portfolio-18
    // trades it. Priced by its TEST oracle, so a fill never moves its mark.
    symbol: 'XJRL-PERP',
    kind: 'perpetual',
    baseAsset: 'XJRL',
    quoteAsset: 'USDC',
    orderTypes: ['limit', 'market'],
    // TEST: stop orders judged on the mark, so the journal's trades open with a stop (J-portfolio-18 #4).
    triggerSources: ['mark'],
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
  },
  ladder: { mid: parseAmount('100'), step: parseAmount('0.1') },
};

export default instrument;
