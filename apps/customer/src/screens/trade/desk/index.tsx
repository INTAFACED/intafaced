import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ScreenProps } from '../../../app/screen-types';
import { useSession } from '../../../features/session/session';
import { usePreferences } from '../../../shared/preferences';
import { useTicker as useTickerRow } from './deps';
import './desk.css';
import '../chart/chart.css';
import '../terminal/terminal.css';
import { STALE_BOOK_MS, type BookPick } from './OrderBook';
import { type BottomTab } from './BottomTabs';
import { MarketsPanel } from './MarketsPanel';
import { TickerStrip } from './TickerStrip';
import { AccountStrip } from '../terminal/AccountStrip';
import { CompactStack } from '../terminal/CompactStack';
import { connectionOf } from '../terminal/connection';
import { DeskProvider, type DeskShared } from '../terminal/desk-context';
import { StatusBar } from '../terminal/StatusBar';
import { Terminal } from '../terminal/Terminal';
import { deskCopy } from './copy';
import { DESK_INTERVALS, useBalances, useBook, useDeskMarkets, useFills, useOpenOrders } from './data';
import {
  defaultDeskPair,
  Popover,
  PopoverContent,
  PopoverTrigger,
  refusalCopy,
  Skeleton,
  StateBlock,
  normalizePair,
  useFavorites,
} from './deps';
import { findMarket, type DeskMarket } from './market';
import { useMinWidth, useNow } from './hooks';
import type { Reference, Side } from './order-math';

function PairPicker({ selected }: { selected: string }) {
  const { t } = deskCopy.useCopy();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="dk-icon-btn dk-picker" aria-label={t('Choose a market')}>
        <ChevronDown size={16} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" className="dk-picker-pop">
        <MarketsPanel selected={selected} compact onChoose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function Desk({ market, markets, side }: { market: DeskMarket; markets: DeskMarket[]; side: Side | null }) {
  const { userId } = useSession();
  const { timeZone } = usePreferences();
  const ticker = useTickerRow(market.symbol, { intervalMs: DESK_INTERVALS.ticker });
  const book = useBook(market.symbol);
  const balances = useBalances();
  const openOrders = useOpenOrders();
  const { isFavorite, toggle } = useFavorites(userId);
  const [tab, setTab] = useState<BottomTab>('open');
  // Fills refresh quickly while Trade history shows, and for a minute after an order was sent.
  const [justSent, setJustSent] = useState(false);
  useEffect(() => {
    if (!justSent) return;
    const timer = setTimeout(() => setJustSent(false), 60_000);
    return () => clearTimeout(timer);
  }, [justSent]);
  const fills = useFills(tab === 'trades' || justSent);
  const [suggestion, setSuggestion] = useState<BookPick | null>(null);

  // Stable props, so a book or ticker update re-renders only the panels that show it (UI-SPEC 3.6: a tick never re-renders the desk).
  const now = useNow(2_000);
  const bookData = book.status === 'ready' ? book.data : null;
  const bestBid = bookData?.bids[0]?.[0] ?? null;
  const bestAsk = bookData?.asks[0]?.[0] ?? null;
  const reference = useMemo<Reference | null>(() => (bookData ? { bestBid, bestAsk } : null), [bookData !== null, bestBid, bestAsk]); // eslint-disable-line react-hooks/exhaustive-deps
  const referenceFresh = bookData !== null && now - bookData.timestamp < STALE_BOOK_MS;
  const symbol = market.symbol;
  const toggleFavorite = useCallback(() => toggle(symbol), [toggle, symbol]);
  const picker = useMemo(() => <PairPicker selected={symbol} />, [symbol]);
  const onPlaced = useCallback(() => {
    setTab('open');
    setJustSent(true);
  }, []);
  const onPickPrice = useCallback(
    (price: string) => setSuggestion((previous) => ({ price, amount: '', nonce: (previous?.nonce ?? 0) + 1 })),
    [],
  );

  const connection = connectionOf([book, ticker], now);
  const shared = useMemo<DeskShared>(
    () => ({
      market,
      markets,
      zone: timeZone,
      ticker,
      book,
      balances,
      openOrders,
      fills,
      reference,
      referenceFresh,
      suggestion,
      focusSide: side,
      bottomTab: tab,
      setBottomTab: setTab,
      onPick: setSuggestion,
      onPickPrice,
      onPlaced,
      connection,
    }),
    [
      market,
      markets,
      timeZone,
      ticker,
      book,
      balances,
      openOrders,
      fills,
      reference,
      referenceFresh,
      suggestion,
      side,
      tab,
      onPickPrice,
      onPlaced,
      connection,
    ],
  );
  // Below 900 px there is no room to dock: the panels stack, as the desk always did on a phone.
  const docking = useMinWidth(900);

  return (
    <DeskProvider value={shared}>
      <div className="if-desk tm-terminal" data-market={market.symbol} data-docking={docking || undefined}>
        <AccountStrip />
        <TickerStrip
          market={market}
          ticker={ticker}
          favorite={isFavorite(market.symbol)}
          onToggleFavorite={toggleFavorite}
          zone={timeZone}
          picker={picker}
        />
        {docking ? <Terminal key={userId ?? 'guest'} userId={userId} /> : <CompactStack />}
        <StatusBar />
      </div>
    </DeskProvider>
  );
}

function DeskSkeleton() {
  return (
    <div className="if-desk tm-terminal" role="status" aria-busy="true">
      <div className="tm-strip">
        <Skeleton width={220} height={16} className="bg-field" />
      </div>
      <div className="dk-ticker">
        <Skeleton width={160} height={24} className="bg-field" />
      </div>
      <div className="tm-skeleton">
        <div className="tm-skeleton-box">
          <Skeleton height={500} className="bg-field" />
        </div>
        <div className="tm-skeleton-box">
          <Skeleton height={500} className="bg-field" />
        </div>
        <div className="tm-skeleton-box">
          <Skeleton height={500} className="bg-field" />
        </div>
      </div>
    </div>
  );
}

/** Pro desk, `/trade/spot/:pair` (UI-SPEC 5.7). */
export default function TradeDeskScreen({ params, search }: ScreenProps) {
  const { t } = deskCopy.useCopy();
  const markets = useDeskMarkets();
  const pair = normalizePair(params.pair ?? defaultDeskPair);
  const side: Side | null =
    new URLSearchParams(search).get('side') === 'sell' ? 'sell' : new URLSearchParams(search).get('side') === 'buy' ? 'buy' : null;

  if (markets.status === 'loading') return <DeskSkeleton />;
  if (markets.status === 'error')
    return (
      <div className="if-desk if-desk--state">
        <StateBlock kind="error" title={t('Couldn’t load this market')} onRetry={markets.retry} retryLabel={t('Try again')} />
      </div>
    );
  if (markets.status === 'refused') {
    const words = refusalCopy(markets.code, { pair });
    return (
      <div className="if-desk if-desk--state">
        <StateBlock kind="refused" title={words.title} body={words.body} action={words.action} />
      </div>
    );
  }
  const market = markets.status === 'ready' ? findMarket(markets.data, pair) : undefined;
  if (!market || markets.status !== 'ready')
    return (
      <div className="if-desk if-desk--state">
        <StateBlock
          kind="empty"
          title={t('Market not found title')}
          body={t('Market not found body')}
          action={{ label: t('See all markets'), href: '/trade' }}
        />
      </div>
    );
  return <Desk key={market.symbol} market={market} markets={markets.data} side={side} />;
}
