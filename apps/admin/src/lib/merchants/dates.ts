/** UTC day helpers. The read model buckets by UTC day, so every range here is whole UTC days. */
export const DAY_MS = 86_400_000;
export const dayOf = (date: Date): string => date.toISOString().slice(0, 10);
export const addDays = (day: string, n: number): string => dayOf(new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS));
export const midnight = (day: string): string => `${day}T00:00:00.000Z`;

/** `count` consecutive days ending with `last`, oldest first. */
export function daysEndingAt(last: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(last, i - (count - 1)));
}
