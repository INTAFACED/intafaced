import { formatDay, formatDateTime } from './format';
import { uiCopy } from './copy';

export { formatDateTime, formatDay, UTC } from './format';

/**
 * Every timestamp in the portal, in one format with its zone named: "Oct 15, 2026, 10:40 PM GMT+8". The tooltip holds the
 * full date, time and zone. Pass `timeZone="UTC"` for statements, as-of times and limit resets, and add `dayOnly` for a
 * day bucket ("Oct 15, 2026"). See ./format.ts for the rules.
 */
export function DateTime({ value, timeZone, dayOnly = false }: { value: string; timeZone?: string; dayOnly?: boolean }) {
  const { requestedLocale } = uiCopy.useCopy();
  const parts = formatDateTime(value, requestedLocale, timeZone);
  if (!parts) return <span lang="zxx">{value}</span>;
  return (
    <time dateTime={value} title={parts.full} lang={requestedLocale}>
      {dayOnly ? (formatDay(value, requestedLocale, timeZone) ?? parts.short) : parts.short}
    </time>
  );
}

/** A day bucket ("2026-10-15", always a UTC day) as text in the same format as every other date: "Oct 15, 2026". */
export function useDayText(): (day: string) => string {
  const { requestedLocale } = uiCopy.useCopy();
  return (day) => formatDay(/^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T00:00:00.000Z` : day, requestedLocale, 'UTC') ?? day;
}
