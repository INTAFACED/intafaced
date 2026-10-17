/**
 * The Options room's arithmetic, with no React in it. Every amount is a decimal string combined as a scaled bigint
 * (`data/decimal.ts`), so a payoff, a break-even or a cost is exact and never passes through a float.
 * Unknown or unusable input is `null`, never zero.
 */
import { add, dec, ratio, str, sub, times, ZERO, type Scaled } from '../../../data/decimal';
import { onStep, positive } from '../rooms/math';

export type Side = 'buy' | 'sell';
export type Right = 'call' | 'put';
export const UNLIMITED = 'unlimited' as const;

/** One leg as the person typed it. The price is theirs ("your price"), never a quote. */
export interface Leg {
  side: Side;
  right: Right;
  strike: string;
  qty: string;
  premium: string;
}

export type LegField = 'strike' | 'qty' | 'premium';
export type LegIssues = Partial<Record<LegField, 'missing' | 'invalid'>>;

const blank = (value: string) => value.trim() === '';

/** Strike and quantity must be above zero; a price of zero is allowed (a free leg), a missing one is not. */
export function legIssues(leg: Leg): LegIssues {
  const issues: LegIssues = {};
  if (blank(leg.strike)) issues.strike = 'missing';
  else if (positive(leg.strike) === null) issues.strike = 'invalid';
  if (blank(leg.qty)) issues.qty = 'missing';
  else if (positive(leg.qty) === null) issues.qty = 'invalid';
  if (blank(leg.premium)) issues.premium = 'missing';
  else {
    const premium = dec(leg.premium.trim());
    if (premium === null || premium < ZERO) issues.premium = 'invalid';
  }
  return issues;
}

export function legsReady(legs: readonly Leg[]): boolean {
  return legs.length > 0 && legs.every((leg) => Object.keys(legIssues(leg)).length === 0);
}

const sign = (side: Side): bigint => (side === 'buy' ? 1n : -1n);
const scaled = (value: string): Scaled => dec(value.trim()) ?? ZERO;

/** Profit or loss of one leg at one spot, in the price's currency: the intrinsic value less the price, signed by side. */
function legPnl(leg: Leg, spot: Scaled, multiplier: Scaled): Scaled {
  const strike = scaled(leg.strike);
  const raw = leg.right === 'call' ? spot - strike : strike - spot;
  const intrinsic = raw > ZERO ? raw : ZERO;
  const perUnit = sub(intrinsic, scaled(leg.premium));
  return sign(leg.side) * times(times(perUnit, scaled(leg.qty)), multiplier);
}

function totalPnl(legs: readonly Leg[], spot: Scaled, multiplier: Scaled): Scaled {
  return legs.reduce((sum, leg) => add(sum, legPnl(leg, spot, multiplier)), ZERO);
}

/** Profit or loss at expiry for a spot price. Null when a leg or the spot is not usable. */
export function pnlAt(legs: readonly Leg[], spot: string, multiplier = '1'): string | null {
  const s = dec(spot.trim());
  const m = positive(multiplier);
  if (s === null || s < ZERO || m === null || !legsReady(legs)) return null;
  return str(totalPnl(legs, s, m));
}

export interface PayoffRow {
  spot: string;
  pnl: string;
}

export interface NetPremium {
  kind: 'debit' | 'credit' | 'flat';
  amount: string;
}

export interface Analysis {
  netPremium: NetPremium;
  /** Best result at expiry, or `unlimited` when a long call has no cap. */
  maxProfit: string | typeof UNLIMITED;
  /** Worst result at expiry (a negative number), or `unlimited` for a naked short call. */
  maxLoss: string | typeof UNLIMITED;
  breakEvens: string[];
  rows: PayoffRow[];
}

/**
 * The result at expiry is a straight line between strikes, so the extremes sit at spot 0 or on a strike, and beyond the
 * highest strike the line has one fixed slope (the signed number of calls). That is why max profit, max loss and the
 * break-evens can be exact instead of read off a grid.
 */
