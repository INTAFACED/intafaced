/**
 * A count the service records is a number, including zero.
 * A count it does not record is null with reason `metric_not_recorded`.
 * Zero is never used as a stand-in for "we do not record this".
 */
export type MetricCell = {
  readonly value: number | null;
  readonly reason: 'metric_not_recorded' | null;
};

export function metricFromCount(count: number | undefined, recorded: boolean): MetricCell {
  if (!recorded) return { value: null, reason: 'metric_not_recorded' };
  return { value: count ?? 0, reason: null };
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseUtcDay(value: string): { y: number; m: number; d: number; iso: string } {
  const match = DAY.exec(value);
  if (!match) {
    throw new Error('not a UTC day');
  }
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new Error('not a UTC day');
  }
  return { y, m, d, iso: `${match[1]}-${match[2]}-${match[3]}` };
}

export function utcDaysInclusive(fromIso: string, toIso: string): string[] {
  const from = parseUtcDay(fromIso);
  const to = parseUtcDay(toIso);
  const start = Date.UTC(from.y, from.m - 1, from.d);
  const end = Date.UTC(to.y, to.m - 1, to.d);
  const days: string[] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}
