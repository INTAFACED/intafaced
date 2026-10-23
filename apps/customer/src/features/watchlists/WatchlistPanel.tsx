import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { WatchlistsValue } from '@intafaced/contracts/watchlists-preferences';
import { Dialog, DialogContent, DialogTitle } from '@intafaced/ui';
import { fmtAmount, fmtPct, fmtPrice, useMarkets, useTickers, type MarketRow, type TickerRow } from '../../data';
import { compareDecimal } from '../../data/decimal';
import { navigate } from '../../app/location';
import { useSession } from '../session/session';
import { watchlistsCopy } from './copy';
import { chartHrefFor, WATCHLIST_DRAG_TYPE } from './links';
import {
  addSection,
  addSymbol,
  createList,
  defaultSectionOf,
  hasSymbol,
  listedSymbol,
  nextSort,
  quoteState,
  removeSymbol,
  rowsOf,
  searchMarkets,
  setFlag,
  setSectionCollapsed,
  sortRows,
  WATCHLIST_COLUMNS,
  WATCHLIST_FLAG_IDS,
  type SortState,
  type WatchlistFlag,
  type WatchlistColumn,
  type WatchRow,
} from './model';
import { exportFileName, exportListCsv, importSummary, IMPORT_MAX_BYTES, readImportCsv } from './csv';
import { MAX_WIDTH, MIN_WIDTH, readWatchlistView, writeWatchlistView, type WatchlistView } from './view';
import { useWatchlists } from './store';
import './watchlists.css';

const COLUMN_LABEL: Record<WatchlistColumn, 'Market' | 'Last' | 'Change 24h' | 'High 24h' | 'Low 24h' | 'Volume 24h'> = {
  symbol: 'Market',
  last: 'Last',
  change: 'Change 24h',
  high: 'High 24h',
  low: 'Low 24h',
  volume: 'Volume 24h',
};

/** The reason a refused write carries, as the words a person reads. */
type RefusalKey = 'Cap unset symbols' | 'Cap unset lists' | 'Cap exceeded' | 'Version conflict' | 'Not saved';
function refusalWords(code: string): RefusalKey {
  if (code === 'identity.watchlist_symbol_cap_unset') return 'Cap unset symbols';
  if (code === 'identity.watchlist_list_cap_unset') return 'Cap unset lists';
  if (code === 'identity.watchlist_cap_exceeded') return 'Cap exceeded';
  if (code === 'preferences.version_conflict') return 'Version conflict';
  return 'Not saved';
}

const FLAG_KEY: Record<WatchlistFlag, 'Flag red' | 'Flag amber' | 'Flag green' | 'Flag blue'> = {
  red: 'Flag red',
  amber: 'Flag amber',
  green: 'Flag green',
  blue: 'Flag blue',
};
const REASON_KEY: Record<'unknown symbol' | 'not a symbol', 'reason unknown symbol' | 'reason not a symbol'> = {
  'unknown symbol': 'reason unknown symbol',
  'not a symbol': 'reason not a symbol',
};

interface Notice {
  tone: 'ok' | 'warn';
  text: string;
}

/** Quote cells read the live ticker; a tick that moved is coloured for a moment (up or down). */
function useTicks(tickers: Readonly<Record<string, TickerRow>> | undefined): Record<string, 'up' | 'down'> {
  const [ticks, setTicks] = useState<Record<string, 'up' | 'down'>>({});
  const seen = useRef<Record<string, string>>({});
  const timers = useRef<number[]>([]);
  useEffect(() => {
    if (!tickers) return;
    const moved: Record<string, 'up' | 'down'> = {};
    for (const [symbol, ticker] of Object.entries(tickers)) {
      const last = ticker.last;
      if (last === null) continue;
      const before = seen.current[symbol];
      if (before !== undefined) {
        const order = compareDecimal(last, before);
        if (order !== null && order !== 0) moved[symbol] = order > 0 ? 'up' : 'down';
      }
      seen.current[symbol] = last;
    }
    if (Object.keys(moved).length === 0) return;
    setTicks((now) => ({ ...now, ...moved }));
    const timer = window.setTimeout(() => {
      setTicks((now) => {
        const next = { ...now };
        for (const symbol of Object.keys(moved)) if (next[symbol] === moved[symbol]) delete next[symbol];
        return next;
      });
    }, 1500);
    timers.current.push(timer);
  }, [tickers]);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
    };
  }, []);
  return ticks;
}

