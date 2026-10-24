import type { BankValueBridge, BankValueOverTime, BankValuePoint } from '@intafaced/contracts/bank-value-history';
import { dec, str } from '../../data/decimal';
import type { LinePoint } from './pnl-time-model';

/**
 * What the customer's money was worth over a range, and the change-in-value bridge between its ends (J-portfolio-05 #6
 * and #7), from `bank.portfolio.valueOverTime`. Money stays a decimal string or a scaled bigint.
 */

export { bankValueOverTimeSchema } from '@intafaced/contracts/bank-value-history';
export type { BankValueBridge, BankValueOverTime, BankValuePoint };

export function valueLine(points: readonly BankValuePoint[]): LinePoint[] {
  return points.map((point) => ({ at: point.at, usd: point.valueUsd }));
}

/** Every coin a missing point names, once, and how many points are missing. */
export function valueMissingOf(points: readonly BankValuePoint[]): { count: number; coins: string[] } {
  const coins = new Set<string>();
  let count = 0;
  for (const point of points) {
    if (point.valueUsd !== null) continue;
    count += 1;
    for (const item of point.missing) coins.add(item.assetId);
  }
  return { count, coins: [...coins].sort() };
}

export type BridgeLeg = 'opening' | 'deposits' | 'withdrawals' | 'fees' | 'otherFlows' | 'marketMove' | 'closing';

/** The bridge's lines in reading order, each with the sign it adds to the opening (the closing is the sum). */
export const BRIDGE_LEGS: ReadonlyArray<{ leg: BridgeLeg; sign: 1 | -1 | 0 }> = [
  { leg: 'opening', sign: 1 },
  { leg: 'deposits', sign: 1 },
  { leg: 'withdrawals', sign: -1 },
  { leg: 'fees', sign: -1 },
  { leg: 'otherFlows', sign: 1 },
  { leg: 'marketMove', sign: 1 },
  { leg: 'closing', sign: 0 },
];

export function bridgeValue(bridge: BankValueBridge, leg: BridgeLeg): string | null {
  return bridge[`${leg}Usd` as const];
}

/** A line as it adds to the opening: a withdrawal or fee of 100 reads −100. Null when it is not known. */
export function signedLine(value: string | null, sign: 1 | -1 | 0): string | null {
  const parsed = dec(value);
  if (parsed === null) return null;
  return str(sign === -1 ? -parsed : parsed);
}
