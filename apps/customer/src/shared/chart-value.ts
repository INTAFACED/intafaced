declare const onChart: unique symbol;

export type ChartValue = number & { readonly [onChart]: true };

/** A decimal string as the chart's own float, to place it on an axis. */
export function chartValue(value: string): ChartValue {
  return Number(value) as ChartValue;
}
