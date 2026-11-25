/**
 * The pair switcher (Cmd/Ctrl-K, Markets direction A, owner's pick 25 Nov 2026): a modal search over every market we
 * list, perpetuals then spot, with the last five opened as chips. Arrow keys move the active row, Enter opens its desk,
 * Cmd/Ctrl-Enter opens it in a new tab, Escape or a press outside closes it. Data comes from the data layer only.
 */
import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { AssetIcon, Button, SearchField, ToggleChips } from '@intafaced/ui/lit';
import { Sparkline, TestTag } from '@intafaced/ui/lit/templates';
import {
  direction,
  fmtPct,
  useFavorites,
  useMarkets,
  useSparklines,
  useTickers,
  useVenueMarketStates,
  venueMarketRow,
  type Decimal,
  type Loadable,
  type MarketRow,
} from '../../data';
import { isHiddenPath } from '../../app/feature-registry';
import { navigate } from '../../app/location';
import { useFocusTrap } from '../../shared/focus-trap';
import { useEventListener } from '../../shared/outside';
import { useSession } from '../session';
import { pickSource } from '../../screens/trade/markets/source';
import { priceText, volumeText } from '../../screens/trade/markets/select';
import { assetName, marketsCopy } from '../../screens/trade/markets/copy';
import { switcherCopy } from './copy';
import {
  changeOf,
  pickRows,
  readRecent,
  rememberRecent,
  rowsOf,
  splitMatch,
  type RecentPair,
  type Scope,
  type SwitcherRow,
} from './switcher-rows';
import './pair-switcher.css';

const SCOPES: readonly Scope[] = ['all', 'favorites', 'perp', 'spot'];

/**
 * Cmd-K on a Mac, Ctrl-K elsewhere, from anywhere in the app: calls `onToggle`. The shell holds the open state and
 * passes it to `<PairSwitcher>`.
 */
export function usePairSwitcherHotkey(onToggle: () => void): void {
  useEventListener<KeyboardEvent>(typeof window === 'undefined' ? null : window, 'keydown', (event) => {
    if (event.isComposing || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey)) return;
    if (event.key.toLowerCase() !== 'k') return;
    event.preventDefault();
    onToggle();
  });
}

export interface PairSwitcherProps {
  open: boolean;
  onClose: () => void;
}

/** Draws nothing while closed, so its reads run only while it is open. */
export function PairSwitcher({ open, onClose }: PairSwitcherProps) {
  if (!open || typeof document === 'undefined') return null;
  return createPortal(<SwitcherDialog onClose={onClose} />, document.body);
}

/** Every open market the switcher can list: the venue's perpetuals and the spot list Markets shows, with their tickers. */
function useSwitcherMarkets() {
  const venue = useVenueMarketStates();
  const ownMarkets = useMarkets();
  const ownTickers = useTickers();
  const { markets, tickers } = useMemo(() => pickSource(venue, ownMarkets, ownTickers), [venue, ownMarkets, ownTickers]);
  const perps = useMemo<MarketRow[]>(
    () =>
      venue.status === 'ready'
        ? venue.data.value.markets
            .filter((m) => m.kind === 'perpetual')
            .map(venueMarketRow)
            .filter((m) => m.orderable)
        : [],
    [venue],
  );
  const spot = useMemo<MarketRow[]>(() => (markets.status === 'ready' ? markets.data.filter((m) => m.orderable) : []), [markets]);
  const rows = useMemo(
    () => rowsOf(perps, spot, tickers.status === 'ready' ? tickers.data : undefined, isHiddenPath),
    [perps, spot, tickers],
  );
  const test = venue.status === 'ready' && venue.data.value.test === true;
  return { rows, markets: markets as Loadable<MarketRow[]>, test };
}

