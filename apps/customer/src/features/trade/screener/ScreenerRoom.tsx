import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { ohlcvSchema } from '@intafaced/exchange-contract/schemas';
import type { SavedScreen } from '@intafaced/contracts/watchlists-preferences';
import { RecordListTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import { Sparkline } from '@intafaced/ui';
import { fmtAmount, fmtPct, fmtPrice, useMarkets, useSparklines, useTickers, type TickerRow } from '../../../data';
import { useSession } from '../../session/session';
import { useSavedScreens, useWatchlists } from '../../watchlists/store';
import { chartHrefFor } from '../../watchlists/links';
import {
  BLANK_FILTERS,
  DEFAULT_COLUMNS,
  SCREEN_COLUMNS,
  SCREEN_TIMEFRAMES,
  boundOf,
  findByName,
  isBadBound,
  isCandleTimeframe,
  listSymbols,
  orderedColumns,
  resultsCsv,
  resultsFileName,
  screen,
  screenId,
  timeframeChange,
  withScreen,
  type CandleRow,
  type FilterStep,
  type Row,
  type ScreenColumn,
  type ScreenFilters,
  type ScreenTimeframe,
} from './model';
import { screenerCopy } from './screener-copy';

/**
 * The screener, /trade/screener (C-alerts-scan-07; J-charts-desk-12), on the record-list template. It screens the listed spot
 * markets and their tickers in the client: quote, 24 h change, 24 h volume and a last price range, over every market or one
 * of the person's watchlists. Columns and the change column's timeframe are the person's pick; a 1 h, 4 h or 1 d change is
 * read from the candle route. A screen is kept on the account (`trade.screens`) under the owner's cap; a blank cap refuses
 * the save. A view only: nothing here places an order or changes a market.
 */

type BoundKey = 'changeMin' | 'changeMax' | 'volumeMin' | 'lastMin' | 'lastMax';
const BOUNDS: readonly BoundKey[] = ['changeMin', 'changeMax', 'volumeMin', 'lastMin', 'lastMax'];
type Draft = Record<BoundKey, string> & { quote: string; over: string };
const BLANK_DRAFT: Draft = { quote: '', changeMin: '', changeMax: '', volumeMin: '', lastMin: '', lastMax: '', over: 'all' };

const draftOf = (filters: ScreenFilters): Draft => ({
  quote: filters.quote ?? '',
  changeMin: filters.changeMin ?? '',
  changeMax: filters.changeMax ?? '',
  volumeMin: filters.volumeMin ?? '',
  lastMin: filters.lastMin ?? '',
  lastMax: filters.lastMax ?? '',
  over: filters.universe === 'list' && filters.listId ? `list:${filters.listId}` : 'all',
});

const filtersOf = (draft: Draft): ScreenFilters => {
  const listId = draft.over.startsWith('list:') ? draft.over.slice(5) : null;
  return {
    quote: draft.quote === '' ? null : draft.quote,
    changeMin: boundOf(draft.changeMin),
    changeMax: boundOf(draft.changeMax),
    volumeMin: boundOf(draft.volumeMin),
    lastMin: boundOf(draft.lastMin),
    lastMax: boundOf(draft.lastMax),
    universe: listId ? 'list' : 'all',
    listId,
  };
};

type Cell = { state: 'value'; ratio: string } | { state: 'no-history' } | { state: 'not-served' } | { state: 'loading' };
const candlesSchema = z.array(ohlcvSchema);
/** How often a 1 h, 4 h or 1 d change is read again. */
const CANDLE_REFRESH_MS = 60_000;

/** The change over a candle timeframe for each symbol, read again every minute. 24 h needs no read: the ticker has it. */
function useTimeframeChanges(symbols: readonly string[], tf: ScreenTimeframe, tickers: Readonly<Record<string, TickerRow>> | undefined) {
  const { api } = useSession();
  const key = symbols.join(',');
  /** Reads by `<timeframe>:<symbol>`, so a refresh keeps the last read on screen until the next one lands. */
  const [candles, setCandles] = useState<Record<string, readonly CandleRow[] | 'not-served'>>({});
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!isCandleTimeframe(tf) || key === '') return;
    const controller = new AbortController();
    void Promise.all(
      key.split(',').map(async (symbol) => {
        const result = await api.rest(`/ohlcv/${encodeURIComponent(symbol)}`, candlesSchema, {
          query: { timeframe: tf, limit: 2 },
          signal: controller.signal,
        });
        return [`${tf}:${symbol}`, result.ok ? (result.data satisfies readonly CandleRow[]) : ('not-served' as const)] as const;
      }),
    ).then((pairs) => {
      if (!controller.signal.aborted) setCandles((before) => ({ ...before, ...Object.fromEntries(pairs) }));
    });
    const timer = setTimeout(() => setRevision((value) => value + 1), CANDLE_REFRESH_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, key, tf, revision]);

  return (symbol: string): Cell => {
    const ticker = tickers?.[symbol];
    if (!isCandleTimeframe(tf)) return ticker?.changePct24h ? { state: 'value', ratio: ticker.changePct24h } : { state: 'no-history' };
    const read = candles[`${tf}:${symbol}`];
    if (read === undefined) return { state: 'loading' };
    if (read === 'not-served') return { state: 'not-served' };
    const ratio = timeframeChange(read, ticker?.last, tf, Date.now());
    return ratio === null ? { state: 'no-history' } : { state: 'value', ratio };
  };
}