function Quote({ row, column, tickSize }: { row: WatchRow; column: Exclude<WatchlistColumn, 'symbol'>; tickSize: string | null }) {
  const { t } = watchlistsCopy.useCopy();
  const ticker = row.ticker;
  if (quoteState(ticker) === 'no-data') return <span className="wl-nodata">{t('no data')}</span>;
  if (column === 'change') return <span>{fmtPct(ticker?.changePct24h)}</span>;
  if (column === 'volume') return <span>{fmtAmount(ticker?.baseVolume24h)}</span>;
  const value = column === 'last' ? ticker?.last : column === 'high' ? ticker?.high24h : ticker?.low24h;
  return <span>{fmtPrice(value, tickSize)}</span>;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="wl-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** The symbol's statistics and market rules. A stat the service does not serve reads 'not served', never zero. */
function Details({ row, onClose }: { row: WatchRow; onClose: () => void }) {
  const { t } = watchlistsCopy.useCopy();
  const { ticker, market } = row;
  const or = (value: string | null | undefined) => value ?? t('not served');
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle>{t('Details title', { symbol: row.symbol })}</DialogTitle>
        <h3 className="wl-sub">{t('Statistics')}</h3>
        <dl className="wl-stats" aria-label={t('Statistics')}>
          <DetailRow label={t('Stat last')} value={or(ticker?.last)} />
          <DetailRow label={t('Stat bid')} value={or(ticker?.bid)} />
          <DetailRow label={t('Stat ask')} value={or(ticker?.ask)} />
          <DetailRow label={t('Stat open')} value={or(ticker?.open24h)} />
          <DetailRow label={t('Stat high')} value={or(ticker?.high24h)} />
          <DetailRow label={t('Stat low')} value={or(ticker?.low24h)} />
          <DetailRow label={t('Stat change')} value={ticker?.changePct24h ? fmtPct(ticker.changePct24h) : t('not served')} />
          <DetailRow label={t('Stat base volume')} value={or(ticker?.baseVolume24h)} />
          <DetailRow label={t('Stat quote volume')} value={or(ticker?.quoteVolume24h)} />
          <DetailRow label={t('Stat open interest')} value={t('Not served on spot')} />
        </dl>
        <h3 className="wl-sub">{t('Market rules')}</h3>
        <dl className="wl-stats" aria-label={t('Market rules')}>
          <DetailRow label={t('Rule price step')} value={market?.tickSize ?? t('not served')} />
          <DetailRow label={t('Rule amount step')} value={market?.lotSize ?? t('not served')} />
          <DetailRow label={t('Rule minimum amount')} value={market?.minAmount ?? t('not served')} />
          <DetailRow
            label={t('Rule trading')}
            value={market ? (market.orderable ? t('Trading open') : t('Trading closed')) : t('not served')}
          />
        </dl>
      </DialogContent>
    </Dialog>
  );
}

export interface WatchlistPanelProps {
  /** The chart workbench the rows open into (`?w=`), so a row click keeps that workbench's interval. */
  workbench: string;
}

/**
 * Watchlists beside the chart: named lists kept on the account (every device sees them), with sections, a sort and column
 * widths kept on this device, live quotes, and CSV in and out. A click or a drag of a row opens its chart.
 */
