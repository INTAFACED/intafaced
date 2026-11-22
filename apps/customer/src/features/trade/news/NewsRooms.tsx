// volt-room: /trade/news
// volt-room: /trade/calendar
import { useMemo, useState, type ReactNode } from 'react';
import { Button, EmptyState } from '@intafaced/ui/lit';
import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { newsCopy } from './news-copy';
import {
  allEvents,
  allNews,
  cleanSymbol,
  filterEvents,
  filterNews,
  filtersActive,
  splitTimeline,
  surprise,
  type CalendarEvent,
  type CalendarFilter,
  type NewsFilter,
  type NewsItem,
  type Priority,
} from './news-model';

/**
 * What the store holds. No vendor feed is connected and no content service is mounted, so nothing is read and both
 * lists are empty; the rooms, filters and notice are real. Items come from the store once it exists, never from a sample.
 */
const STORED_NEWS: readonly NewsItem[] = [];
const STORED_EVENTS: readonly CalendarEvent[] = [];

/** The feed.news notice the rooms open with: its sentence and its allowlist code, in one status. */
function FeedNotice({ text }: { text: string }) {
  const { t } = newsCopy.useCopy();
  return (
    <div className="lt-refusal" data-refusal="parked" role="status">
      <p className="lt-refusal-title">{t('noticeTitle')}</p>
      <p className="lt-refusal-body">{text}</p>
      <p className="lt-ref">
        {t('code')}: <code>{t('feedCode')}</code>
      </p>
    </div>
  );
}

