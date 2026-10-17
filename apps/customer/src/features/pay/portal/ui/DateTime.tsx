import { uiCopy } from './copy';

/** "Oct 15, 10:40 PM" in the browser's time zone, with the year only when it isn't this year. */
export function formatDateTime(
  value: string,
  locale: string,
  now: Date = new Date(),
  timeZone?: string,
): { short: string; full: string } | null {
  const date = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(date.getTime())) return null;
  const zone = timeZone ? { timeZone } : {};
  const sameYear =
    new Intl.DateTimeFormat('en', { year: 'numeric', ...zone }).format(date) ===
    new Intl.DateTimeFormat('en', { year: 'numeric', ...zone }).format(now);
  return {
    short: date.toLocaleString(locale, {
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
      hour: 'numeric',
      minute: '2-digit',
      ...zone,
    }),
    full: date.toLocaleString(locale, { dateStyle: 'full', timeStyle: 'long', ...zone }),
  };
}

/** Every timestamp in the portal. The tooltip holds the full date, time and zone. */
export function DateTime({ value, timeZone }: { value: string; timeZone?: string }) {
  const { requestedLocale } = uiCopy.useCopy();
  const parts = formatDateTime(value, requestedLocale, new Date(), timeZone);
  if (!parts) return <span lang="zxx">{value}</span>;
  return (
    <time dateTime={value} title={parts.full} lang={requestedLocale}>
      {parts.short}
    </time>
  );
}