export function WatchlistPanel({ workbench }: WatchlistPanelProps) {
  const { t } = watchlistsCopy.useCopy();
  const { userId } = useSession();
  const store = useWatchlists();
  const markets = useMarkets({ includeClosed: true });
  const tickers = useTickers({ intervalMs: 5000 });
  const listing: MarketRow[] = markets.status === 'ready' ? markets.data : [];
  const tickerMap = tickers.status === 'ready' ? tickers.data : undefined;
  const ticks = useTicks(tickerMap);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<WatchlistView>(() => readWatchlistView(userId));
  const [query, setQuery] = useState('');
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [details, setDetails] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const list = store.value.find((item) => item.id === selectedId) ?? store.value[0] ?? null;
  const section = list ? (list.sections.find((item) => item.id === sectionId) ?? defaultSectionOf(list)) : null;
  const matches = useMemo(() => searchMarkets(listing, query), [listing, query]);
  const onList = useMemo(() => new Set(list ? list.sections.flatMap((item) => item.symbols) : []), [list]);

  const changeView = (next: WatchlistView, persist = true) => {
    setView(next);
    if (persist) writeWatchlistView(userId, next);
  };

  /** Commits a whole new set of lists; a refusal says why nothing changed. */
  const save = async (next: WatchlistsValue, success?: string): Promise<boolean> => {
    const result = await store.commit(next);
    if (result.ok) {
      if (success) setNotice({ tone: 'ok', text: success });
      return true;
    }
    setNotice({ tone: 'warn', text: t(refusalWords(result.code)) });
    return false;
  };

  /** The list an add goes to: the selected one, or a new "Watchlist" when the person has none yet. */
  const listsWithTarget = (base: WatchlistsValue): { lists: WatchlistsValue; listId: string; sectionId: string } | null => {
    if (list) return { lists: base, listId: list.id, sectionId: section?.id ?? defaultSectionOf(list).id };
    const created = createList(base, t('Watchlist name'));
    const made = created[created.length - 1]!;
    return { lists: created, listId: made.id, sectionId: made.sections[0]!.id };
  };

  const addMarket = async (market: MarketRow) => {
    if (!userId) return;
    if (list && hasSymbol(list, market.symbol)) {
      setNotice({ tone: 'warn', text: t('Already listed', { symbol: market.symbol }) });
      return;
    }
    const target = listsWithTarget(store.value);
    if (!target) return;
    const next = addSymbol(target.lists, target.listId, target.sectionId, market.symbol);
    const name = next.find((item) => item.id === target.listId)?.name ?? '';
    if (await save(next, t('Added to list', { symbol: market.symbol, list: name }))) {
      setSelectedId(target.listId);
      setQuery('');
    }
  };

  const removeMarket = async (symbol: string) => {
    if (!list) return;
    if (await save(removeSymbol(store.value, list.id, symbol), t('Removed from list', { symbol }))) setDetails(null);
  };

  const createNamed = async () => {
    const name = (newName ?? '').trim();
    if (!name) {
      setNotice({ tone: 'warn', text: t('Name needed') });
      return;
    }
    const next = createList(store.value, name);
    const made = next[next.length - 1]!;
    if (await save(next, t('List created', { name }))) {
      setSelectedId(made.id);
      setNewName(null);
    }
  };

  const createSection = async () => {
    const title = newTitle.trim();
    if (!list || !title) {
      setNotice({ tone: 'warn', text: t('Section needs a name') });
      return;
    }
    if (await save(addSection(store.value, list.id, title), t('Section added', { title }))) setNewTitle('');
  };

  const toggleSection = (id: string, collapsed: boolean) => {
    if (list) void save(setSectionCollapsed(store.value, list.id, id, collapsed));
  };

  const chooseFlag = (value: string) => {
    if (!list) return;
    const flag = (WATCHLIST_FLAG_IDS as readonly string[]).includes(value) ? (value as (typeof WATCHLIST_FLAG_IDS)[number]) : null;
    void save(setFlag(store.value, list.id, flag));
  };

  const exportCsv = () => {
    if (!list) return;
    const blob = new Blob([exportListCsv(list, tickerMap)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    const file = exportFileName(list.name);
    anchor.download = file;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice({ tone: 'ok', text: t('Export ready', { file }) });
  };

  const importCsv = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !userId) return;
    if (file.size > IMPORT_MAX_BYTES) {
      setNotice({ tone: 'warn', text: t('Import too large') });
      return;
    }
    const text = await file.text();
    const result = readImportCsv(text, listing, onList);
    if (result.tooMany) {
      setNotice({ tone: 'warn', text: t('Import too many rows') });
      return;
    }
    if (result.accepted.length === 0) {
      const lines = result.refused.map((row) =>
        t('Import refused row', { line: row.line, value: row.value, reason: t(REASON_KEY[row.reason]) }),
      );
      setNotice({ tone: 'warn', text: result.refused.length ? `${importSummary(result)}. ${lines.join(' ')}` : t('Import nothing') });
      return;
    }
    const target = listsWithTarget(store.value);
    if (!target) return;
    let next = target.lists;
    for (const symbol of result.accepted) next = addSymbol(next, target.listId, target.sectionId, symbol);
    const refusedLines = result.refused.map((row) =>
      t('Import refused row', { line: row.line, value: row.value, reason: t(REASON_KEY[row.reason]) }),
    );
    if (await save(next)) {
      setSelectedId(target.listId);
      setNotice({ tone: 'ok', text: [t('Import result', { summary: importSummary(result) }), ...refusedLines].join(' ') });
    }
  };

  // The separator also takes the arrow keys: 8 pixels a press, kept on this device.
  const nudgeResize = (event: ReactKeyboardEvent<HTMLSpanElement>, column: WatchlistColumn) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const th = event.currentTarget.parentElement as HTMLElement;
    const current = view.widths[column] ?? Math.round(th.getBoundingClientRect().width);
    const delta = event.key === 'ArrowRight' ? 8 : -8;
    const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, current + delta));
    const next = { ...view, widths: { ...view.widths, [column]: width } };
    setView(next);
    writeWatchlistView(userId, next);
  };

  // Column widths follow the pointer while a separator is dragged, and are kept on this device when it lets go.
  const startResize = (event: ReactPointerEvent<HTMLSpanElement>, column: WatchlistColumn) => {
    event.preventDefault();
    const th = event.currentTarget.parentElement as HTMLElement;
    const startX = event.clientX;
    const startWidth = th.getBoundingClientRect().width;
    let latest = view;
    const move = (e: PointerEvent) => {
      const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(startWidth + e.clientX - startX)));
      latest = { ...latest, widths: { ...latest.widths, [column]: width } };
      setView(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      writeWatchlistView(userId, latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const sortBy = (column: WatchlistColumn) => changeView({ ...view, sort: nextSort(view.sort, column) });
  const sort: SortState | null = view.sort;

  const onRowDragStart = (event: DragEvent<HTMLTableRowElement>, symbol: string) => {
    event.dataTransfer.setData(WATCHLIST_DRAG_TYPE, symbol);
    event.dataTransfer.setData('text/plain', symbol);
    event.dataTransfer.effectAllowed = 'copy';
  };

  const openRow = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    navigate(href);
  };

  const detailRow = details && list ? findRow(list, details, listing, tickerMap) : null;
  const signedOut = store.status === 'signed-out';
  // Nothing that changes the lists is offered while a save is on its way, or before the lists have been read.
  const locked = store.busy || store.status !== 'ready';

  return (
    <section className="wl" aria-label={t('Watchlists')} data-status={store.status} data-workbench={workbench}>
      <header className="wl-head">
        <h2>{t('Watchlists')}</h2>
        <div className="wl-head-actions">
          {store.value.length > 0 && (
            <label className="wl-field">
              <span>{t('List')}</span>
              <select aria-label={t('List')} value={list?.id ?? ''} onChange={(event) => setSelectedId(event.target.value)}>
                {store.value.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {list && (
            <label className="wl-field">
              <span>{t('Flag')}</span>
              <select aria-label={t('Flag')} value={list.flag ?? ''} disabled={locked} onChange={(event) => chooseFlag(event.target.value)}>
                <option value="">{t('No flag')}</option>
                {WATCHLIST_FLAG_IDS.map((flag) => (
                  <option key={flag} value={flag}>
                    {t(FLAG_KEY[flag])}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="wl-btn" disabled={locked} onClick={() => setNewName(newName === null ? '' : null)}>
            {t('New list')}
          </button>
          <button type="button" className="wl-btn" disabled={!list} onClick={exportCsv}>
            {t('Export CSV')}
          </button>
          <label className="wl-btn" aria-disabled={signedOut || undefined}>
            {t('Import CSV')}
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              aria-label={t('Import CSV file')}
              className="wl-file"
              disabled={locked}
              onChange={(event) => void importCsv(event)}
            />
          </label>
        </div>
      </header>

      {signedOut && <p className="wl-note">{t('Signed out')}</p>}
      {newName !== null && (
        <form
          className="wl-inline"
          onSubmit={(event) => {
            event.preventDefault();
            void createNamed();
          }}
        >
          <input aria-label={t('New list name')} value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={40} />
          <button type="submit" className="wl-btn" disabled={locked}>
            {t('Create list')}
          </button>
        </form>
      )}

      {store.status === 'error' && (
        <p role="alert" className="wl-note">
          {t('Could not read your lists')}{' '}
          <button type="button" className="wl-btn" onClick={store.reload}>
            {t('Try again')}
          </button>
        </p>
      )}
      {!signedOut && store.status !== 'error' && (
        <div className="wl-add">
          <label className="wl-field wl-search">
            <span>{t('Add a market')}</span>
            <input
              type="search"
              disabled={locked}
              aria-label={t('Add a market')}
              placeholder={t('Search markets')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {list && list.sections.length > 1 && (
            <label className="wl-field">
              <span>{t('Section to add to')}</span>
              <select aria-label={t('Section to add to')} value={section?.id ?? ''} onChange={(event) => setSectionId(event.target.value)}>
                {list.sections.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {query.trim() !== '' && (
            <ul className="wl-results" aria-label={t('Matching markets')}>
              {matches.map((market) => (
                <li key={market.symbol}>
                  <button
                    type="button"
                    className="wl-btn"
                    aria-label={t('Add to list', { symbol: market.symbol })}
                    disabled={locked}
                    onClick={() => void addMarket(market)}
                  >
                    {market.symbol}
                  </button>
                </li>
              ))}
              {matches.length === 0 && <li className="wl-note">{t('No match', { query: query.trim() })}</li>}
            </ul>
          )}
        </div>
      )}

      {notice && (
        <p role="status" className="wl-notice" data-tone={notice.tone}>
          {notice.text}
        </p>
      )}

      {list && store.status !== 'error' && (
        <div className="wl-body">
          <table className="wl-table" aria-label={t('Watchlist rows')} data-sorted={sort ? `${sort.column}:${sort.direction}` : ''}>
            <colgroup>
              {WATCHLIST_COLUMNS.map((column) => (
                <col key={column} style={view.widths[column] ? { width: view.widths[column] } : undefined} />
              ))}
              <col className="wl-col-actions" />
            </colgroup>
            <thead>
              <tr>
                {WATCHLIST_COLUMNS.map((column) => {
                  const active = sort?.column === column ? sort.direction : null;
                  const label = t(COLUMN_LABEL[column]);
                  return (
                    <th key={column} scope="col" aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : undefined}>
                      <button
                        type="button"
                        className="wl-sort"
                        aria-label={t('Sort by {column}', { column: label })}
                        onClick={() => sortBy(column)}
                      >
                        {label}
                        {active && <span aria-hidden="true">{active === 'asc' ? ' ▲' : ' ▼'}</span>}
                      </button>
                      <span
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={t('Resize {column} column', { column: label })}
                        className="wl-grip"
                        tabIndex={0}
                        onKeyDown={(event) => nudgeResize(event, column)}
                        onPointerDown={(event) => startResize(event, column)}
                      />
                    </th>
                  );
                })}
                <th scope="col">
                  <span className="wl-sr">{t('Remove')}</span>
                </th>
              </tr>
            </thead>
            {list.sections.map((item) => {
              const rows = sortRows(rowsOf(item, listing, tickerMap), sort);
              return (
                <tbody key={item.id} data-section={item.id}>
                  <tr className="wl-section">
                    <th colSpan={WATCHLIST_COLUMNS.length + 1} scope="rowgroup">
                      <button
                        type="button"
                        className="wl-collapse"
                        aria-expanded={!item.collapsed}
                        aria-label={
                          item.collapsed
                            ? t('Expand section {title}', { title: item.title })
                            : t('Minimise section {title}', { title: item.title })
                        }
                        disabled={locked}
                        onClick={() => toggleSection(item.id, !item.collapsed)}
                      >
                        {item.title}
                      </button>
                      <span className="wl-count">{t('{count} markets', { count: item.symbols.length })}</span>
                    </th>
                  </tr>
                  {!item.collapsed &&
                    rows.map((row) => {
                      const href = chartHrefFor(row.symbol, workbench);
                      return (
                        <tr key={row.symbol} data-symbol={row.symbol} draggable onDragStart={(event) => onRowDragStart(event, row.symbol)}>
                          <th scope="row">
                            <a href={href} onClick={(event) => openRow(event, href)} className="wl-symbol">
                              {row.symbol}
                            </a>
                          </th>
                          {(['last', 'change', 'high', 'low', 'volume'] as const).map((column) => (
                            <td
                              key={column}
                              className={column === 'last' || column === 'change' ? 'wl-quote' : undefined}
                              data-column={column}
                              data-tick={column === 'last' || column === 'change' ? (ticks[row.symbol] ?? '') : undefined}
                              data-state={quoteState(row.ticker)}
                            >
                              <Quote row={row} column={column} tickSize={row.market?.tickSize ?? null} />
                            </td>
                          ))}
                          <td className="wl-actions">
                            <button
                              type="button"
                              className="wl-btn"
                              aria-label={t('Details for {symbol}', { symbol: row.symbol })}
                              onClick={() => setDetails(row.symbol)}
                            >
                              {t('Details')}
                            </button>
                            <button
                              type="button"
                              className="wl-btn"
                              aria-label={t('Remove {symbol}', { symbol: row.symbol })}
                              disabled={locked}
                              onClick={() => void removeMarket(row.symbol)}
                            >
                              {t('Remove')}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  {!item.collapsed && item.symbols.length === 0 && (
                    <tr className="wl-empty">
                      <td colSpan={WATCHLIST_COLUMNS.length + 1}>{t('Empty list')}</td>
                    </tr>
                  )}
                </tbody>
              );
            })}
          </table>
          <form
            className="wl-inline"
            onSubmit={(event) => {
              event.preventDefault();
              void createSection();
            }}
          >
            <input
              aria-label={t('New section name')}
              placeholder={t('New section name')}
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              maxLength={40}
            />
            <button type="submit" className="wl-btn" disabled={locked}>
              {t('Add section')}
            </button>
          </form>
        </div>
      )}

      {!list && store.status === 'ready' && <p className="wl-note">{t('No lists')}</p>}
      {store.status === 'loading' && (
        <p className="wl-note" role="status">
          {t('Prices have not arrived')}
        </p>
      )}
      {detailRow && <Details row={detailRow} onClose={() => setDetails(null)} />}
    </section>
  );
}

function findRow(
  list: { sections: { symbols: string[] }[] },
  symbol: string,
  listing: readonly MarketRow[],
  tickers: Readonly<Record<string, TickerRow>> | undefined,
): WatchRow {
  return { symbol, market: listedSymbol(listing, symbol), ticker: tickers?.[symbol] };
}
