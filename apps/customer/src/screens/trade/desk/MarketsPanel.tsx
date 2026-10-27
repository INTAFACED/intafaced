import { memo, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Search, Star } from 'lucide-react';
import { deskCopy } from './copy';
import { useDeskMarkets } from './data';
import {
  compareDecimal,
  fmtPct,
  fmtPrice,
  Pct,
  refusalCopy,
  Skeleton,
  StateBlock,
  useFavorites,
  useTickers,
  type Loadable,
  type TickerRow,
} from './deps';
import { useMinWidth } from './hooks';
import { pairOf, type DeskMarket } from './market';
import { isUsdQuote, turnoverText } from './text';
import { partialWindowStart, sinceLabel } from '../markets/window';
import { usePreferences } from '../../../shared/preferences';
import { useSession } from '../../../features/session/session';

type Chip = 'favorites' | 'all' | string;
type SortKey = 'volume' | 'change';
type Sort = { key: SortKey; dir: 'desc' | 'asc' } | null;

function sorted(markets: DeskMarket[], tickers: Record<string, TickerRow> | null, sort: Sort): DeskMarket[] {
  if (!sort) return markets;
  const value = (m: DeskMarket) =>
    sort.key === 'volume' ? (tickers?.[m.symbol]?.quoteVolume24h ?? null) : (tickers?.[m.symbol]?.changePct24h ?? null);
  const sign = sort.dir === 'desc' ? -1 : 1;
  return [...markets].sort((a, b) => {
    const order = compareDecimal(value(a), value(b));
    // Unknown values go last whichever way it is sorted.
    if (order === null) return value(a) === null ? (value(b) === null ? 0 : 1) : -1;
    return order * sign;
  });
}

interface Props {
  selected: string;
  /** Where a row sends the person. Defaults to the desk route; a link inside the app is followed without a reload. */
  hrefFor?: (market: DeskMarket) => string;
  onChoose?: () => void;
  /** Inside a popover the list has its own height. */
  compact?: boolean;
}