function SwitcherDialog({ onClose }: { onClose: () => void }) {
  const { t } = switcherCopy.useCopy();
  const marketsWords = marketsCopy.useCopy();
  const { userId } = useSession();
  const { favorites } = useFavorites(userId);
  const { rows: allRows, markets, test } = useSwitcherMarkets();

  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<RecentPair[]>(() => readRecent());

  const pane = useRef<HTMLDivElement>(null);
  useFocusTrap(pane, true, onClose, '[data-switcher-input]');

  const titleId = useId();
  const listId = useId();
  const optionId = (index: number) => `${listId}-o${index}`;

  const nameOf = useCallback((base: string) => assetName(base, marketsWords), [marketsWords]);
  const rows = useMemo(() => pickRows(allRows, query, scope, favorites, nameOf), [allRows, query, scope, favorites, nameOf]);
  const current = rows.length === 0 ? -1 : Math.min(active, rows.length - 1);
  const perps = rows.filter((row) => row.kind === 'perp');
  const spots = rows.filter((row) => row.kind === 'spot');

  const recentRows = useMemo(
    () =>
      recent
        .map((pair) => allRows.find((row) => row.symbol === pair.symbol && row.kind === pair.kind))
        .filter((row): row is SwitcherRow => row !== undefined),
    [recent, allRows],
  );

  // Sparklines only for spot rows that have a ticker, and only the first screenful.
  const sparkSymbols = useMemo(
    () =>
      spots
        .filter((row) => row.ticker?.last != null)
        .slice(0, 12)
        .map((row) => row.symbol),
    [spots],
  );
  const sparks = useSparklines(sparkSymbols);
  const lines = sparks.status === 'ready' ? sparks.data : {};

  const choose = (row: SwitcherRow, newTab = false) => {
    if (!row.href) return;
    setRecent(rememberRecent({ symbol: row.symbol, kind: row.kind }));
    onClose();
    if (newTab) window.open(row.href, '_blank', 'noopener');
    else navigate(row.href);
  };

  const move = (to: number) => {
    if (rows.length === 0) return;
    const next = Math.max(0, Math.min(rows.length - 1, to));
    setActive(next);
    document.getElementById(optionId(next))?.scrollIntoView?.({ block: 'nearest' });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(current + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(current - 1);
        return;
      case 'PageDown':
        event.preventDefault();
        move(current + 6);
        return;
      case 'PageUp':
        event.preventDefault();
        move(current - 6);
        return;
      case 'Enter': {
        event.preventDefault();
        const row = rows[current];
        if (row) choose(row, event.metaKey || event.ctrlKey);
        return;
      }
      default:
        return;
    }
  };

  const total = allRows.length;
  const countWords = (count: number) => (count === 1 ? t('1 market') : t('{count} markets', { count }));

  const body = (() => {
    if (total === 0 && markets.status === 'loading') return <p className="psw-note">{t('Loading markets…')}</p>;
    if (total === 0 && markets.status === 'error')
      return (
        <div className="psw-note">
          <span>{t('Markets could not be loaded.')}</span>
          <Button size="sm" onClick={markets.retry}>
            {t('Try again')}
          </Button>
        </div>
      );
    if (total === 0) return <p className="psw-note">{t('No markets are open right now.')}</p>;
    if (rows.length === 0)
      return (
        <p className="psw-note" data-testid="psw-empty">
          {scope === 'favorites' && !query.trim()
            ? t('No favorites yet. Star a market on Markets to keep it here.')
            : t('No market matches “{query}”. Try a coin like BTC, or a pair like ETH/USDC.', { query: query.trim() })}
        </p>
      );
    return null;
  })();

  const group = (label: string, list: readonly SwitcherRow[], offset: number) =>
    list.length === 0 ? null : (
      <div role="group" aria-label={label} className="psw-group">
        <div className="psw-sec" aria-hidden="true">
          <span>{label}</span>
          <span>{countWords(list.length)}</span>
        </div>
        {list.map((row, i) => (
          <Row
            key={`${row.kind}:${row.symbol}`}
            id={optionId(offset + i)}
            row={row}
            query={query}
            active={offset + i === current}
            spark={lines[row.symbol]}
            name={nameOf(row.base)}
            onHover={() => setActive(offset + i)}
            onChoose={(newTab) => choose(row, newTab)}
          />
        ))}
      </div>
    );

  return (
    <div
      className="psw-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={pane} className="psw" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid="pair-switcher">
        <h2 id={titleId} className="lt-sr">
          {t('Switch market')}
        </h2>
        <div className="psw-in">
          <SearchField
            className="psw-field"
            label={t('Search markets')}
            icon={<Search size={20} strokeWidth={2} />}
            data-switcher-input=""
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={current >= 0 ? optionId(current) : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('Search {count} markets: a coin, a pair, a perp', { count: total })}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <kbd className="psw-kbd psw-wide" aria-hidden="true">
            esc
          </kbd>
          <span className="psw-narrow">
            <Button tone="quiet" size="sm" onClick={onClose}>
              {t('Close')}
            </Button>
          </span>
        </div>

        <div className="psw-filters">
          <ToggleChips
            label={t('Show markets')}
            options={SCOPES.map((value) => ({
              value,
              label: t(value === 'all' ? 'All' : value === 'favorites' ? 'Favorites' : value === 'perp' ? 'Perps' : 'Spot'),
            }))}
            value={scope}
            onChange={(value) => {
              setScope(SCOPES.find((s) => s === value) ?? 'all');
              setActive(0);
              pane.current?.querySelector<HTMLElement>('[data-switcher-input]')?.focus();
            }}
          />
        </div>

        <div className="psw-body">
          {recentRows.length > 0 ? (
            <section aria-label={t('Recently opened')}>
              <div className="psw-sec" aria-hidden="true">
                <span>{t('Recent')}</span>
              </div>
              <ul className="psw-recent">
                {recentRows.map((row) => (
                  <li key={`${row.kind}:${row.symbol}`}>
                    <Button size="sm" className="psw-chip" disabled={!row.href} onClick={() => choose(row)} data-testid="psw-recent">
                      <AssetIcon asset={row.base} size="sm" />
                      <span>{row.pair}</span>
                      {row.kind === 'spot' ? <Change value={changeOf(row)} /> : null}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {body}
          <div id={listId} role="listbox" aria-label={t('Results')} className="psw-list" hidden={rows.length === 0}>
            {group(t('Perps'), perps, 0)}
            {group(t('Spot'), spots, perps.length)}
          </div>
        </div>

        <footer className="psw-foot">
          <span>
            <kbd className="psw-kbd">↑</kbd>
            <kbd className="psw-kbd">↓</kbd> {t('move')}
          </span>
          <span>
            <kbd className="psw-kbd">↵</kbd> {t('open the desk')}
          </span>
          <span className="psw-wide">
            <kbd className="psw-kbd">⌘</kbd>
            <kbd className="psw-kbd">↵</kbd> {t('new tab')}
          </span>
          <span className="psw-wide">
            <kbd className="psw-kbd">esc</kbd> {t('close')}
          </span>
          <span className="psw-grow" />
          {test ? (
            <span className="psw-test">
              <TestTag /> {t('prices, testnet venue')}
            </span>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

function Change({ value }: { value: Decimal | null | undefined }) {
  const dir = direction(value);
  return (
    <span className="psw-ch lt-num" data-dir={dir === 'up' || dir === 'down' ? dir : undefined} dir="ltr">
      {fmtPct(value)}
    </span>
  );
}

function Row({
  id,
  row,
  query,
  active,
  spark,
  name,
  onHover,
  onChoose,
}: {
  id: string;
  row: SwitcherRow;
  query: string;
  active: boolean;
  spark: readonly Decimal[] | undefined;
  name: string | null;
  onHover: () => void;
  onChoose: (newTab: boolean) => void;
}) {
  const { t } = switcherCopy.useCopy();
  const [before, hit, after] = splitMatch(row.pair, query);
  const perp = row.kind === 'perp';
  const who = name ?? row.base;
  const volume = perp ? '—' : volumeText(row.market, row.ticker);
  const detail: ReactNode = !row.href
    ? t('This market’s desk is not open here')
    : [perp ? t('{name} perpetual', { name: who }) : t('{name} spot', { name: who }), volume !== '—' ? t('Vol {volume}', { volume }) : null]
        .filter(Boolean)
        .join(' · ');
  const dir = direction(changeOf(row));
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={row.href ? undefined : true}
      className="psw-row"
      data-testid="psw-row"
      data-href={row.href ?? undefined}
      onMouseMove={active ? undefined : onHover}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => onChoose(event.metaKey || event.ctrlKey)}
    >
      <AssetIcon asset={row.base} size="md" />
      <span className="psw-nm">
        <span className="psw-pair">
          <span data-testid="psw-pair">
            {before}
            {hit ? <mark>{hit}</mark> : null}
            {after}
          </span>
          <span className="psw-tag" data-kind={row.kind}>
            {perp ? t('Perp') : t('Spot')}
          </span>
        </span>
        <span className="psw-detail">{detail}</span>
      </span>
      <span className="psw-sp" aria-hidden="true">
        {spark && spark.length > 1 ? (
          <Sparkline
            label={t('{pair}, last 24 hours', { pair: row.pair })}
            values={spark}
            tone={dir === 'up' ? 'up' : dir === 'down' ? 'down' : 'neutral'}
            size="row"
          />
        ) : null}
      </span>
      <span className="psw-px lt-num" dir="ltr">
        {perp ? '—' : priceText(row.market, row.ticker?.last)}
      </span>
      <Change value={changeOf(row)} />
    </div>
  );
}
