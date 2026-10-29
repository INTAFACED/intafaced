import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useApi, useSession } from '../features/session/session';
import { z } from 'zod';
import { CoinIcon } from '@intafaced/ui';
import { fmtPrice, useMarkets, useTickers, type Loadable, type MarketRow, type TickerRow } from '../data';
import { assetName, homeCopy } from '../screens/home/copy';
import { navigate } from './location';
import { coinHref, roomTitle, roomDescription, roomPath, searchRooms } from './navigation';
import { useHelpResultCap, useHelpSearch, type HelpState } from './search-help';
import { paymentHref, usePaymentSearch, type PaymentState } from './search-payment';
import { ShellIcon } from './icons';
import { shellCopy } from './shell-copy';
import { usePreferences } from '../shared/preferences';
import { isUsdQuote, listings } from '../screens/home/select';

type Group = 'Payments' | 'Coins' | 'Markets' | 'Pages' | 'Help';
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
  /** Language of a Help article's title, when it differs from the page's. */
  lang?: string;
}
const perGroup = 8;
/** How long "No results" stands before the miss is counted, so the words passed while typing are not counted. */
const MISS_SETTLE_MS = 1_200;

const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform);

/** True when a key press is going into a field, so `/` must stay a character there. */
const typingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/**
 * Header search (UI-SPEC 3.1): coins, markets, pages and Help articles. Ctrl or Cmd K, or `/` outside a field, opens the results. Enter on a coin opens its page;
 * Enter on a market opens the desk in Pro and the coin page in Simple.
 * The markets come from the shared data layer (useMarkets). TODO(B1): swap the hand-built list to the kit Autocomplete.
 */
