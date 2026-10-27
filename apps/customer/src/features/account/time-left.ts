const UNITS = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1],
] as const;

/**
 * Time left, rounded up, in the largest unit that has at least one whole of it. When rounding up fills the next unit
 * (3,541 seconds is 60 minutes once rounded), it is said in that unit: "1 hour", never "60 minutes", so the words don't
 * depend on whether the page drew in the first second of an hour's hold or the next one.
 */
export function timeLeft(seconds: number, locale: string): string {
  const s = Math.max(1, Math.ceil(seconds));
  let i = UNITS.findIndex(([, n]) => s >= n);
  if (i > 0 && Math.ceil(s / UNITS[i]![1]) * UNITS[i]![1] >= UNITS[i - 1]![1]) i -= 1;
  const [unit, size] = UNITS[i]!;
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(Math.ceil(s / size));
}
