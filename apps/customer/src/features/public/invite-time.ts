import type { Preferences } from '../../shared/preferences';

const zoneName = (zone: Preferences['timeZone']): string | undefined =>
  zone === 'UTC' ? 'UTC' : zone === 'UTC+8' ? 'Etc/GMT-8' : undefined;

/**
 * Formats an ISO timestamp for `/invite` in 24-hour day-month order in the viewer's clock unless they picked UTC or
 * UTC+8 in Settings, in which case the zone is named. Never renders US "Nov 23, 2026, 7:05 AM UTC".
 */
export function inviteTimeText(value: string, locale: string, zone: Preferences['timeZone'] = 'device', now: number = Date.now()): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return value;
  const tag = locale.toLowerCase() === 'en' || locale.toLowerCase() === 'en-us' ? 'en-GB' : locale;
  const timeZone = zoneName(zone);
  const year = (ms: number) => new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone }).format(ms);
  const text = new Intl.DateTimeFormat(tag, {
    day: 'numeric',
    month: 'short',
    ...(year(at) === year(now) ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(at);
  return zone === 'device' ? text : `${text} ${zone}`;
}
