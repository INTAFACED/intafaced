import { parseAmount } from '@intafaced/ledger-client/money';
import { type TestInstrument } from './shared.js';

const instrument: TestInstrument = {
  market: {
    // J-derivatives-27: a TEST stock perpetual a TEST HIP-3 deployer lists, priced by the simulator's own TEST feed, with
    // a TEST home market whose hours the simulator's TEST control sets. It tracks no real company's share.
    symbol: 'XSTK-PERP',
    kind: 'perpetual',
    baseAsset: 'XSTK',
    quoteAsset: 'USDC',
    orderTypes: ['limit', 'market'],
    timeInForce: ['GTC', 'IOC'],
    marginModes: ['isolated'],
    maxLeverageBps: 100_000,
    tickSize: parseAmount('0.01'),
    lotSize: parseAmount('0.1'),
    makerFeeBps: { known: true, value: parseAmount('1') },
    takerFeeBps: { known: true, value: parseAmount('3') },
    // TEST: the same perpetual builder-fee cap as BTC-PERP.
    builderFeeCapBps: { known: true, value: parseAmount('10') },
    maintenanceMarginRate: parseAmount('0.02'),
    markPrice: parseAmount('200'),
    // TEST: one contract is one unit of the base; no funding rate is published for it.
    contractSize: parseAmount('1'),
    status: 'trading',
    maxOrderQty: parseAmount('1000'),
    maxOrderNotional: parseAmount('1000000'),
    listedBy: { kind: 'hip3', name: 'TEST stock deployer' },
    oracleRule:
      "TEST price feed: one XSTK/USD price for a TEST stock, set by the simulator's TEST control; it reads no outside share price.",
    markRule: 'The mark price is the feed price; fills do not move it.',
    tradingHours:
      "24/7 on the venue. The TEST home market's hours are set by the simulator's TEST control; while it is closed the venue's off-hours mode applies.",
    oracle: {
      staleRule: 'While the feed is stale the mark holds at the last feed price and only reduce-only orders are taken.',
    },
    session: {
      homeMarket: 'TEST home exchange',
      offHoursMode: 'The mark holds at the last open-hours price; only limit orders inside the band are taken, at reduced leverage.',
      offHoursBand: 'Limit prices within 5% of the mark when the home market closed.',
      offHoursBandBps: 500,
      offHoursMaxLeverageBps: 20_000,
      offHoursRule:
        'Off hours XSTK-PERP takes no market orders, and only limit orders within 5% of the closing mark at up to 2x; market orders wait for the home market to reopen.',
      // TEST: the venue publishes a reopen time one hour after the TEST control closes the home market.
      reopensAfterMs: 3_600_000,
    },
  },
  ladder: { mid: parseAmount('200'), step: parseAmount('0.1') },
};

export default instrument;
