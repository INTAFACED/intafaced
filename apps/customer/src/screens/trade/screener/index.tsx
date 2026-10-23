import { useMemo, useState, type ChangeEvent } from 'react';
import { Sparkline } from '@intafaced/ui';
import {
  SAVED_SCREENS_NAMESPACE,
  savedScreensPreferenceSchema,
  savedScreensRequestId,
  type SavedScreensValue,
} from '@intafaced/contracts/watchlists-preferences';
import type { ScreenProps } from '../../../app/screen-types';
import { fmtPct, fmtPrice, fmtAmount, useMarkets, useSparklines, useTickers } from '../../../data';
import { screenerCopy } from '../../../features/screener/copy';
import { useCloses } from '../../../features/screener/data';
import {
  buildRows,
  COLUMN_IDS,
  DEFAULT_COLUMNS,
  DEFAULT_FILTERS,
  DEFAULT_TIMEFRAME,
  emptyReason,
  isServed,
  resultsCsv,
  SCREENER_MARKET_LIMIT,
  screenRecord,
  screenRows,
  TIMEFRAME_IDS,
  withScreen,
  type ChangeTimeframe,
  type ScreenColumn,
  type ScreenFilters,
} from '../../../features/screener/model';
import { savedScreensStoredSchema, useAccountRecord, refusalCode, useWatchlists } from '../../../features/watchlists/store';
import { slugId } from '../../../features/watchlists/model';
import './screener.css';

const BOUND = /^-?\d{1,18}(\.\d{1,18})?$/;
const BOUND_KEYS = ['changeMin', 'changeMax', 'volumeMin', 'lastMin', 'lastMax'] as const;
type BoundKey = (typeof BOUND_KEYS)[number];

/** The words for a screen that ended with no markets: the filter that removed every one, named. */
type CopyT = ReturnType<typeof screenerCopy.useCopy>['t'];

function emptyWords(t: CopyT, reason: ReturnType<typeof emptyReason>, filters: ScreenFilters, timeframe: ChangeTimeframe): string {
  if (reason === 'universe') return t('Empty universe');
  if (reason === 'quote') return t('Empty quote', { quote: filters.quote ?? '' });
  if (reason === 'change') return isServed(timeframe) ? t('Empty change', { timeframe }) : t('Change not served', { timeframe });
  if (reason === 'volume') return t('Empty volume');
  return t('Empty last');
}