function Choice({
  label,
  value,
  onChange,
  all,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  all: string;
  options: ReadonlyArray<readonly [value: string, label: string]>;
}) {
  return (
    <label className="lt-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{all}</option>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

const distinct = (values: readonly string[]): ReadonlyArray<readonly [string, string]> =>
  [...new Set(values)].sort().map((value) => [value, value] as const);

/**
 * The categories and languages a person can filter by. They are the filter's own choices, not read from the store, so the
 * filters work on an empty store and read empty; a stored item with another value adds its own choice.
 */
const CATEGORIES = [
  ['markets', 'categoryMarkets'],
  ['crypto', 'categoryCrypto'],
  ['macro', 'categoryMacro'],
  ['company', 'categoryCompany'],
  ['regulation', 'categoryRegulation'],
] as const;
const LANGUAGES = [
  ['en', 'languageEn'],
  ['es', 'languageEs'],
  ['fr', 'languageFr'],
] as const;
const label = (options: ReadonlyArray<readonly [string, string]>, value: string): string =>
  options.find(([candidate]) => candidate === value)?.[1] ?? value;
function withStored(known: ReadonlyArray<readonly [string, string]>, stored: readonly string[]): ReadonlyArray<readonly [string, string]> {
  const seen = new Set(known.map(([value]) => value));
  return [...known, ...distinct(stored.filter((value) => !seen.has(value)))];
}

export function NewsRoom({ items = STORED_NEWS }: { items?: readonly NewsItem[] }) {
  const { t } = newsCopy.useCopy();
  const [filter, setFilter] = useState<NewsFilter>(allNews);
  const shown = useMemo(() => filterNews(items, filter), [items, filter]);
  const categoryOptions = withStored(
    CATEGORIES.map(([value, key]) => [value, t(key)] as const),
    items.map((item) => item.category),
  );
  const languageOptions = withStored(
    LANGUAGES.map(([value, key]) => [value, t(key)] as const),
    items.map((item) => item.language),
  );
  return (
    <ReadingTemplate
      title={t('newsTitle')}
      description={t('newsLead')}
      state={{ kind: 'ready' }}
      meta={
        <>
          <p className="lt-hint">{t('eyebrow')}</p>
          <FeedNotice text={t('newsNotice')} />
        </>
      }
      body={
        <>
          <form className="lt-toolbar" onSubmit={(event) => event.preventDefault()} aria-label={t('newsTitle')}>
            <Choice
              label={t('category')}
              value={filter.category}
              onChange={(category) => setFilter({ ...filter, category })}
              all={t('allCategories')}
              options={categoryOptions}
            />
            <Choice
              label={t('language')}
              value={filter.language}
              onChange={(language) => setFilter({ ...filter, language })}
              all={t('allLanguages')}
              options={languageOptions}
            />
            <label className="lt-field">
              <span>{t('symbol')}</span>
              <input
                value={filter.symbol}
                onChange={(event) => setFilter({ ...filter, symbol: cleanSymbol(event.target.value) })}
                autoComplete="off"
                spellCheck={false}
                aria-describedby="news-symbol-hint"
              />
              <small id="news-symbol-hint">{t('symbolHint')}</small>
            </label>
            {filtersActive(filter) ? <Button onClick={() => setFilter(allNews)}>{t('clear')}</Button> : null}
          </form>
          <p className="lt-hint" data-testid="news-applied" aria-live="polite">
            {filtersActive(filter)
              ? t('appliedSome', {
                  filters: [
                    filter.category ? `${t('category')} ${label(categoryOptions, filter.category)}` : '',
                    filter.language ? `${t('language')} ${label(languageOptions, filter.language)}` : '',
                    cleanSymbol(filter.symbol) ? `${t('symbol')} ${cleanSymbol(filter.symbol)}` : '',
                  ]
                    .filter(Boolean)
                    .join(' · '),
                  shown: String(shown.length),
                  count: String(items.length),
                })
              : t('appliedNone', { count: String(items.length) })}
          </p>
          {shown.length === 0 ? (
            items.length === 0 ? (
              <EmptyState title={t('newsTitle')} body={t('storeEmpty')} />
            ) : (
              <EmptyState title={t('filterEmptyTitle')} body={t('filterEmptyBody')} />
            )
          ) : (
            <ul data-news-list="">
              {shown.map((item) => (
                <li key={item.id}>
                  <strong>{item.title}</strong>
                  <span className="lt-hint">
                    {' '}
                    · {t('source')}: {item.source} · {t('published')}: {item.publishedAt}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      }
      related={
        <a className="lt-link" href="/trade/calendar">
          {t('openCalendar')}
        </a>
      }
    />
  );
}

const PRIORITIES: readonly Priority[] = ['low', 'medium', 'high'];
/** A published actual above its forecast reads up, below reads down (the kit colours `data-dir` inside a room). */
const DIRECTION: Record<ReturnType<typeof surprise>, 'up' | 'down' | undefined> = {
  above: 'up',
  below: 'down',
  inline: undefined,
  none: undefined,
};

export function CalendarRoom({ events = STORED_EVENTS }: { events?: readonly CalendarEvent[] }) {
  const { t } = newsCopy.useCopy();
  const [filter, setFilter] = useState<CalendarFilter>(allEvents);
  const { timeline, noReleaseTime } = useMemo(() => splitTimeline(filterEvents(events, filter)), [events, filter]);
  const verdict = (event: CalendarEvent): string | undefined => {
    const result = surprise(event);
    return result === 'none' ? undefined : t(result);
  };
  const cell = (value: string | null): ReactNode => value ?? <span className="lt-hint">{t('notPublished')}</span>;
  return (
    <ReadingTemplate
      title={t('calendarTitle')}
      description={t('calendarLead')}
      state={{ kind: 'ready' }}
      meta={
        <>
          <p className="lt-hint">{t('eyebrow')}</p>
          <FeedNotice text={t('calendarNotice')} />
        </>
      }
      body={
        <>
          <form className="lt-toolbar" onSubmit={(event) => event.preventDefault()} aria-label={t('calendarTitle')}>
            <Choice
              label={t('priority')}
              value={filter.priority}
              onChange={(priority) => setFilter({ ...filter, priority: PRIORITIES.find((p) => p === priority) ?? '' })}
              all={t('allPriorities')}
              options={PRIORITIES.map((priority) => [priority, t(priority)] as const)}
            />
            <Choice
              label={t('country')}
              value={filter.country}
              onChange={(country) => setFilter({ ...filter, country })}
              all={t('allCountries')}
              options={distinct(events.map((event) => event.country))}
            />
            <label className="lt-field">
              <input
                type="checkbox"
                checked={filter.highlight}
                onChange={(event) => setFilter({ ...filter, highlight: event.target.checked })}
              />
              <span>{t('highlight')}</span>
            </label>
          </form>
          {timeline.length === 0 && noReleaseTime === 0 ? (
            events.length === 0 ? (
              <EmptyState title={t('calendarTitle')} body={t('storeEmpty')} />
            ) : (
              <EmptyState title={t('filterEmptyTitle')} body={t('filterEmptyBody')} />
            )
          ) : (
            <table className="lt-table" data-news-table="">
              <caption className="lt-sr">{t('calendarTitle')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('time')}</th>
                  <th scope="col">{t('event')}</th>
                  <th scope="col">{t('priority')}</th>
                  <th scope="col">{t('actual')}</th>
                  <th scope="col">{t('forecast')}</th>
                  <th scope="col">{t('previous')}</th>
                </tr>
              </thead>
              <tbody>
                {timeline.map((event) => (
                  <tr key={event.id}>
                    <td data-label={t('time')}>{event.releaseAt}</td>
                    <td data-label={t('event')}>{event.title}</td>
                    <td data-label={t('priority')}>{t(event.priority)}</td>
                    <td
                      data-label={t('actual')}
                      data-dir={filter.highlight ? DIRECTION[surprise(event)] : undefined}
                      data-surprise={filter.highlight ? surprise(event) : 'none'}
                      title={filter.highlight ? verdict(event) : undefined}
                    >
                      {cell(event.actual)}
                    </td>
                    <td data-label={t('forecast')}>{cell(event.forecast)}</td>
                    <td data-label={t('previous')}>{cell(event.previous)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {noReleaseTime > 0 ? <p className="lt-hint">{t('noReleaseTime', { count: String(noReleaseTime) })}</p> : null}
        </>
      }
      related={
        <a className="lt-link" href="/trade/news">
          {t('openNews')}
        </a>
      }
    />
  );
}
