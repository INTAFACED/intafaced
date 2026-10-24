/**
 * Times in a founder's own time zone (their console preference), for the few places where a founder types or reads a wall
 * clock: an announcement's window. The console's other times stay UTC (`as-of.ts`), so two founders read the same words.
 *
 * Built from `Intl.DateTimeFormat#formatToParts` with fixed English month names and a 24-hour clock, so the server render
 * and the browser agree.
 *
 *   zonedInputToIso('2026-10-24T12:00', 'Europe/Berlin') → '2026-10-24T10:00:00.000Z'
 *   isoToZonedInput('2026-10-24T10:00:00.000Z', 'Europe/Berlin') → '2026-10-24T12:00'
 *   formatInZone('2026-10-24T10:00:00.000Z', 'Europe/Berlin') → '24 Oct 2026, 12:00 (Europe/Berlin)'
 *
 * A typed value that names no instant (30 February, 24:00, a time a clock change skips) is null, never a nearby instant.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

type Wall = { year: number; month: number; day: number; hour: number; minute: number };

function wallClock(ms: number, timeZone: string): Wall {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

const asUtc = (w: Wall) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
const two = (n: number) => String(n).padStart(2, '0');

/** A `datetime-local` value read in `timeZone`, as an ISO instant; null when it is not one. */
export function zonedInputToIso(value: string, timeZone: string): string | null {
  const m = INPUT.exec(value);
  if (!m) return null;
  const wanted: Wall = { year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]! };
  try {
    // Guess the instant as if the zone were UTC, then correct by the zone's offset at that instant (twice, for a guess
    // that lands across an offset change).
    let ms = asUtc(wanted);
    for (let i = 0; i < 2; i += 1) ms -= asUtc(wallClock(ms, timeZone)) - asUtc(wanted);
    // The instant must read back as the wall clock typed: 30 February, 24:00 or a time a clock change skips is no instant.
    if (!Number.isFinite(ms)) return null;
    const back = wallClock(ms, timeZone);
    const same = (Object.keys(wanted) as (keyof Wall)[]).every((k) => back[k] === wanted[k]);
    return same ? new Date(ms).toISOString() : null;
  } catch {
    return null;
  }
}

/** An instant as a `datetime-local` value in `timeZone`. */
export function isoToZonedInput(iso: string, timeZone: string): string {
  const w = wallClock(Date.parse(iso), timeZone);
  return `${w.year}-${two(w.month)}-${two(w.day)}T${two(w.hour)}:${two(w.minute)}`;
}

/** An instant as words in `timeZone`, naming the zone; "unknown time" when it is not one. */
export function formatInZone(iso: string | null | undefined, timeZone: string): string {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return 'unknown time';
  try {
    const w = wallClock(ms, timeZone);
    return `${w.day} ${MONTHS[w.month - 1]} ${w.year}, ${two(w.hour)}:${two(w.minute)} (${timeZone})`;
  } catch {
    return 'unknown time';
  }
}
