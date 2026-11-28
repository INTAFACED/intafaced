import { usePreferences, type Preferences } from '../../shared/preferences';
import { payCopy } from './copy';

const zoneName = (zone: Preferences['timeZone']): string | undefined =>
  zone === 'UTC' ? 'UTC' : zone === 'UTC+8' ? 'Etc/GMT-8' : undefined;

/**
 * "17 Oct, 21:43" ("17 Oct 2025, 21:43" in another year) in the viewer's own clock unless they picked UTC or UTC+8 in
 * Settings, in which case the zone is named. English uses day-month order, never "10/17/2026, 9:43 PM".
 */
export function payTimeText(
  value: string,
  locale: string,
  now: number = Date.now(),
  zone: Preferences['timeZone'] = 'device',
): string | null {
  const at = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(at)) return null;
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

export function PayTime({ value }: { value: string }) {
  const { requestedLocale } = payCopy.useCopy();
  const { timeZone } = usePreferences();
  const text = payTimeText(value, requestedLocale, Date.now(), timeZone);
  if (text === null) return <span lang="zxx">{value}</span>;
  return (
    <time dateTime={value} title={value} lang={requestedLocale}>
      {text}
    </time>
  );
}
