import type { Preferences } from '../../shared/preferences';

type Zone = Preferences['timeZone'];

/**
 * "19:29" in the viewer's own clock (the browser's zone) unless they picked UTC or UTC+8 in Settings, in which
 * case the zone is named: "11:29 UTC". A bare "11:00" that is really UTC reads as local time (critic H6).
 */
export function clockTime(at: number, zone: Zone): string {
  const timeZone = zone === 'UTC' ? 'UTC' : zone === 'UTC+8' ? 'Etc/GMT-8' : undefined;
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(at);
  return zone === 'device' ? time : `${time} ${zone}`;
}
