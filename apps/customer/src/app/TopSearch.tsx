import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useSession } from '../features/session/session';
import { CoinIcon } from '@intafaced/ui';
import { fmtPrice, useMarkets, useTickers, type Loadable, type MarketRow, type TickerRow } from '../data';
import { assetName, homeCopy } from '../screens/home/copy';
import { navigate } from './location';
import { roomTitle, roomDescription, searchRooms, normalizePair } from './navigation';
import { ShellIcon } from './icons';
import { shellCopy } from './shell-copy';
import { usePreferences } from '../shared/preferences';
import { listings } from '../screens/home/select';

type Group = 'Coins' | 'Markets' | 'Pages';
interface Row {
  key: string;
  group: Group;
  label: string;
  hint: string;
  href: string;
  /** Coins: the ticker, drawn with its icon and plain name. */
  asset?: string;
  /** Right-aligned last price, when the ticker list has one. */
  price?: string;
}
const perGroup = 8;

const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform);

/**
 * Header search (UI-SPEC 3.1): coins, markets and pages. Enter on a coin opens its page;
 * Enter on a market opens the desk in Pro and the coin page in Simple.
 * The markets come from the shared data layer (useMarkets). TODO(B1): swap the hand-built list to the kit Autocomplete.
 */
export function TopSearch({ compact }: { compact?: boolean }) {
  const { t, requestedLocale } = shellCopy.useCopy();
  const { layoutMode } = usePreferences();
  const { mode } = useSession();
  const inputRef = useRef<HTMLInputElement>(null);
  const keysRef = useRef<((event: KeyboardEvent) => void) | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setUsed(true);
        setOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !boxRef.current?.contains(event.target)) setOpen(false);
    };
    const departed = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('popstate', departed);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('popstate', departed);
    };
  }, [open]);

  const pages = useMemo(
    () =>
      searchRooms(query, mode, requestedLocale)
        .slice(0, perGroup)
        .map<Row>((room) => ({
          key: `page:${room.path}`,
          group: 'Pages',
          label: roomTitle(room, requestedLocale),
          hint: roomDescription(room, requestedLocale),
          href: room.path,
        })),
    [query, mode, requestedLocale],
  );

  return (
    <div className={`tb-search ${compact ? 'tb-search--compact' : ''}`} ref={boxRef}>
      <ShellIcon name="search" size={16} />
      <input
        ref={inputRef}
        type="text"
        name="global-search"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-label={t('Search markets')}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={t('Search markets')}
        value={query}
        onFocus={() => {
          setUsed(true);
          setOpen(true);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setUsed(true);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setQuery('');
            setOpen(false);
            event.currentTarget.blur();
          } else if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) setOpen(true);
          else keysRef.current?.(event);
        }}
      />
      <kbd aria-hidden="true">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      {used && (
        <SearchData
          open={open}
          id={listId}
          query={query}
          pages={pages}
          layoutMode={layoutMode}
          active={active}
          setActive={setActive}
          inputRef={inputRef}
          keysRef={keysRef}
          close={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** Loads the listed markets once, after the first use, and keeps them for the session. */
function SearchData({ open, ...props }: PanelProps & { open: boolean }) {
  const markets = useMarkets();
  const tickers = useTickers();
  return open ? <SearchPanel {...props} source={markets} tickers={tickers} /> : null;
}

interface PanelProps {
  id: string;
  query: string;
  pages: Row[];
  layoutMode: 'simple' | 'pro';
  active: number;
  setActive: (index: number) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  keysRef: RefObject<((event: KeyboardEvent) => void) | null>;
  close: () => void;
}

function SearchPanel({
  id,
  query,
  pages,
  layoutMode,
  active,
  setActive,
  inputRef,
  keysRef,
  close,
  source,
  tickers,
}: PanelProps & { source: Loadable<MarketRow[]>; tickers: Loadable<Record<string, TickerRow>> }) {
  const { t } = shellCopy.useCopy();
  const names = homeCopy.useCopy();
  const last = tickers.status === 'ready' ? tickers.data : undefined;
  const priceOf = (market: MarketRow) => (last?.[market.symbol]?.last ? fmtPrice(last[market.symbol]!.last, market.tickSize) : undefined);
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const rows = useMemo(() => {
    if (source.status !== 'ready') return pages;
    const listed = source.data.filter((market) => market.orderable);
    const fits = (text: string) => words.every((word) => text.toLowerCase().includes(word));
    const coins = listings(listed)
      .filter((listing) => fits(listing.base))
      .slice(0, perGroup)
      .map<Row>((listing) => ({
        key: `coin:${listing.base}`,
        group: 'Coins',
        label: listing.base,
        hint: assetName(listing.base, names) ?? '',
        href: `/coin/${encodeURIComponent(listing.base)}`,
        asset: listing.base,
        price: priceOf(listing.market),
      }));
    const markets = listed
      .filter((market) => fits(`${market.symbol} ${market.base} ${market.quote}`))
      .slice(0, perGroup)
      .map<Row>((market) => ({
        key: `market:${market.symbol}`,
        group: 'Markets',
        label: market.symbol,
        hint: '',
        price: priceOf(market),
        href: layoutMode === 'pro' ? `/trade/spot/${normalizePair(market.symbol)}` : `/coin/${encodeURIComponent(market.base)}`,
      }));
    return [...coins, ...markets, ...pages];
  }, [source, tickers, pages, layoutMode, query]);

  function choose(row: Row | undefined) {
    if (!row) return;
    close();
    inputRef.current?.blur();
    navigate(row.href);
  }
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(rows.length ? (active + 1) % rows.length : 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(rows.length ? (active - 1 + rows.length) % rows.length : 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(rows[Math.min(active, rows.length - 1)]);
    }
  }
  // The input owns focus, so it forwards arrow keys and Enter to the open panel.
  useEffect(() => {
    keysRef.current = onKeyDown;
    return () => {
      keysRef.current = null;
    };
  });

  const groups: Group[] = ['Coins', 'Markets', 'Pages'];
  const loading = source.status === 'loading';
  let index = -1;
  return (
    <div className="tb-popover tb-search-panel" role="presentation">
      <ul id={id} role="listbox" aria-label={t('Search results')}>
        {groups.map((group) => {
          const inGroup = rows.filter((row) => row.group === group);
          if (!inGroup.length) return null;
          return (
            <li key={group} role="presentation">
              <div className="tb-group-title" role="presentation">
                {t(group)}
              </div>
              <ul role="presentation">
                {inGroup.map((row) => {
                  index += 1;
                  const position = index;
                  return (
                    <li
                      key={row.key}
                      id={`${id}-${position}`}
                      role="option"
                      aria-selected={position === active}
                      className="tb-option"
                      onMouseEnter={() => setActive(position)}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => choose(row)}
                    >
                      <span className="tb-option-main">
                        {row.asset ? <CoinIcon asset={row.asset} size={20} /> : null}
                        <span>{row.label}</span>
                        {row.asset && row.hint ? <small className="tb-option-name">{row.hint}</small> : null}
                      </span>
                      {row.price ? (
                        <small className="tb-option-price" data-money>
                          {row.price}
                        </small>
                      ) : !row.asset && row.hint ? (
                        <small>{row.hint}</small>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
      {!rows.length && !loading && (
        <p className="tb-empty" role="status">
          {t('No results for "{query}"', { query })}
        </p>
      )}
      {loading && !rows.length && (
        <p className="tb-empty" role="status">
          {t('Finding markets')}
        </p>
      )}
    </div>
  );
}
