/**
 * Integer arithmetic for a price-trigger fill.
 * Amounts stay scaled bigint. A percentage on the wire is a decimal string, never a float.
 */

/** Ceiling of `minOut * fillIn / amountIn`. A full fill returns `minOut` exactly. */
export function minOutForFill(fillIn: bigint, amountIn: bigint, minOut: bigint): bigint {
  if (fillIn <= 0n || amountIn <= 0n || minOut <= 0n) return 0n;
  return (minOut * fillIn + amountIn - 1n) / amountIn;
}

/**
 * `part / whole` as a percentage with up to four decimal places.
 * Truncates toward zero (the displayed distance never rounds up into a larger claim).
 */
export function percentString(part: bigint, whole: bigint): string {
  if (whole <= 0n || part < 0n) {
    throw new Error('percentage needs a positive denominator');
  }
  const scaled = (part * 1_000_000n) / whole;
  const wholePart = scaled / 10_000n;
  const frac = (scaled % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return frac.length === 0 ? `${wholePart}` : `${wholePart}.${frac}`;
}

export type TriggerVariant = 'buy_above' | 'buy_below' | 'sell_above' | 'sell_below';

export const TRIGGER_VARIANTS: readonly TriggerVariant[] = ['buy_above', 'buy_below', 'sell_above', 'sell_below'];

/** True when the market price has reached the trigger. Equality fills; the other side does not. */
export function triggerReached(variant: TriggerVariant, price: bigint, trigger: bigint): boolean {
  switch (variant) {
    case 'buy_above':
    case 'sell_above':
      return price >= trigger;
    case 'buy_below':
    case 'sell_below':
      return price <= trigger;
    default: {
      const never: never = variant;
      return never;
    }
  }
}
