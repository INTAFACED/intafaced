import type { Preferences } from '../../shared/preferences';

type Zone = Preferences['timeZone'];

const zoneName = (zone: Zone): string | undefined => (zone === 'UTC' ? 'UTC' : zone === 'UTC+8' ? 'Etc/GMT-8' : undefined);

/** "19:29" in the viewer's own clock unless they picked UTC or UTC+8 in Settings, in which case the zone is named. */
export function clockTime(at: number, zone: Zone): string {
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zoneName(zone) }).format(at);
  return zone === 'device' ? time : `${time} ${zone}`;
}

/**
 * "14 Oct, 19:29" in the viewer's zone ("14 Oct 2025, 19:29" when it is not this year); a picked zone is named.
 * `at` is an ISO time from the service. An unreadable time shows "—", never a made-up one. `seconds` adds them, for a
 * deadline shorter than a minute can show.
 */
export function stamp(iso: string, zone: Zone, now: number = Date.now(), seconds = false): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '—';
  const timeZone = zoneName(zone);
  const year = (ms: number) => new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone }).format(ms);
  const sameYear = year(at) === year(now);
  const text = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    hour12: false,
    timeZone,
  })
    .format(at)
    .replace(',', '');
  const date = text.slice(0, text.lastIndexOf(' '));
  const clock = text.slice(text.lastIndexOf(' ') + 1);
  return `${date}, ${clock}${zone === 'device' ? '' : ` ${zone}`}`;
}

/** The calendar day ("2026-10-24") an instant falls on in the viewer's zone, as a date input takes it. */
export function dayIn(iso: string, zone: Zone): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: zoneName(zone) }).format(at);
}
