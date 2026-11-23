import { payCopy } from './copy';

/**
 * "17 Oct, 21:43 UTC" ("17 Oct 2025, 21:43 UTC" in another year): the same day-month and 24-hour clock as the rest of the app,
 * always in UTC and always naming it, since Pay services record UTC. English uses day-month order, never "10/17/2026, 9:43 PM".
 */
export function payTimeText(value: string, locale: string, now: number = Date.now()): string | null {
  const at = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(at)) return null;
  const tag = locale.toLowerCase() === 'en' || locale.toLowerCase() === 'en-us' ? 'en-GB' : locale;
  const year = (ms: number) => new Date(ms).getUTCFullYear();
  const text = new Intl.DateTimeFormat(tag, {
    day: 'numeric',
    month: 'short',
    ...(year(at) === year(now) ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  }).format(at);
  return `${text} UTC`;
}

export function PayTime({ value }: { value: string }) {
  const { requestedLocale } = payCopy.useCopy();
  const text = payTimeText(value, requestedLocale);
  if (text === null) return <span lang="zxx">{value}</span>;
  return (
    <time dateTime={value} title={value} lang={requestedLocale}>
      {text}
    </time>
  );
}
