import { parseAmount } from '@intafaced/ledger-client/money';
import { VENUE_LISTED, type TestInstrument } from './shared.js';

const instrument: TestInstrument = {
  market: {
    // J-derivatives-02: a TEST perpetual of its own whose venue publishes its margin tiers, what it takes as margin with
    // its haircut, and a cap on its open interest, so a trade can be sized against the venue's own risk figures. Only
    // J-derivatives-02 trades it, so lowering its cap for one step reaches no other journey. It rests no ladder: every
    // step is a read or a refusal. Priced by its TEST oracle; it tracks nothing outside the simulator.
    symbol: 'XRSK-PERP',
    kind: 'perpetual',
    baseAsset: 'XRSK',
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
    markPrice: parseAmount('100'),
    contractSize: parseAmount('1'),
    status: 'trading',
    maxOrderQty: parseAmount('1000'),
    maxOrderNotional: parseAmount('1000000'),
    // TEST: a 5% usual price band around the mark/book mid (J-derivatives-02 #5 #8); /test/price-band widens it.
    priceBandBps: parseAmount('500'),
    listedBy: VENUE_LISTED,
    oracle: {},
    // TEST tiers: up to 20x below 5,000 USDC of position, 10x to 25,000, 5x above; maintenance half the initial margin
    // at each tier's most leverage.
    marginTiers: [
      { fromNotional: parseAmount('0'), maxLeverageBps: 200_000, maintenanceRate: parseAmount('0.025') },
      { fromNotional: parseAmount('5000'), maxLeverageBps: 100_000, maintenanceRate: parseAmount('0.05') },
      { fromNotional: parseAmount('25000'), maxLeverageBps: 50_000, maintenanceRate: parseAmount('0.1') },
    ],
    // TEST: the venue takes USDC alone as margin here, at no haircut.
    collateral: [{ asset: 'USDC', haircut: { known: true, value: parseAmount('0') } }],
    // TEST: room for every TEST order on it; J-derivatives-02 #7 lowers it for one step.
    openInterestCap: parseAmount('1000'),
  },
};

export default instrument;