export function analyse(legs: readonly Leg[], multiplier = '1'): Analysis | null {
  const m = positive(multiplier);
  if (m === null || !legsReady(legs)) return null;

  const strikes = [...new Set(legs.map((leg) => scaled(leg.strike)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const knots: Scaled[] = [ZERO, ...strikes];
  const values = knots.map((x) => totalPnl(legs, x, m));
  const slope = legs.reduce((sum, leg) => (leg.right === 'call' ? add(sum, sign(leg.side) * times(scaled(leg.qty), m)) : sum), ZERO);

  const best = values.reduce((a, b) => (b > a ? b : a));
  const worst = values.reduce((a, b) => (b < a ? b : a));

  const breakEvens: Scaled[] = [];
  const note = (x: Scaled | null) => {
    if (x !== null && !breakEvens.includes(x)) breakEvens.push(x);
  };
  knots.forEach((x, i) => {
    const y = values[i]!;
    if (y === ZERO) note(x);
    const nextX = knots[i + 1];
    const nextY = values[i + 1];
    if (nextX === undefined || nextY === undefined || y === ZERO || nextY === ZERO) return;
    if (y < ZERO === nextY < ZERO) return;
    const walk = ratio(times(sub(ZERO, y), sub(nextX, x)), sub(nextY, y));
    note(walk === null ? null : add(x, walk));
  });
  const lastY = values[values.length - 1]!;
  const lastX = knots[knots.length - 1]!;
  if (slope !== ZERO && lastY !== ZERO && lastY < ZERO !== slope < ZERO) {
    const walk = ratio(sub(ZERO, lastY), slope);
    note(walk === null ? null : add(lastX, walk));
  }

  const low = strikes[0]!;
  const high = strikes[strikes.length - 1]!;
  const pad = high > low ? sub(high, low) : low / 2n;
  const from = low > pad ? sub(low, pad) : ZERO;
  const grid = [...new Set([from, ...strikes, add(high, pad)])];

  const net = legs.reduce((sum, leg) => add(sum, sign(leg.side) * times(times(scaled(leg.premium), scaled(leg.qty)), m)), ZERO);

  return {
    netPremium: { kind: net > ZERO ? 'debit' : net < ZERO ? 'credit' : 'flat', amount: str(net < ZERO ? sub(ZERO, net) : net) },
    maxProfit: slope > ZERO ? UNLIMITED : str(best),
    maxLoss: slope < ZERO ? UNLIMITED : str(worst),
    breakEvens: breakEvens.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(str),
    rows: grid.map((x) => ({ spot: str(x), pnl: str(totalPnl(legs, x, m)) })),
  };
}

/**
 * The line of the payoff chart in whole-number chart units (an SVG viewBox), made with bigint division so no money value
 * passes through a float. The y axis is flipped (up is profit). `zeroY` is where a result of 0 sits, or null if it is off the chart.
 */
export function chartGeometry(rows: readonly PayoffRow[], width = 1000, height = 300): { line: string; zeroY: string | null } | null {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last || rows.length < 2) return null;
  const xs = rows.map((r) => scaled(r.spot));
  const ys = rows.map((r) => scaled(r.pnl));
  const x0 = xs[0]!;
  const span = xs[xs.length - 1]! - x0;
  if (span <= ZERO) return null;
  const top = ys.reduce((a, b) => (b > a ? b : a));
  const bottom = ys.reduce((a, b) => (b < a ? b : a));
  const range = top - bottom;
  const w = BigInt(width);
  const h = BigInt(height);
  const yOf = (value: Scaled) => (range === ZERO ? h / 2n : h - ((value - bottom) * h) / range);
  const line = xs.map((x, i) => `${((x - x0) * w) / span},${yOf(ys[i]!)}`).join(' ');
  const zeroOnChart = ZERO >= bottom && ZERO <= top;
  return { line, zeroY: zeroOnChart ? String(yOf(ZERO)) : null };
}

export type PresetId = 'longCall' | 'longPut' | 'straddle' | 'strangle' | 'bullCallSpread' | 'bearPutSpread' | 'ironCondor';
export const PRESET_IDS: readonly PresetId[] = [
  'longCall',
  'longPut',
  'straddle',
  'strangle',
  'bullCallSpread',
  'bearPutSpread',
  'ironCondor',
];

/**
 * A preset only fills in the shape (sides, rights, strikes, quantity 1). Prices stay empty: they are the person's own.
 * Null when a strike would fall to zero or below, or the centre or step is not a positive number.
 */
export function buildPreset(id: PresetId, centre: string, step: string): Leg[] | null {
  const c = positive(centre);
  const s = positive(step);
  if (c === null || s === null) return null;
  const at = (k: number): string | null => {
    const strike = add(c, BigInt(k) * s);
    return strike > ZERO ? str(strike) : null;
  };
  const make = (side: Side, right: Right, k: number): Leg | null => {
    const strike = at(k);
    return strike === null ? null : { side, right, strike, qty: '1', premium: '' };
  };
  const shapes: Record<PresetId, Array<[Side, Right, number]>> = {
    longCall: [['buy', 'call', 0]],
    longPut: [['buy', 'put', 0]],
    straddle: [
      ['buy', 'call', 0],
      ['buy', 'put', 0],
    ],
    strangle: [
      ['buy', 'put', -1],
      ['buy', 'call', 1],
    ],
    bullCallSpread: [
      ['buy', 'call', 0],
      ['sell', 'call', 1],
    ],
    bearPutSpread: [
      ['buy', 'put', 0],
      ['sell', 'put', -1],
    ],
    ironCondor: [
      ['buy', 'put', -2],
      ['sell', 'put', -1],
      ['sell', 'call', 1],
      ['buy', 'call', 2],
    ],
  };
  const legs = shapes[id].map(([side, right, k]) => make(side, right, k));
  return legs.every((leg): leg is Leg => leg !== null) ? legs : null;
}

export interface TicketInput {
  side: Side;
  right: Right;
  strike: string;
  price: string;
  size: string;
  contractSize: string;
  base: string;
  quote: string;
  settle: string | null;
  /** The fee the service estimated, only when it is in the premium's asset; otherwise null. */
  fee: string | null;
}

export interface Amount {
  amount: string;
  asset: string;
}

export interface TicketCost {
  premium: Amount;
  /** You pay a premium to buy and receive it to sell. Under full collateral a sell also holds collateral. */
  direction: 'pay' | 'receive';
  /** Estimate under full collateral: a sold call holds the underlying, a sold put holds strike x size. */
  collateral: Amount | null;
  fee: string | null;
  total: Amount;
}

/** premium = price x size x contract size. Total to commit: the premium for a buy; the collateral for a sell (the premium comes in on a fill). */
export function ticketCost(input: TicketInput): TicketCost | null {
  const price = positive(input.price);
  const size = positive(input.size);
  const contractSize = positive(input.contractSize);
  const strike = positive(input.strike);
  if (price === null || size === null || contractSize === null || strike === null) return null;
  const units = times(size, contractSize);
  const premium: Amount = { amount: str(times(price, units)), asset: input.quote };
  const fee = input.fee !== null && dec(input.fee) !== null ? input.fee : null;
  if (input.side === 'buy') {
    const total = fee === null ? premium.amount : str(add(scaled(premium.amount), scaled(fee)));
    return { premium, direction: 'pay', collateral: null, fee, total: { amount: total, asset: input.quote } };
  }
  const collateral: Amount =
    input.right === 'call'
      ? { amount: str(units), asset: input.base }
      : { amount: str(times(strike, units)), asset: input.settle ?? input.quote };
  return { premium, direction: 'receive', collateral, fee, total: collateral };
}

export type TicketBlock =
  | 'signedOut'
  | 'pending'
  | 'noContract'
  | 'policyOff'
  | 'liveBlocked'
  | 'marketClosed'
  | 'termsIncomplete'
  | 'size'
  | 'price'
  | 'sizeStep'
  | 'priceStep';

export interface BlockInput {
  signedIn: boolean;
  pending: boolean;
  contract: { paper: boolean; open: boolean; complete: boolean; tick: string; lot: string } | null;
  allowed: { options: boolean; paper: boolean; live: boolean } | null;
  size: string;
  price: string;
}

/** The first reason the ticket cannot send, in the order the person can act on them. Null means it can. */
export function ticketBlock(input: BlockInput): TicketBlock | null {
  if (!input.signedIn) return 'signedOut';
  if (input.pending) return 'pending';
  const { contract, allowed } = input;
  if (!contract) return 'noContract';
  if (!contract.complete) return 'termsIncomplete';
  if (!allowed || !allowed.options) return 'policyOff';
  if (contract.paper ? !allowed.paper : !allowed.live) return contract.paper ? 'policyOff' : 'liveBlocked';
  if (!contract.open) return 'marketClosed';
  if (positive(input.size) === null) return 'size';
  if (positive(input.price) === null) return 'price';
  if (!onStep(input.size, contract.lot)) return 'sizeStep';
  if (!onStep(input.price, contract.tick)) return 'priceStep';
  return null;
}

/** What the settlement policy still lacks, as keys the screen words in plain English. */
export function policyGaps(policy: {
  settlementAssetLawStamped: boolean;
  settlementFixingConfigured: boolean;
}): Array<'settlement' | 'fixing'> {
  return [
    ...(policy.settlementAssetLawStamped ? [] : (['settlement'] as const)),
    ...(policy.settlementFixingConfigured ? [] : (['fixing'] as const)),
  ];
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** Time left to an expiry as "3d 4h", "5h 10m", "12m", or null once it has passed or the date is unreadable. Not a money value. */
export function timeLeft(expiryIso: string | null | undefined, nowMs: number): string | null {
  if (!expiryIso) return null;
  const at = Date.parse(expiryIso);
  if (Number.isNaN(at) || at <= nowMs) return null;
  const left = at - nowMs;
  const days = Math.floor(left / DAY);
  const hours = Math.floor((left % DAY) / HOUR);
  const minutes = Math.floor((left % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}
