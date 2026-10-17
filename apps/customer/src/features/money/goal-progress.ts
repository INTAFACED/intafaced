import { parseAmount } from '../../shared/money';

export type Share = { basisPoints: number; reached: boolean };

/**
 * How much of a saving target a space holds, from the two exact decimals the bank returned. Whole basis points
 * (1/100 of a percent), rounded down, so a bar never claims more than the balance. No target, a target of zero or an
 * unreadable figure gives nothing to draw: the bar is skipped, never guessed.
 */
export function goalShare(balance: string, target: string | null): Share | null {
  if (target === null) return null;
  try {
    const have = parseAmount(balance);
    const goal = parseAmount(target);
    if (goal <= 0n || have < 0n) return null;
    if (have >= goal) return { basisPoints: 10_000, reached: true };
    return { basisPoints: Number((have * 10_000n) / goal), reached: false };
  } catch {
    return null;
  }
}

/**
 * Two totals as bar lengths against the larger one, in whole basis points, rounded down. Both zero gives nothing to
 * draw. Only the two returned totals are used: the bank does not return a point per day, so none is made up.
 */
export function movementShares(inflow: string, outflow: string): { inflow: number; outflow: number } | null {
  try {
    const into = parseAmount(inflow);
    const out = parseAmount(outflow);
    if (into < 0n || out < 0n) return null;
    const widest = into > out ? into : out;
    if (widest === 0n) return null;
    return { inflow: Number((into * 10_000n) / widest), outflow: Number((out * 10_000n) / widest) };
  } catch {
    return null;
  }
}