export function TopSearch({ compact, helpCap }: { compact?: boolean; helpCap?: number | null }) {
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
      const slash =
        event.key === '/' && !event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.altKey && !typingTarget(event.target);
      if (slash || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')) {
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
        .map<Row>((room) => {
          const path = roomPath(room, requestedLocale);
          // Where it lives ("Bank > Earn"); a parked room says it opens to its blockers, which the room itself names live.
          const hint = path
            ? room.area === 'web3'
              ? `${path} · ${t('Opens to its blockers')}`
              : path
            : roomDescription(room, requestedLocale);
          return { key: `page:${room.path}`, group: 'Pages', label: roomTitle(room, requestedLocale), hint, href: room.path };
        }),
    [query, mode, requestedLocale, t],
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
          helpCap={helpCap}
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

/**
 * Loads the listed markets and the owner's help result cap once, after the first use, and keeps them for the session.
 * A `helpCap` given by the caller (tests, previews) stands in for the owner's value.
 */
function SearchData({
  open,
  helpCap,
  ...props
}: Omit<PanelProps, 'help' | 'payment'> & { open: boolean; helpCap: number | null | undefined }) {
  const markets = useMarkets();
  const tickers = useTickers();
  const ownerCap = useHelpResultCap(open);
  const help = useHelpSearch(props.query, open, helpCap === undefined ? ownerCap : helpCap);
  // Merchant payments are searched only from a Business profile, by a full payment id (J-home-ia-02 #7).
  const { session, mode } = useSession();
  const payment = usePaymentSearch(props.query, open && Boolean(session) && mode === 'Business');
  // The last search counted as a miss outlives the panel, so closing and reopening on the same words counts it once.
  const counted = useRef<string | null>(null);
  return open ? <SearchPanel {...props} help={help} payment={payment} source={markets} tickers={tickers} counted={counted} /> : null;
}

interface PanelProps {
  id: string;
  query: string;
  pages: Row[];
  help: HelpState;
  payment: PaymentState;
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
  help,
  payment,
  layoutMode,
  active,
  setActive,
  inputRef,
  keysRef,
  close,
  source,
  tickers,
  counted,
}: PanelProps & {
  source: Loadable<MarketRow[]>;
  tickers: Loadable<Record<string, TickerRow>>;
  counted: RefObject<string | null>;
}) {
  const { t } = shellCopy.useCopy();
  const names = homeCopy.useCopy();
  const signedIn = Boolean(useSession().session);
  const last = tickers.status === 'ready' ? tickers.data : undefined;
  const priceOf = (market: MarketRow) => {
    if (!last?.[market.symbol]?.last) return undefined;
    const price = fmtPrice(last[market.symbol]!.last, market.tickSize);
    return isUsdQuote(market.quote) ? `$${price}` : `${price} ${market.quote}`;
  };
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const loading = source.status === 'loading';
  const api = useApi();
  const paymentList = useMemo<Row[]>(
    () =>
      payment.status === 'ready'
        ? [
            {
              key: `payment:${payment.payment.id}`,
              group: 'Payments',
              label: payment.payment.id,
              hint: `${payment.payment.amount} ${payment.payment.assetId}`,
              href: paymentHref(payment.payment.id),
            },
          ]
        : [],
    [payment],
  );
  const helpList = useMemo<Row[]>(() => {
    if (help.status === 'idle') return [];
    const articles =
      help.status === 'ready'
        ? help.rows.map<Row>((row) => ({
            key: `help:${row.id}`,
            group: 'Help',
            label: row.title,
            hint: '',
            href: row.href,
            lang: row.lang,
          }))
        : [];
    // Always one way on to the Help room, so a search with nothing found still has somewhere to go.
    return [...articles, { key: 'help:all', group: 'Help', label: t('Open Help'), hint: '', href: '/support' }];
  }, [help, query, t]);
  const rows = useMemo(() => {
    if (source.status !== 'ready') return [...paymentList, ...pages, ...helpList];
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
        // The coin page in Simple (the public Buy card when signed out), the coin's own desk in Pro.
        href: coinHref(
          listing.base,
          layoutMode,
          (listed.find((m) => m.base === listing.base && m.quote === 'USDT') ?? listing.market).symbol,
          signedIn,
        ),
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
        href: coinHref(market.base, layoutMode, market.symbol, signedIn),
      }));
    return [...paymentList, ...coins, ...markets, ...pages, ...helpList];
  }, [source, tickers, pages, helpList, paymentList, layoutMode, query, signedIn]);

  // A search that found nothing is counted once for the founders: when "No results" has stood for a moment (so the
  // words typed on the way are not counted), or at once on Enter. Nothing found means every group answered: the markets
  // answered (even with none listed) and Help gave its articles, has no limit set or was not asked (too short a search);
  // "Open Help" alone is not a result. A group that failed to answer leaves it unknown, so nothing is counted.
  // The call carries only its kind, no words and no session (no bearer), and is never retried.
  const found = rows.some((row) => row.key !== 'help:all');
  const settled = !loading && help.status !== 'loading' && payment.status !== 'loading' && words.length > 0;
  const answered =
    (source.status === 'ready' || source.status === 'empty') &&
    (help.status === 'ready' || help.status === 'unset' || help.status === 'idle') &&
    payment.status !== 'failed';
  const missed = !found && settled && answered;
  const missKey = words.join(' ');
  function countMiss() {
    if (counted.current === missKey) return;
    counted.current = missKey;
    void api.mutate('notify', 'navMetrics.searchMiss', { kind: 'search_miss' }, z.unknown(), { bearer: '' }).catch(() => undefined);
  }
  useEffect(() => {
    if (!missed) return;
    const timer = setTimeout(countMiss, MISS_SETTLE_MS);
    return () => clearTimeout(timer);
    // countMiss reads only missKey and refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missed, missKey]);

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
      // Nothing found: the miss is counted, and Enter opens the active row as always (Open Help).
      if (missed) countMiss();
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

  const groups: Group[] = ['Payments', 'Coins', 'Markets', 'Pages', 'Help'];
  let index = -1;
  return (
    <div data-testid="tb-search-panel" className="tb-popover tb-search-panel" role="presentation">
      <ul id={id} role="listbox" aria-label={t('Search results')}>
        {groups.map((group) => {
          const inGroup = rows.filter((row) => row.group === group);
          if (!inGroup.length) return null;
          const note = group === 'Help' ? helpNote(help, t) : null;
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
                        <span lang={row.lang}>{row.label}</span>
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
              {note && (
                <p className="tb-empty" role="status">
                  {note}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {!rows.some((row) => row.group !== 'Help') && settled && (
        <p className="tb-empty" role="status">
          {t('No results for "{query}"', { query })}
        </p>
      )}
      {payment.status === 'loading' && (
        <p className="tb-empty" role="status">
          {t('Looking up the payment')}
        </p>
      )}
      {payment.status === 'failed' && (
        <p className="tb-empty" role="status">
          {t('The payment lookup did not load.')}
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

/** What the Help group says when it has no articles to show: still looking, no result limit set, or the call failed. */
function helpNote(help: HelpState, t: ReturnType<typeof shellCopy.useCopy>['t']): string | null {
  if (help.status === 'loading') return t('Searching Help');
  if (help.status === 'unset') return t('Help articles are hidden: no limit for the number of results is set.');
  if (help.status === 'failed') return t('Help articles did not load.');
  return null;
}
