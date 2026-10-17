/**
 * One way to print a time on a founder desk. Always UTC and never locale-dependent, so the server render and the browser
 * agree (no hydration mismatch) and two founders in two time zones read the same words.
 *
 *   formatAsOf("2026-10-18T01:09:59.123Z") → "01:09:59 UTC"            when a read was made (Trade ops' "as of 01:09:59", plus the zone)
 *   formatWhen("2026-10-15T10:02:03.000Z") → "15 Oct 2026, 10:02:03 UTC"  when something happened, which may be days ago
 *
 * A value that is not a valid time prints as "unknown time", never as the raw text.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const UNKNOWN = 'unknown time';

function parts(iso: string | null | undefined): Date | null {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : null;
}
const two = (n: number) => String(n).padStart(2, '0');
const clock = (d: Date) => `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} UTC`;

export function formatAsOf(iso: string | null | undefined): string {
  const d = parts(iso);
  return d ? clock(d) : UNKNOWN;
}

export function formatWhen(iso: string | null | undefined): string {
  const d = parts(iso);
  return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${clock(d)}` : UNKNOWN;
}
