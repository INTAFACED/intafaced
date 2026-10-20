import { compare, dec } from '../../../data/decimal';

/** The shape of one stored news item. The store holds no items on this build, so every list is empty. */
export interface NewsItem {
  id: string;
  title: string;
  source: string;
  category: string;
  language: string;
  symbols: readonly string[];
  publishedAt: string;
}
export type Priority = 'low' | 'medium' | 'high';
/** The shape of one stored calendar event. Values are decimal strings as published; a blank is `null`, never a guess. */
export interface CalendarEvent {
  id: string;
  title: string;
  country: string;
  priority: Priority;
  releaseAt: string | null;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
}

export interface NewsFilter {
  category: string;
  language: string;
  symbol: string;
}
export const allNews: NewsFilter = { category: '', language: '', symbol: '' };

/** A symbol typed into the filter: letters, digits and the usual separators, upper-cased. Anything else filters on nothing. */
export const cleanSymbol = (raw: string): string =>
  raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9._:/-]/g, '');

export function filterNews(items: readonly NewsItem[], filter: NewsFilter): NewsItem[] {
  const symbol = cleanSymbol(filter.symbol);
  return items.filter(
    (item) =>
      (filter.category === '' || item.category === filter.category) &&
      (filter.language === '' || item.language === filter.language) &&
      (symbol === '' || item.symbols.some((candidate) => candidate.toUpperCase() === symbol)),
  );
}
export const filtersActive = (filter: NewsFilter): boolean =>
  filter.category !== '' || filter.language !== '' || cleanSymbol(filter.symbol) !== '';

export interface CalendarFilter {
  priority: Priority | '';
  country: string;
  highlight: boolean;
}
export const allEvents: CalendarFilter = { priority: '', country: '', highlight: true };

export function filterEvents(events: readonly CalendarEvent[], filter: CalendarFilter): CalendarEvent[] {
  return events.filter(
    (event) =>
      (filter.priority === '' || event.priority === filter.priority) && (filter.country === '' || event.country === filter.country),
  );
}

/** Events with a release time go on the timeline, oldest first; events without one are counted apart and never placed. */
export function splitTimeline(events: readonly CalendarEvent[]): { timeline: CalendarEvent[]; noReleaseTime: number } {
  const timed = events.filter((event) => event.releaseAt !== null && Number.isFinite(Date.parse(event.releaseAt)));
  timed.sort((a, b) => Date.parse(a.releaseAt!) - Date.parse(b.releaseAt!) || a.id.localeCompare(b.id));
  return { timeline: timed, noReleaseTime: events.length - timed.length };
}

/** Actual against forecast. Colour needs both published as exact numbers; otherwise it is `none`, never a guess. */
export function surprise(event: Pick<CalendarEvent, 'actual' | 'forecast'>): 'above' | 'below' | 'inline' | 'none' {
  const actual = dec(event.actual);
  const forecast = dec(event.forecast);
  if (actual === null || forecast === null) return 'none';
  const order = compare(actual, forecast);
  return order > 0 ? 'above' : order < 0 ? 'below' : 'inline';
}
