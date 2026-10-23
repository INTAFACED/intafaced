import { add, div, mul, parseAmount, sub, type Amount } from '@intafaced/ledger-client/money';

/**
 * Moving averages over closed bars, in exact scaled decimals. Index i uses closes 0..i only, so a signal on bar i never
 * reads a later bar (ENGINE BT-2). Null until the average has its full length of bars.
 */
export function simpleAverage(closes: readonly Amount[], length: number): (Amount | null)[] {
  const out: (Amount | null)[] = [];
  const size = parseAmount(String(length));
  let running = 0n;
  for (let i = 0; i < closes.length; i += 1) {
    running = add(running, closes[i]!);
    if (i >= length) running = sub(running, closes[i - length]!);
    out.push(i + 1 >= length ? div(running, size, 'half-up') : null);
  }
  return out;
}

/** Exponential average with weight 2 / (length + 1), started from the simple average of the first `length` closes. */
export function exponentialAverage(closes: readonly Amount[], length: number): (Amount | null)[] {
  const seed = simpleAverage(closes, length);
  const weight = div(parseAmount('2'), parseAmount(String(length + 1)), 'half-up');
  const out: (Amount | null)[] = [];
  let prev: Amount | null = null;
  for (let i = 0; i < closes.length; i += 1) {
    if (prev === null) {
      prev = seed[i] ?? null;
    } else {
      prev = add(prev, mul(sub(closes[i]!, prev), weight, 'half-up'));
    }
    out.push(prev);
  }
  return out;
}