type RefusalWords = 'capUnset' | 'capExceeded' | 'versionConflict' | 'notSaved';
function refusalWords(code: string): RefusalWords {
  if (code === 'identity.saved_screen_cap_unset') return 'capUnset';
  if (code === 'identity.saved_screen_cap_exceeded') return 'capExceeded';
  if (code === 'preferences.version_conflict') return 'versionConflict';
  return 'notSaved';
}

export function ScreenerRoom() {
  const { t } = screenerCopy.useCopy();
  const { userId } = useSession();
  const markets = useMarkets();
  const tickers = useTickers({ intervalMs: 5000 });
  const lists = useWatchlists();
  const screens = useSavedScreens();

  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT);
  const [applied, setApplied] = useState<ScreenFilters>(BLANK_FILTERS);
  const [bad, setBad] = useState<string | null>(null);
  const [columns, setColumns] = useState<ScreenColumn[]>([...DEFAULT_COLUMNS]);
  const [tf, setTf] = useState<ScreenTimeframe>('24h');
  const [view, setView] = useState<'table' | 'chart'>('table');
  const [openId, setOpenId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [replacing, setReplacing] = useState<SavedScreen | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const marketRows = useMemo(() => (markets.status === 'ready' ? markets.data : []), [markets]);
  const tickerMap = tickers.status === 'ready' ? tickers.data : undefined;
  const quotes = useMemo(() => [...new Set(marketRows.map((market) => market.quote))].sort(), [marketRows]);
  const universe = useMemo(
    () => (applied.universe === 'list' ? listSymbols(lists.value, applied.listId) : null),
    [applied.universe, applied.listId, lists.value],
  );
  const listGone = applied.universe === 'list' && universe === null;
  const screened = useMemo(
    () => screen(marketRows, tickerMap, applied, listGone ? [] : universe),
    [marketRows, tickerMap, applied, universe, listGone],
  );
  const symbols = screened.rows.map((row) => row.market.symbol);
  const changeOf = useTimeframeChanges(symbols, tf, tickerMap);
  const sparks = useSparklines(view === 'chart' ? symbols : []);
  const shown = orderedColumns(columns);
  const openScreen = screens.value.find((item) => item.id === openId) ?? null;
  const signedIn = userId != null;

  const listsRead = !signedIn || lists.status === 'ready' || lists.status === 'error';
  const screensRead = !signedIn || screens.status === 'ready' || screens.status === 'error';
  const status =
    markets.status === 'error' || markets.status === 'refused'
      ? 'error'
      : markets.status === 'loading' || tickers.status === 'loading' || !listsRead || !screensRead
        ? 'loading'
        : 'ready';

  const onApply = (event: FormEvent) => {
    event.preventDefault();
    const label: Record<BoundKey, string> = {
      changeMin: t('changeMin'),
      changeMax: t('changeMax'),
      volumeMin: t('volumeMin'),
      lastMin: t('lastMin'),
      lastMax: t('lastMax'),
    };
    const wrong = BOUNDS.find((key) => isBadBound(draft[key]));
    if (wrong) {
      setBad(t('badBound', { label: label[wrong], value: draft[wrong] }));
      return;
    }
    setBad(null);
    setApplied(filtersOf(draft));
  };

  const open = (id: string) => {
    const saved = screens.value.find((item) => item.id === id);
    setNotice(null);
    setReplacing(null);
    if (!saved) {
      setOpenId(null);
      return;
    }
    setOpenId(saved.id);
    setName(saved.name);
    setDraft(draftOf(saved.filters));
    setApplied(saved.filters);
    setColumns(orderedColumns(saved.columns));
    setTf(saved.changeTimeframe);
  };

  const store = async (record: SavedScreen, done: 'savedDone' | 'updatedDone') => {
    const outcome = await screens.commit((current) => withScreen(current ?? [], record));
    if (outcome.ok) {
      setOpenId(record.id);
      setNotice(t(done, { name: record.name }));
    } else setNotice(t(refusalWords(outcome.code)));
  };

  const current = (id: string, screenName: string): SavedScreen => ({
    id,
    name: screenName.trim(),
    filters: applied,
    columns: orderedColumns(columns),
    changeTimeframe: tf,
  });

  const onSave = () => {
    setNotice(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setNotice(t('nameNeeded'));
      return;
    }
    const existing = findByName(screens.value, trimmed);
    if (existing) {
      setReplacing(existing);
      return;
    }
    void store(current(screenId(trimmed), trimmed), 'savedDone');
  };

  const onExport = () => {
    const csv = resultsCsv(screened.rows, columns, tf, (row) => {
      const cell = changeOf(row.market.symbol);
      return cell.state === 'value' ? cell.ratio : null;
    });
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = resultsFileName(openScreen?.name ?? null);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  /** One filter as the person reads it: "Change 24h above 5%", or "Change 24h above not set" for a blank bound. */
  const named = (step: Exclude<FilterStep, 'universe'>): string => {
    const value = applied[step];
    if (value === null) return t('appliedNotSet', { label: t(`label_${step}`) });
    return t(`applied_${step}`, { value });
  };
  const stepWords = (step: FilterStep): string => (step === 'universe' ? t('removedByList') : t('removedBy', { filter: named(step) }));

  const state: RoomState =
    status === 'loading'
      ? { kind: 'loading' }
      : markets.status === 'error' || markets.status === 'refused'
        ? {
            kind: 'refused',
            refusal: {
              variant: 'unreachable',
              title: t('marketsFailedTitle'),
              body: t('marketsFailedBody'),
              reference: markets.status === 'refused' ? markets.code : undefined,
            },
          }
        : markets.status === 'empty'
          ? { kind: 'empty', title: t('noMarketsTitle'), body: t('noMarketsBody') }
          : screened.rows.length === 0
            ? { kind: 'empty', title: t('emptyTitle'), body: listGone ? t('listGone') : stepWords(screened.removedBy ?? 'universe') }
            : { kind: 'ready' };

  const listName = (id: string | null) => lists.value.find((item) => item.id === id)?.name ?? id ?? '';
  const appliedLine = [
    openScreen ? t('appliedScreen', { name: openScreen.name }) : null,
    applied.universe === 'list' ? t('appliedOverList', { name: listName(applied.listId) }) : t('appliedOverAll'),
    ...(['quote', ...BOUNDS] as const).map(named),
  ]
    .filter(Boolean)
    .join(' · ');

  const field = (key: BoundKey) => (
    <label key={key}>
      <span>{t(key)}</span>
      <input type="text" inputMode="decimal" value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
    </label>
  );

  const filtersSlot = (
    <form aria-label={t('filters')} onSubmit={onApply}>
      <label>
        <span>{t('over')}</span>
        <select value={draft.over} onChange={(event) => setDraft({ ...draft, over: event.target.value })}>
          <option value="all">{t('overAll')}</option>
          {lists.value.map((list) => (
            <option key={list.id} value={`list:${list.id}`}>
              {t('overList', { name: list.name })}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t('quote')}</span>
        <select value={draft.quote} onChange={(event) => setDraft({ ...draft, quote: event.target.value })}>
          <option value="">{t('anyQuote')}</option>
          {quotes.map((quote) => (
            <option key={quote} value={quote}>
              {quote}
            </option>
          ))}
        </select>
      </label>
      {BOUNDS.map(field)}
      <button type="submit">{t('apply')}</button>
      {bad ? <p role="alert">{bad}</p> : null}
      <p data-testid="screener-applied">{appliedLine}</p>
      {!signedIn ? <p>{t('signInToSave')}</p> : null}
    </form>
  );

  const toolsSlot = (
    <div>
      <fieldset role="group" aria-label={t('columns')}>
        <legend>{t('columns')}</legend>
        {SCREEN_COLUMNS.map((column) => (
          <label key={column}>
            <input
              type="checkbox"
              checked={columns.includes(column)}
              onChange={(event) =>
                setColumns(event.target.checked ? orderedColumns([...columns, column]) : columns.filter((item) => item !== column))
              }
            />
            {column === 'change' ? t('col_change', { tf: t(`tfShort_${tf}`) }) : t(`col_${column}`)}
          </label>
        ))}
      </fieldset>
      <label>
        <span>{t('timeframe')}</span>
        <select value={tf} onChange={(event) => setTf(event.target.value as ScreenTimeframe)}>
          {SCREEN_TIMEFRAMES.map((item) => (
            <option key={item} value={item}>
              {t(`tf_${item}`)}
            </option>
          ))}
        </select>
      </label>
      <p>{t('timeframeNote')}</p>
      <div role="group" aria-label={t('view')}>
        <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
          {t('viewTable')}
        </button>
        <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')}>
          {t('viewChart')}
        </button>
      </div>
      {signedIn ? (
        <div>
          <label>
            <span>{t('saved')}</span>
            <select value={openId ?? ''} onChange={(event) => open(event.target.value)} disabled={screens.status !== 'ready'}>
              <option value="">{screens.value.length === 0 ? t('savedNone') : t('savedPick')}</option>
              {screens.value.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {screens.status === 'error' ? (
            <p role="alert">
              {t('savedLoadFailed')}{' '}
              <button type="button" onClick={screens.reload}>
                {t('retry')}
              </button>
            </p>
          ) : null}
          <label>
            <span>{t('screenName')}</span>
            <input type="text" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
          </label>
          <button type="button" onClick={onSave} disabled={screens.status !== 'ready' || screens.busy}>
            {t('save')}
          </button>
          {openScreen ? (
            <button
              type="button"
              onClick={() => void store(current(openScreen.id, openScreen.name), 'updatedDone')}
              disabled={screens.status !== 'ready' || screens.busy}
            >
              {t('update', { name: openScreen.name })}
            </button>
          ) : null}
          {replacing ? (
            <div role="alertdialog" aria-label={t('replaceAsk', { name: replacing.name })}>
              <p>{t('replaceAsk', { name: replacing.name })}</p>
              <button
                type="button"
                onClick={() => {
                  const target = replacing;
                  setReplacing(null);
                  void store(current(target.id, target.name), 'savedDone');
                }}
              >
                {t('replace')}
              </button>
              <button type="button" onClick={() => setReplacing(null)}>
                {t('keep')}
              </button>
            </div>
          ) : null}
          {notice ? <p role="status">{notice}</p> : null}
        </div>
      ) : null}
    </div>
  );

  const changeCell = (row: Row) => {
    const cell = changeOf(row.market.symbol);
    const text =
      cell.state === 'value'
        ? fmtPct(cell.ratio)
        : cell.state === 'loading'
          ? t('loadingCell')
          : cell.state === 'not-served'
            ? t('notServed')
            : t('noHistory');
    return (
      <td key="change" data-column="change" data-state={cell.state}>
        {text}
      </td>
    );
  };

  const valueCell = (row: Row, column: Exclude<ScreenColumn, 'change'>) => {
    const ticker = row.ticker;
    const value = { last: ticker?.last, volume: ticker?.baseVolume24h, high: ticker?.high24h, low: ticker?.low24h }[column] ?? null;
    const text = value === null ? t('noHistory') : column === 'volume' ? fmtAmount(value) : fmtPrice(value, row.market.tickSize);
    return (
      <td key={column} data-column={column}>
        {text}
      </td>
    );
  };

  const table = (
    <table aria-label={t('results')}>
      <thead>
        <tr>
          <th scope="col">{t('col_symbol')}</th>
          {shown.map((column) => (
            <th key={column} scope="col">
              {column === 'change' ? t('col_change', { tf: t(`tfShort_${tf}`) }) : t(`col_${column}`)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {screened.rows.map((row) => (
          <tr key={row.market.symbol} data-symbol={row.market.symbol}>
            <th scope="row">
              <a href={chartHrefFor(row.market.symbol)}>{row.market.symbol}</a>
            </th>
            {shown.map((column) => (column === 'change' ? changeCell(row) : valueCell(row, column)))}
          </tr>
        ))}
      </tbody>
    </table>
  );

  const sparkData = sparks.status === 'ready' ? sparks.data : {};
  const grid = (
    <ul aria-label={t('charts')}>
      {screened.rows.map((row) => {
        const points = sparkData[row.market.symbol] ?? [];
        const cell = changeOf(row.market.symbol);
        return (
          <li key={row.market.symbol} data-symbol={row.market.symbol}>
            <h3>
              <a href={chartHrefFor(row.market.symbol)}>{row.market.symbol}</a>
            </h3>
            {points.length > 1 ? (
              <div data-chart="drawn">
                <Sparkline values={points} label={t('chartLabel', { symbol: row.market.symbol })} />
              </div>
            ) : (
              <p data-chart={sparks.status === 'loading' ? 'loading' : 'no-history'}>{t('chartNone')}</p>
            )}
            <p>
              {fmtPrice(row.ticker?.last ?? null, row.market.tickSize)} · {cell.state === 'value' ? fmtPct(cell.ratio) : t('noHistory')}
            </p>
          </li>
        );
      })}
    </ul>
  );

  const total = screened.rows.length;
  return (
    <div data-testid="screener-room" data-status={status}>
      <RecordListTemplate
        title={t('title')}
        description={t('description')}
        mode="pro"
        state={state}
        filters={filtersSlot}
        tools={toolsSlot}
        export={
          <button type="button" onClick={onExport}>
            {t('exportCsv')}
          </button>
        }
        summary={
          <div>
            <p data-testid="screener-count">{t(total === 1 ? 'count_one' : 'count_other', { count: String(total) })}</p>
            {tickers.status === 'error' || tickers.status === 'refused' ? <p role="alert">{t('pricesFailed')}</p> : null}
          </div>
        }
        list={view === 'table' ? table : grid}
      />
    </div>
  );
}
