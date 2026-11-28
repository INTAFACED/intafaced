import { parseAmount, ZERO } from '@intafaced/ledger-client/money';
import { VENUE_LISTED, type TestInstrument } from './shared.js';

const instrument: TestInstrument = {
  market: {
    // J-derivatives-08: a TEST perpetual of its own whose TEST venue builds its funding rate from its mark and index and
    // settles it, so closing a period (/test/settle-funding) and moving its index reach no other journey. Only
    // J-derivatives-08 trades it. Priced by its TEST oracle, so a fill never moves its mark.
    symbol: 'XFND-PERP',
    kind: 'perpetual',
    baseAsset: 'XFND',
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
    // TEST: hourly funding, an interest component of 0.00125% an hour, held within 4% an hour either way.
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
