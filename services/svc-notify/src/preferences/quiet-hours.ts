/**
 * Quiet hours are a local wall-clock window in a zone the platform tz database
 * accepts. There is no default window. End is exclusive. A notice inside the
 * window is held until the UTC instant this module names, including across
 * midnight and a daylight-saving gap.
 */

export type QuietHoursCode =
  'notify.quiet_zone_invalid' | 'notify.quiet_hours_invalid' | 'notify.quiet_hours_empty' | 'notify.quiet_hours_incomplete';

export class QuietHoursError extends Error {
  constructor(readonly code: QuietHoursCode) {
    super(code);
    this.name = 'QuietHoursError';
  }
}

/**
 * Node's `supportedValuesOf('timeZone')` omits these even though the IANA
 * database and `Intl.DateTimeFormat` accept them. Anything else must be on
 * the platform list, exact case.
 */
const EXTRA_PLATFORM_ZONES = new Set(['UTC', 'Etc/UTC', 'Etc/GMT']);

const ZONE_SHAPE = /^[A-Za-z0-9_/+-]{1,64}$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type QuietWindow = {
  readonly start: string;
  readonly end: string;
  readonly timeZone: string;
};

export function assertIanaTimeZone(zone: string): string {
  if (typeof zone !== 'string' || !ZONE_SHAPE.test(zone)) {
    throw new QuietHoursError('notify.quiet_zone_invalid');
  }
  const listed = Intl.supportedValuesOf('timeZone');
  if (!listed.includes(zone) && !EXTRA_PLATFORM_ZONES.has(zone)) {
    throw new QuietHoursError('notify.quiet_zone_invalid');
  }
  try {
    Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new QuietHoursError('notify.quiet_zone_invalid');
  }
  return zone;
}

/** Minutes from local midnight. Refuses anything that is not HH:MM. */
export function parseClock(value: string): number {
  const match = CLOCK.exec(value);
  if (!match) throw new QuietHoursError('notify.quiet_hours_invalid');
  return Number(match[1]) * 60 + Number(match[2]);
}

export function assertQuietWindow(input: { start?: string; end?: string; timeZone?: string } | null | undefined): QuietWindow {
  if (input == null) throw new QuietHoursError('notify.quiet_hours_incomplete');
  if (input.start == null || input.end == null || input.timeZone == null) {
    throw new QuietHoursError('notify.quiet_hours_incomplete');
  }
  const timeZone = assertIanaTimeZone(input.timeZone);
  const startMin = parseClock(input.start);
  const endMin = parseClock(input.end);
  if (startMin === endMin) throw new QuietHoursError('notify.quiet_hours_empty');
  return { start: input.start, end: input.end, timeZone };
}

export function localMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const hourRaw = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  const hour = hourRaw === 24 ? 0 : hourRaw;
  return hour * 60 + minute;
}

export function inQuietHours(instant: Date, window: QuietWindow): boolean {
  const start = parseClock(window.start);
  const end = parseClock(window.end);
  const local = localMinutes(instant, window.timeZone);
  if (start < end) return local >= start && local < end;
  return local >= start || local < end;
}

/**
 * First UTC instant at which `instant`'s quiet window has ended.
 * Null when `instant` is already outside the window.
 */
export function quietReleaseUtc(instant: Date, window: QuietWindow): Date | null {
  if (!inQuietHours(instant, window)) return null;
  let lo = instant.getTime();
  const limit = lo + 26 * 60 * 60 * 1000;
  while (lo < limit && inQuietHours(new Date(lo + 60_000), window)) {
    lo += 60_000;
  }
  let low = lo;
  let high = Math.min(lo + 60_000, limit);
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (inQuietHours(new Date(mid), window)) low = mid;
    else high = mid;
  }
  return new Date(high);
}
