import type { Preferences } from '../../shared/preferences';
import { zoneName } from './deps';

type Zone = Preferences['timeZone'];

/**
 * "14 Oct 2026, 19:01 (UTC+8)": the moment the prices were read, in the person's zone, with the zone's offset spelled
 * out (the device's own zone too, so the line is true wherever it is read).
 */
export function updatedAt(at: number, zone: Zone, language = 'en-GB'): string {
  const timeZone = zoneName(zone);
  const parts = new Intl.DateTimeFormat(language, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
    timeZoneName: 'shortOffset',
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const offset =
    part('timeZoneName')
      .replace('GMT', 'UTC')
      .replace('−', '-')
      .replace(/^UTC[+-]0$/, 'UTC') || 'UTC';
  return `${part('day')} ${part('month')} ${part('year')}, ${part('hour')}:${part('minute')} (${offset})`;
}

/** "14 Oct, 02:15" in the person's zone: the time under the crosshair and "since" labels. */
export function dayAndTime(at: number, zone: Zone, language = 'en-GB'): string {
  const parts = new Intl.DateTimeFormat(language, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: zoneName(zone),
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('day')} ${part('month')}, ${part('hour')}:${part('minute')}`;
}
