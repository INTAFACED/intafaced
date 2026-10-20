import { useMemo, useState, type ReactNode } from 'react';
import { EmptyState, Page, Panel } from '../../../shared/ui';
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
import './news.css';

/**
 * What the store holds. No vendor feed is connected and no content service is mounted, so nothing is read and both
 * lists are empty; the rooms, filters and notice are real. Items come from the store once it exists, never from a sample.
 */
const STORED_NEWS: readonly NewsItem[] = [];
const STORED_EVENTS: readonly CalendarEvent[] = [];

function Notice({ text }: { text: string }) {
  const { t } = newsCopy.useCopy();
  return (
    <div className="news-notice" role="status">
      <strong>{t('noticeTitle')}</strong>
      <p>{text}</p>
      <p className="muted">
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
    <label className="news-filter">
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

export function NewsRoom({ items = STORED_NEWS }: { items?: readonly NewsItem[] }) {
  const { t } = newsCopy.useCopy();
  const [filter, setFilter] = useState<NewsFilter>(allNews);
  const shown = useMemo(() => filterNews(items, filter), [items, filter]);
  return (
    <Page eyebrow={t('eyebrow')} title={t('newsTitle')} description={t('newsLead')}>
      <Notice text={t('newsNotice')} />
      <Panel title={t('newsTitle')}>
        <form className="news-filters" onSubmit={(event) => event.preventDefault()} aria-label={t('newsTitle')}>
          <Choice
            label={t('category')}
            value={filter.category}
            onChange={(category) => setFilter({ ...filter, category })}
            all={t('allCategories')}
            options={distinct(items.map((item) => item.category))}
          />
          <Choice
            label={t('language')}
            value={filter.language}
            onChange={(language) => setFilter({ ...filter, language })}
            all={t('allLanguages')}
            options={distinct(items.map((item) => item.language))}
          />
          <label className="news-filter">
            <span>{t('symbol')}</span>
            <input
              value={filter.symbol}
              onChange={(event) => setFilter({ ...filter, symbol: cleanSymbol(event.target.value) })}
              autoComplete="off"
              spellCheck={false}
              aria-describedby="news-symbol-hint"
            />
            <small id="news-symbol-hint" className="muted">
              {t('symbolHint')}
            </small>
          </label>
          {filtersActive(filter) ? (
            <button type="button" onClick={() => setFilter(allNews)}>
              {t('clear')}
            </button>
          ) : null}
        </form>
        {shown.length === 0 ? (
          items.length === 0 ? (
            <EmptyState title={t('newsTitle')}>{t('storeEmpty')}</EmptyState>
          ) : (
            <EmptyState title={t('filterEmptyTitle')}>{t('filterEmptyBody')}</EmptyState>
          )
        ) : (
          <ul className="news-list">
            {shown.map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong>
                <span className="muted">
                  {' '}
                  · {t('source')}: {item.source} · {t('published')}: {item.publishedAt}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <a className="text-link" href="/trade/calendar">
        {t('openCalendar')}
      </a>
    </Page>
  );
}

const PRIORITIES: readonly Priority[] = ['low', 'medium', 'high'];

export function CalendarRoom({ events = STORED_EVENTS }: { events?: readonly CalendarEvent[] }) {
  const { t } = newsCopy.useCopy();
  const [filter, setFilter] = useState<CalendarFilter>(allEvents);
  const { timeline, noReleaseTime } = useMemo(() => splitTimeline(filterEvents(events, filter)), [events, filter]);
  const verdict = (event: CalendarEvent): string | undefined => {
    const result = surprise(event);
    return result === 'none' ? undefined : t(result);
  };
  const cell = (value: string | null): ReactNode => value ?? <span className="muted">{t('notPublished')}</span>;
  return (
    <Page eyebrow={t('eyebrow')} title={t('calendarTitle')} description={t('calendarLead')}>
      <Notice text={t('calendarNotice')} />
      <Panel title={t('calendarTitle')}>
        <form className="news-filters" onSubmit={(event) => event.preventDefault()} aria-label={t('calendarTitle')}>
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
          <label className="news-filter news-filter--check">
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
            <EmptyState title={t('calendarTitle')}>{t('storeEmpty')}</EmptyState>
          ) : (
            <EmptyState title={t('filterEmptyTitle')}>{t('filterEmptyBody')}</EmptyState>
          )
        ) : (
          <table className="news-table">
            <thead>
              <tr>
                <th>{t('time')}</th>
                <th>{t('event')}</th>
                <th>{t('priority')}</th>
                <th>{t('actual')}</th>
                <th>{t('forecast')}</th>
                <th>{t('previous')}</th>
              </tr>
            </thead>
            <tbody>
              {timeline.map((event) => (
                <tr key={event.id}>
                  <td>{event.releaseAt}</td>
                  <td>{event.title}</td>
                  <td>{t(event.priority)}</td>
                  <td data-surprise={filter.highlight ? surprise(event) : 'none'} title={filter.highlight ? verdict(event) : undefined}>
                    {cell(event.actual)}
                  </td>
                  <td>{cell(event.forecast)}</td>
                  <td>{cell(event.previous)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {noReleaseTime > 0 ? <p className="muted">{t('noReleaseTime', { count: String(noReleaseTime) })}</p> : null}
      </Panel>
      <a className="text-link" href="/trade/news">
        {t('openNews')}
      </a>
    </Page>
  );
}
