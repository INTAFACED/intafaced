import { definePreviewFixture } from './types';

/**
 * SAMPLE data for the futures Preview (perpetual contracts). Invented numbers; never mixed with real data. See ../README.md.
 *
 * Every price, size and rate is a decimal STRING. The candles and book levels are built here with integer (bigint) steps from a
 * fixed seed, so the same sample draws every time and no float ever touches a price. Liquidation price, unrealised profit and
 * margin level are NOT stored: the screen works them out from the fields below with exact decimal maths.
 *
 * Futures are not live. The safety checks that must exist before they open (liquidation, funding, risk limits) are still to be
 * ported (issue 4717), so every figure here illustrates the finished desk and nothing on it can send an order.
 */

export type PerpId = 'BTC-USDT' | 'ETH-USDT' | 'SOL-USDT';

export interface PerpCandle {
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
}

export interface PerpBookLevel {
  readonly price: string;
  /** Size in the base coin. */
  readonly size: string;
}

export interface PerpContract {
  readonly id: PerpId;
  readonly base: 'BTC' | 'ETH' | 'SOL';
  /** Price step ("0.1"), also the number of decimals a price is drawn with. */
  readonly tick: string;
  /** Smallest order size step in the base coin ("0.001"). */
  readonly lot: string;
  readonly mark: string;
  readonly index: string;
  readonly last: string;
  /** Ratios, not percents: "0.0184" is +1.84%. */
  readonly change24h: string;
  readonly high24h: string;
  readonly low24h: string;
  /** US dollars. */
  readonly volume24h: string;
  readonly openInterest: string;
  /** Ratio paid every funding period: "0.0001" is 0.0100%. Positive: longs pay shorts. */
  readonly fundingRate: string;
  /** Time left to the next funding payment, hh:mm:ss. */
  readonly fundingCountdown: string;
  /** Hours between funding payments. */
  readonly fundingHours: number;
  readonly maxLeverage: number;
  /** Ratio of position value the margin must stay above ("0.005" is 0.50%). */
  readonly maintenanceMargin: string;
  /** Ratio charged on an order that takes liquidity ("0.0005" is 0.05%). */
  readonly takerFee: string;
  readonly candles: readonly PerpCandle[];
  readonly asks: readonly PerpBookLevel[];
  readonly bids: readonly PerpBookLevel[];
}

export type MarginMode = 'isolated' | 'cross';
export type PerpSide = 'long' | 'short';

export interface PerpPosition {
  readonly id: string;
  readonly contract: PerpId;
  readonly side: PerpSide;
  readonly mode: MarginMode;
  readonly leverage: number;
  /** Base coin. */
  readonly size: string;
  readonly entry: string;
  /** Margin put on this position, in US dollars. */
  readonly margin: string;
  readonly takeProfit: string | null;
  readonly stopLoss: string | null;
}

export interface PerpOpenOrder {
  readonly id: string;
  readonly contract: PerpId;
  readonly side: PerpSide;
  readonly kind: 'Limit' | 'Stop-limit';
  readonly price: string;
  readonly size: string;
  readonly reduceOnly: boolean;
  /** ISO instant; drawn in the viewer's time zone. */
  readonly placedAt: string;
}

export interface PerpHistoryOrder {
  readonly id: string;
  readonly contract: PerpId;
  readonly side: PerpSide;
  readonly price: string;
  readonly size: string;
  readonly status: 'filled' | 'cancelled';
  readonly closedAt: string;
}

export interface PerpFundingPayment {
  readonly id: string;
  readonly contract: PerpId;
  readonly rate: string;
  /** Signed US dollars: negative is paid by you. */
  readonly amount: string;
  readonly paidAt: string;
}

export interface FuturesRows {
  readonly contracts: readonly PerpContract[];
  /** Futures wallet in US dollars. */
  readonly available: string;
  readonly positions: readonly PerpPosition[];
  readonly openOrders: readonly PerpOpenOrder[];
  readonly orderHistory: readonly PerpHistoryOrder[];
  readonly fundingHistory: readonly PerpFundingPayment[];
}

