import type { Preferences } from '../../../shared/preferences';

type Zone = Preferences['timeZone'];

/** IANA zone for the person's setting; undefined means the device's own zone. */
export function zoneName(zone: Zone): string | undefined {
  return zone === 'UTC' ? 'UTC' : zone === 'UTC+8' ? 'Etc/GMT-8' : undefined;
}

/** "19:29:05" in the person's zone (the order book's trade times). */
export function clockSeconds(at: number, zone: Zone): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: zoneName(zone),
  }).format(at);
}

/** "14 Oct, 19:29" in the person's zone, naming the zone when it is not the device's own (critic H6). */
export function dayTime(at: number, zone: Zone): string {
  const text = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: zoneName(zone),
  }).format(at);
  return zone === 'device' ? text : `${text} ${zone}`;
}

/** "19:29", for "since 19:29" labels. */
export function clockMinutes(at: number, zone: Zone): string {
  const text = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zoneName(zone) }).format(at);
  return zone === 'device' ? text : `${text} ${zone}`;
}