/** Left column (UI-SPEC 5.7): search, Favorites / All / USDT / USDC chips and one 60 px row per open market. */
export const MarketsPanel = memo(function MarketsPanel({ selected, hrefFor, onChoose, compact = false }: Props) {
  const { t } = deskCopy.useCopy();
  const { userId } = useSession();
  const { isFavorite, toggle, favorites } = useFavorites(userId);
  const markets = useDeskMarkets();
  // The list is hidden below 1180 px; a hidden list refreshes once a minute instead of every 10 seconds.
  const visible = useMinWidth(1180);
  const tickers: Loadable<Record<string, TickerRow>> = useTickers({ intervalMs: compact || visible ? 10_000 : 60_000 });
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<Chip>('all');
  const [sort, setSort] = useState<Sort>(null);

  const open = useMemo(() => (markets.status === 'ready' ? markets.data.filter((m) => m.open) : []), [markets]);
  const quotes = useMemo(() => ['USDT', 'USDC'].filter((q) => open.some((m) => m.quote === q)), [open]);
  const tickerMap = tickers.status === 'ready' ? tickers.data : null;
  const { timeZone } = usePreferences();
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = open.filter(
      (m) =>
        (chip === 'all' || (chip === 'favorites' ? favorites.includes(m.symbol) : m.quote === chip)) &&
        (needle === '' || m.symbol.toLowerCase().includes(needle) || pairOf(m.symbol).toLowerCase().includes(needle)),
    );
    return sorted(filtered, tickerMap, sort);
  }, [open, chip, query, favorites, tickerMap, sort]);

  const cycle = (key: SortKey) =>
    setSort((current) => (current?.key !== key ? { key, dir: 'desc' } : current.dir === 'desc' ? { key, dir: 'asc' } : null));
  const arrow = (key: SortKey) =>
    sort?.key === key ? sort.dir === 'desc' ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" /> : null;

  let list: React.ReactNode;
  if (markets.status === 'loading' || markets.status === 'empty') {
    list = (
      <div className="dk-mk-skeleton" role="status" aria-busy="true" aria-label={t('Markets')}>
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} height={60} className="bg-field" />
        ))}
      </div>
    );
  } else if (markets.status === 'error') {
    list = <StateBlock kind="error" title={t('Couldn’t load markets')} onRetry={markets.retry} retryLabel={t('Try again')} />;
  } else if (markets.status === 'refused') {
    const words = refusalCopy(markets.code);
    list = <StateBlock kind="refused" title={words.title} body={words.body} action={words.action} />;
  } else if (open.length === 0) {
    list = <StateBlock kind="empty" title={t('No markets open')} />;
  } else if (rows.length === 0) {
    list = (
      <StateBlock
        kind="empty"
        title={
          query.trim() ? t('No markets match', { query: query.trim() }) : chip === 'favorites' ? t('Star a market') : t('No markets open')
        }
      />
    );
  } else {
    list = (
      <ul data-testid="dk-mk-list" className="dk-mk-list">
        {rows.map((market) => {
          const ticker = tickerMap?.[market.symbol];
          const favorite = isFavorite(market.symbol);
          const volume = ticker?.quoteVolume24h ?? null;
          const start = partialWindowStart(ticker, Date.now());
          return (
            <li key={market.symbol} data-testid="dk-mk-row" className="dk-mk-row" data-selected={market.symbol === selected || undefined}>
              <button
                type="button"
                className="dk-icon-btn dk-mk-star"
                aria-pressed={favorite}
                aria-label={
                  favorite ? t('Pair favourite remove', { pair: market.symbol }) : t('Pair favourite add', { pair: market.symbol })
                }
                onClick={() => toggle(market.symbol)}
              >
                <Star size={16} aria-hidden="true" fill={favorite ? 'currentColor' : 'none'} />
              </button>
              <a
                className="dk-mk-link"
                href={hrefFor ? hrefFor(market) : `/trade/spot/${pairOf(market.symbol)}`}
                aria-current={market.symbol === selected ? 'true' : undefined}
                onClick={onChoose}
              >
                <span data-testid="dk-mk-name" className="dk-mk-name">
                  <span data-testid="dk-mk-pair" className="dk-mk-pair">
                    {market.symbol}
                  </span>
                  {volume !== null && isUsdQuote(market.quote) ? (
                    <span data-testid="dk-mk-sub" className="dk-mk-sub if-num">
                      {t('Volume short', { value: turnoverText(volume, market.quote) })}
                    </span>
                  ) : null}
                </span>
                <span data-testid="dk-mk-figures" className="dk-mk-figures">
                  <span data-testid="dk-mk-price" className="dk-mk-price if-num">
                    {fmtPrice(ticker?.last ?? null, market.tickSize)}
                  </span>
                  <Pct
                    value={ticker?.changePct24h == null ? null : fmtPct(ticker.changePct24h)}
                    data-testid="dk-mk-change"
                    className="dk-mk-change"
                  />
                  {start !== null ? (
                    <span data-testid="dk-mk-sub" className="dk-mk-sub">
                      {t('Since time', { time: sinceLabel(start, timeZone) })}
                    </span>
                  ) : null}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className={compact ? 'dk-mk dk-mk--compact' : 'dk-mk'}>
      <div className="dk-mk-search">
        <Search size={16} aria-hidden="true" />
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('Search markets')}
          aria-label={t('Search markets')}
        />
      </div>
      <div className="dk-mk-chips" role="group" aria-label={t('Markets')}>
        {(['favorites', 'all', ...quotes] as Chip[]).map((id) => (
          <button key={id} type="button" aria-pressed={chip === id} onClick={() => setChip(id)}>
            {id === 'favorites' ? t('Favorites') : id === 'all' ? t('All') : id}
          </button>
        ))}
      </div>
      <div className="dk-mk-head">
        <button type="button" onClick={() => cycle('volume')} aria-label={t('Sort by volume')}>
          {t('Name and volume')}
          {arrow('volume')}
        </button>
        <button type="button" onClick={() => cycle('change')} aria-label={t('Sort by change')}>
          {t('Price and change')}
          {arrow('change')}
        </button>
      </div>
      <div className="dk-mk-body">{list}</div>
    </div>
  );
});