// ---- deterministic builders (integers only) -------------------------------------------------------------------------------

function seeded(seed: number): () => number {
  let state = BigInt(seed);
  return () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number(state >> 33n);
  };
}

/** Ticks (an integer count of the price step) to a decimal string with `places` decimals. */
function fromTicks(ticks: bigint, places: number): string {
  const digits = ticks.toString().padStart(places + 1, '0');
  return places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

function buildCandles(markTicks: bigint, places: number, seed: number, stepBps: number, count: number): PerpCandle[] {
  const next = seeded(seed);
  const closes: bigint[] = new Array<bigint>(count);
  closes[count - 1] = markTicks;
  for (let i = count - 1; i > 0; i -= 1) {
    const here = closes[i]!;
    const drift = BigInt((next() % (2 * stepBps + 1)) - stepBps);
    // A small pull toward the final price keeps the whole day inside a believable range.
    const pull = ((markTicks - here) * 3n) / 100n;
    closes[i - 1] = here - (here * drift) / 10000n + pull;
  }
  return closes.map((close, i) => {
    const open = i === 0 ? close - (close * 20n) / 10000n : closes[i - 1]!;
    const bodyHigh = open > close ? open : close;
    const bodyLow = open > close ? close : open;
    const wickUp = (close * BigInt(next() % (stepBps + 1))) / 20000n;
    const wickDown = (close * BigInt(next() % (stepBps + 1))) / 20000n;
    return {
      open: fromTicks(open, places),
      high: fromTicks(bodyHigh + wickUp, places),
      low: fromTicks(bodyLow - wickDown, places),
      close: fromTicks(close, places),
    };
  });
}

function buildBook(
  lastTicks: bigint,
  places: number,
  side: 'ask' | 'bid',
  seed: number,
  stepTicks: bigint,
  sizeUnit: bigint,
  sizePlaces: number,
): PerpBookLevel[] {
  const next = seeded(seed);
  return Array.from({ length: 12 }, (_, i) => {
    const offset = stepTicks * BigInt(i + 1);
    const price = side === 'ask' ? lastTicks + offset : lastTicks - offset;
    const size = sizeUnit * BigInt(2 + (next() % 60));
    return { price: fromTicks(price, places), size: fromTicks(size, sizePlaces) };
  });
}

const btc: PerpContract = {
  id: 'BTC-USDT',
  base: 'BTC',
  tick: '0.1',
  lot: '0.001',
  mark: '64250.0',
  index: '64247.3',
  last: '64251.2',
  change24h: '0.0184',
  high24h: '64980.5',
  low24h: '62810.0',
  volume24h: '2154000000',
  openInterest: '1820000000',
  fundingRate: '0.0001',
  fundingCountdown: '03:20:00',
  fundingHours: 8,
  maxLeverage: 20,
  maintenanceMargin: '0.005',
  takerFee: '0.0005',
  candles: buildCandles(642500n, 1, 11, 22, 96),
  asks: buildBook(642512n, 1, 'ask', 101, 2n, 10n, 3),
  bids: buildBook(642512n, 1, 'bid', 102, 2n, 10n, 3),
};

const eth: PerpContract = {
  id: 'ETH-USDT',
  base: 'ETH',
  tick: '0.01',
  lot: '0.01',
  mark: '2318.45',
  index: '2318.02',
  last: '2318.61',
  change24h: '-0.0092',
  high24h: '2371.90',
  low24h: '2289.30',
  volume24h: '1180000000',
  openInterest: '640000000',
  fundingRate: '-0.00004',
  fundingCountdown: '03:20:00',
  fundingHours: 8,
  maxLeverage: 20,
  maintenanceMargin: '0.005',
  takerFee: '0.0005',
  candles: buildCandles(231845n, 2, 21, 26, 96),
  asks: buildBook(231861n, 2, 'ask', 201, 5n, 50n, 2),
  bids: buildBook(231861n, 2, 'bid', 202, 5n, 50n, 2),
};

const sol: PerpContract = {
  id: 'SOL-USDT',
  base: 'SOL',
  tick: '0.01',
  lot: '0.1',
  mark: '148.32',
  index: '148.28',
  last: '148.35',
  change24h: '0.0311',
  high24h: '150.10',
  low24h: '142.05',
  volume24h: '430000000',
  openInterest: '215000000',
  fundingRate: '0.00012',
  fundingCountdown: '03:20:00',
  fundingHours: 8,
  maxLeverage: 10,
  maintenanceMargin: '0.01',
  takerFee: '0.0005',
  candles: buildCandles(14832n, 2, 31, 34, 96),
  asks: buildBook(14835n, 2, 'ask', 301, 1n, 20n, 1),
  bids: buildBook(14835n, 2, 'bid', 302, 1n, 20n, 1),
};

export const futuresFixture = definePreviewFixture<FuturesRows>(
  'futures',
  'Perpetual contracts: sample prices, funding, a sample futures wallet, positions and orders.',
  {
    contracts: [btc, eth, sol],
    available: '11450.00',
    positions: [
      {
        id: 'p1',
        contract: 'BTC-USDT',
        side: 'long',
        mode: 'isolated',
        leverage: 10,
        size: '0.250',
        entry: '63180.0',
        margin: '1579.50',
        takeProfit: '66500.0',
        stopLoss: '61800.0',
      },
      {
        id: 'p2',
        contract: 'ETH-USDT',
        side: 'short',
        mode: 'cross',
        leverage: 5,
        size: '4.00',
        entry: '2361.20',
        margin: '1888.96',
        takeProfit: null,
        stopLoss: '2480.00',
      },
      {
        id: 'p3',
        contract: 'SOL-USDT',
        side: 'long',
        mode: 'isolated',
        leverage: 4,
        size: '40.0',
        entry: '152.60',
        margin: '1526.00',
        takeProfit: null,
        stopLoss: null,
      },
    ],
    openOrders: [
      {
        id: 'o1',
        contract: 'BTC-USDT',
        side: 'long',
        kind: 'Limit',
        price: '62500.0',
        size: '0.100',
        reduceOnly: false,
        placedAt: '2026-10-14T01:42:00Z',
      },
      {
        id: 'o2',
        contract: 'ETH-USDT',
        side: 'long',
        kind: 'Limit',
        price: '2250.00',
        size: '2.00',
        reduceOnly: true,
        placedAt: '2026-10-13T21:05:00Z',
      },
    ],
    orderHistory: [
      { id: 'h1', contract: 'BTC-USDT', side: 'long', price: '63180.0', size: '0.250', status: 'filled', closedAt: '2026-10-13T14:12:00Z' },
      { id: 'h2', contract: 'ETH-USDT', side: 'short', price: '2361.20', size: '4.00', status: 'filled', closedAt: '2026-10-13T09:30:00Z' },
      {
        id: 'h3',
        contract: 'SOL-USDT',
        side: 'short',
        price: '161.00',
        size: '20.0',
        status: 'cancelled',
        closedAt: '2026-10-12T18:47:00Z',
      },
    ],
    fundingHistory: [
      { id: 'f1', contract: 'BTC-USDT', rate: '0.0001', amount: '-1.58', paidAt: '2026-10-14T00:00:00Z' },
      { id: 'f2', contract: 'ETH-USDT', rate: '-0.00004', amount: '0.38', paidAt: '2026-10-14T00:00:00Z' },
      { id: 'f3', contract: 'BTC-USDT', rate: '0.0001', amount: '-1.57', paidAt: '2026-10-13T16:00:00Z' },
    ],
  },
);