export default function TradeScreenerScreen(_props: ScreenProps) {
  const { t } = screenerCopy.useCopy();
  const markets = useMarkets({ includeClosed: true });
  const tickers = useTickers({ intervalMs: 5000 });
  const watchlists = useWatchlists();
  const saved = useAccountRecord<SavedScreensValue>(
    SAVED_SCREENS_NAMESPACE,
    { read: savedScreensPreferenceSchema, stored: savedScreensStoredSchema },
    savedScreensRequestId,
    [],
  );

  const [filters, setFilters] = useState<ScreenFilters>(DEFAULT_FILTERS);
  const [columns, setColumns] = useState<ScreenColumn[]>(DEFAULT_COLUMNS);
  const [timeframe, setTimeframe] = useState<ChangeTimeframe>(DEFAULT_TIMEFRAME);
  const [view, setView] = useState<'table' | 'chart'>('table');
  const [name, setName] = useState('');
  const [replacing, setReplacing] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);

  const listing = markets.status === 'ready' ? markets.data : [];
  const tickerMap = tickers.status === 'ready' ? tickers.data : undefined;

  const listSymbols = useMemo(() => {
    if (filters.universe !== 'list' || !filters.listId) return null;
    const list = watchlists.value.find((item) => item.id === filters.listId);
    return list ? list.sections.flatMap((section) => section.symbols) : [];
  }, [filters.universe, filters.listId, watchlists.value]);

  const universe = useMemo(() => (listSymbols === null ? null : new Set(listSymbols)), [listSymbols]);
  // Closes (the 1 h and 1 d change) are read only when a change column or change bound needs them, and only for the markets the
  // other filters keep: the screen never fans a read out across the whole listing.
  const needCloses =
    (timeframe === '1h' || timeframe === '1d') && (columns.includes('change') || filters.changeMin !== null || filters.changeMax !== null);
  const kept = useMemo(
    () =>
      needCloses
        ? screenRows(
            buildRows(listing, tickerMap, undefined, timeframe, universe),
            { ...filters, changeMin: null, changeMax: null },
            timeframe,
          ).rows.map((row) => row.symbol)
        : [],
    [needCloses, listing, tickerMap, timeframe, universe, filters],
  );
  const closes = useCloses(kept, timeframe);
  const screened = useMemo(
    () => buildRows(listing, tickerMap, closes.status === 'ready' ? closes.data : undefined, timeframe, universe),
    [listing, tickerMap, closes, timeframe, universe],
  );
  const result = useMemo(() => screenRows(screened, filters, timeframe), [screened, filters, timeframe]);
  // Sparklines are drawn only in the chart view, so the table never reads them.
  const sparks = useSparklines(view === 'chart' ? result.rows.map((row) => row.symbol) : []);

  // A bound that is not a plain decimal is named here and blocks a save; the filter it names is not applied until it is fixed.
  const invalidBounds = BOUND_KEYS.filter((key) => {
    const text = filters[key];
    return text !== null && !BOUND.test(text);
  });
  const invalid = invalidBounds.length > 0;

  const setBound = (key: BoundKey, text: string) => {
    const trimmed = text.trim();
    setFilters((now) => ({ ...now, [key]: trimmed === '' ? null : trimmed }));
  };
  const toggleColumn = (column: ScreenColumn) =>
    setColumns((now) =>
      now.includes(column) ? now.filter((item) => item !== column) : COLUMN_IDS.filter((id) => id === column || now.includes(id)),
    );

  const openScreen = (screen: SavedScreensValue[number]) => {
    setFilters(screen.filters);
    setColumns(screen.columns);
    setTimeframe(screen.changeTimeframe);
    setNotice({ tone: 'ok', text: t('Opened {name}', { name: screen.name }) });
  };

  const save = async () => {
    if (invalidBounds.length > 0) {
      setNotice({ tone: 'warn', text: t('Invalid bound save') });
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      setNotice({ tone: 'warn', text: t('Name needed') });
      return;
    }
    const existing = saved.value.find((screen) => screen.name.toLowerCase() === trimmed.toLowerCase());
    if (existing && replacing !== existing.name) {
      setReplacing(existing.name);
      return;
    }
    const taken = new Set(saved.value.map((screen) => screen.id));
    const id = existing ? existing.id : slugId(trimmed, taken);
    const record = screenRecord(id, trimmed, filters, columns, timeframe);
    const outcome = await saved.commit(withScreen(saved.value, record));
    if (outcome.ok) {
      setNotice({ tone: 'ok', text: existing ? t('Replaced {name}', { name: trimmed }) : t('Saved as {name}', { name: trimmed }) });
      setName('');
      setReplacing(null);
      return;
    }
    const code = refusalCode(outcome.code);
    const words =
      code === 'identity.saved_screen_cap_unset'
        ? t('Cap unset saved')
        : code === 'identity.saved_screen_cap_exceeded'
          ? t('Cap exceeded saved')
          : t('Not saved');
    setNotice({ tone: 'warn', text: words });
  };

  const exportRows = () => {
    const file = `screener-results-${timeframe}.csv`;
    const blob = new Blob([resultsCsv(result.rows, columns, timeframe)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice({ tone: 'ok', text: t('Results downloaded', { file }) });
  };

  const quotes = [...new Set(listing.map((market) => market.quote))].sort();
  const changeLabel = `${timeframe}`;
  const empty = result.rows.length === 0;
  const reason = emptyReason(result.stages);

  return (
    <section className="sc" aria-label={t('Screener')}>
      <header className="sc-head">
        <h1>{t('Screener')}</h1>
        <p>{t('Screener lead')}</p>
      </header>

      <form className="sc-filters" onSubmit={(event) => event.preventDefault()}>
        <label className="sc-field">
          <span>{t('Quote')}</span>
          <select
            aria-label={t('Quote')}
            value={filters.quote ?? ''}
            onChange={(event) => setFilters((now) => ({ ...now, quote: event.target.value || null }))}
          >
            <option value="">{t('Any quote')}</option>
            {quotes.map((quote) => (
              <option key={quote} value={quote}>
                {quote}
              </option>
            ))}
          </select>
        </label>
        <label className="sc-field">
          <span>{t('Universe')}</span>
          <select
            aria-label={t('Universe')}
            value={filters.universe === 'list' ? `list:${filters.listId ?? ''}` : 'all'}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              const value = event.target.value;
              setFilters((now) => ({
                ...now,
                universe: value.startsWith('list:') ? 'list' : 'all',
                listId: value.startsWith('list:') ? value.slice(5) || null : null,
              }));
            }}
          >
            <option value="all">{t('All listed markets')}</option>
            {watchlists.value.map((list) => (
              <option key={list.id} value={`list:${list.id}`}>
                {t('One watchlist')}: {list.name}
              </option>
            ))}
          </select>
        </label>
        {BOUND_KEYS.map((key) => (
          <label key={key} className="sc-field">
            <span>{t(BOUND_LABEL[key])}</span>
            <input
              aria-label={t(BOUND_LABEL[key])}
              inputMode="decimal"
              value={filters[key] ?? ''}
              onChange={(event) => setBound(key, event.target.value)}
            />
          </label>
        ))}
        <label className="sc-field">
          <span>{t('Change timeframe')}</span>
          <select
            aria-label={t('Change timeframe')}
            value={timeframe}
            onChange={(event) => setTimeframe(event.target.value as ChangeTimeframe)}
          >
            {TIMEFRAME_IDS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      </form>
      {invalid && (
        <p className="sc-note" role="status">
          {t('Invalid bound')}
        </p>
      )}
      {listing.length >= SCREENER_MARKET_LIMIT && (
        <p className="sc-note" role="status">
          {t('Market list cut short', { count: SCREENER_MARKET_LIMIT })}
        </p>
      )}

      <fieldset className="sc-columns">
        <legend>{t('Columns')}</legend>
        {COLUMN_IDS.map((column) => (
          <label key={column}>
            <input
              type="checkbox"
              aria-label={t(COLUMN_KEY[column])}
              checked={columns.includes(column)}
              onChange={() => toggleColumn(column)}
            />
            {t(COLUMN_KEY[column])}
          </label>
        ))}
      </fieldset>

      <div className="sc-bar">
        <p role="status" className="sc-count">
          {empty
            ? markets.status === 'loading'
              ? t('Loading markets')
              : listing.length === 0
                ? t('Markets listed none')
                : emptyWords(t, reason, filters, timeframe)
            : t('Markets match', { count: result.rows.length })}
        </p>
        <div role="group" aria-label={t('Results view')} className="sc-views">
          <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
            {t('Table')}
          </button>
          <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')}>
            {t('Chart')}
          </button>
        </div>
        <button type="button" disabled={empty} onClick={exportRows}>
          {t('Export results')}
        </button>
      </div>

      {view === 'table' ? (
        <table className="sc-table" aria-label={t('Results view')} data-view="table">
          <thead>
            <tr>
              <th scope="col">{t('Market')}</th>
              {columns.map((column) => (
                <th key={column} scope="col">
                  {column === 'change' ? `${t(COLUMN_KEY[column])} ${changeLabel}` : t(COLUMN_KEY[column])}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => (
              <tr key={row.symbol} data-symbol={row.symbol}>
                <th scope="row">{row.symbol}</th>
                {columns.map((column) => (
                  <td key={column} data-column={column}>
                    <Cell row={row} column={column} timeframe={timeframe} t={t} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="sc-cards" aria-label={t('Results view')} data-view="chart">
          {result.rows.map((row) => (
            <li key={row.symbol} data-symbol={row.symbol} className="sc-card">
              <strong>{row.symbol}</strong>
              <span>{fmtPrice(row.last, row.tickSize)}</span>
              <span>{isServed(timeframe) ? (row.change === null ? t('no data') : fmtPct(row.change)) : t('not served')}</span>
              <Sparkline
                values={sparks.status === 'ready' ? (sparks.data[row.symbol] ?? []) : []}
                width={120}
                height={32}
                direction={row.change === null ? 'flat' : row.change.startsWith('-') ? 'down' : 'up'}
              />
            </li>
          ))}
        </ul>
      )}

      <section className="sc-saved" aria-label={t('Saved screens')}>
        <h2>{t('Saved screens')}</h2>
        {saved.status === 'signed-out' && <p className="sc-note">{t('Signed out saved')}</p>}
        {saved.status === 'ready' && saved.value.length === 0 && <p className="sc-note">{t('No saved screens')}</p>}
        <ul>
          {saved.value.map((screen) => (
            <li key={screen.id}>
              <button type="button" aria-label={t('Open {name}', { name: screen.name })} onClick={() => openScreen(screen)}>
                {screen.name}
              </button>
            </li>
          ))}
        </ul>
        <form
          className="sc-save"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <input aria-label={t('Screen name')} value={name} onChange={(event) => setName(event.target.value)} maxLength={60} />
          <button type="submit">{t('Save screen')}</button>
          {replacing && (
            <button type="button" onClick={() => void save()}>
              {t('Replace')}
            </button>
          )}
        </form>
        {replacing && <p className="sc-note">{t('Replace {name}?', { name: replacing })}</p>}
      </section>

      {notice && (
        <p role="status" className="sc-notice" data-tone={notice.tone}>
          {notice.text}
        </p>
      )}
    </section>
  );
}

const BOUND_LABEL: Record<BoundKey, 'Change above percent' | 'Change below percent' | 'Volume above' | 'Last above' | 'Last below'> = {
  changeMin: 'Change above percent',
  changeMax: 'Change below percent',
  volumeMin: 'Volume above',
  lastMin: 'Last above',
  lastMax: 'Last below',
};

const COLUMN_KEY: Record<ScreenColumn, 'Column Last' | 'Column Change' | 'Column Volume' | 'Column High' | 'Column Low'> = {
  last: 'Column Last',
  change: 'Column Change',
  volume: 'Column Volume',
  high: 'Column High',
  low: 'Column Low',
};

function Cell({
  row,
  column,
  timeframe,
  t,
}: {
  row: { last: string | null; change: string | null; volume: string | null; high: string | null; low: string | null; tickSize: string };
  column: ScreenColumn;
  timeframe: ChangeTimeframe;
  t: CopyT;
}) {
  if (column === 'change') {
    if (!isServed(timeframe)) return <span>{t('not served')}</span>;
    return <span>{row.change === null ? t('no data') : fmtPct(row.change)}</span>;
  }
  if (column === 'volume') return <span>{fmtAmount(row.volume)}</span>;
  if (column === 'last') return <span>{row.last === null ? t('no data') : fmtPrice(row.last, row.tickSize)}</span>;
  const value = column === 'high' ? row.high : row.low;
  return <span>{value === null ? t('no data') : fmtPrice(value, row.tickSize)}</span>;
}
