import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ScreenProps } from '../../../app/screen-types';
import { useSession } from '../../../features/session/session';
import { usePreferences } from '../../../shared/preferences';
import { useTicker as useTickerRow } from './deps';
import './desk.css';
import '../chart/chart.css';
import { BookPanel, STALE_BOOK_MS, type BookPick } from './OrderBook';
import { BottomTabs, type BottomTab } from './BottomTabs';
import { ChartPanel } from './ChartPanel';
import { FeedStatus } from './FeedStatus';
import { MarketsPanel } from './MarketsPanel';
import { OrderPanel } from './OrderForm';
import { TickerStrip } from './TickerStrip';
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
import { useNow } from './hooks';
import type { Reference, Side } from './order-math';
import { EmailProofNotice } from '../../../features/account/EmailProofNotice';

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
  const { t } = deskCopy.useCopy();
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
  // Only a stop waiting in Open orders shows the last price, so the bottom strip re-renders on a print only then.
  const waitingStop =
    openOrders.status === 'ready' &&
    openOrders.data.some((order) => (order.type === 'stop' || order.type === 'stop_limit') && order.triggered === null);
  const lastPrice = waitingStop && ticker.status === 'ready' ? ticker.data.last : null;
  const status = useMemo(() => <FeedStatus symbol={symbol} />, [symbol]);
  const toggleFavorite = useCallback(() => toggle(symbol), [toggle, symbol]);
  const picker = useMemo(() => <PairPicker selected={symbol} />, [symbol]);
  const onPlaced = useCallback(() => {
    setTab('open');
    setJustSent(true);
  }, []);
  const onFlatten = useCallback(
    (amount: string) => setSuggestion((previous) => ({ price: '', amount, flatten: true, nonce: (previous?.nonce ?? 0) + 1 })),
    [],
  );
  const onPickPrice = useCallback(
    (price: string) => setSuggestion((previous) => ({ price, amount: '', nonce: (previous?.nonce ?? 0) + 1 })),
    [],
  );

  return (
    <div data-testid="if-desk" className="if-desk" data-market={market.symbol}>
      <TickerStrip
        market={market}
        ticker={ticker}
        favorite={isFavorite(market.symbol)}
        onToggleFavorite={toggleFavorite}
        zone={timeZone}
        picker={picker}
        status={status}
      />
      <EmailProofNotice />
      <div className="dk-grid">
        <aside data-testid="dk-left" className="dk-panel dk-left" aria-label={t('Markets')}>
          <div className="dk-fill">
            <div className="dk-tab-title">
              <span>{t('Markets')}</span>
            </div>
            <MarketsPanel selected={market.symbol} />
          </div>
        </aside>
        <div data-testid="dk-centre" className="dk-centre">
          <ChartPanel market={market} openOrders={openOrders} fills={fills} />
          <OrderPanel
            market={market}
            reference={reference}
            referenceFresh={referenceFresh}
            balances={balances}
            suggestion={suggestion}
            focusSide={side}
            onPlaced={onPlaced}
          />
        </div>
        <BookPanel market={market} book={book} ticker={ticker} zone={timeZone} onPick={setSuggestion} onPickPrice={onPickPrice} />
      </div>
      <BottomTabs
        market={market}
        markets={markets}
        openOrders={openOrders}
        fills={fills}
        balances={balances}
        tab={tab}
        onTab={setTab}
        onFlatten={onFlatten}
        lastPrice={lastPrice}
      />
    </div>
  );
}

function DeskSkeleton() {
  return (
    <div data-testid="if-desk" className="if-desk" role="status" aria-busy="true">
      <div data-testid="dk-ticker" className="dk-ticker">
        <Skeleton width={160} height={24} className="bg-field" />
      </div>
      <div className="dk-grid">
        <div data-testid="dk-left" className="dk-panel dk-left">
          <Skeleton height={500} className="bg-field" />
        </div>
        <div data-testid="dk-centre" className="dk-centre">
          <div data-testid="dk-chart" className="dk-panel dk-chart">
            <Skeleton height={440} className="bg-field" />
          </div>
          <div data-testid="dk-order" className="dk-panel dk-order">
            <Skeleton height={330} className="bg-field" />
          </div>
        </div>
        <div data-testid="dk-book" className="dk-panel dk-book">
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
      <div data-testid="if-desk" className="if-desk if-desk--state">
        <StateBlock kind="error" title={t('Couldn’t load this market')} onRetry={markets.retry} retryLabel={t('Try again')} />
      </div>
    );
  if (markets.status === 'refused') {
    const words = refusalCopy(markets.code, { pair });
    return (
      <div data-testid="if-desk" className="if-desk if-desk--state">
        <StateBlock kind="refused" title={words.title} body={words.body} action={words.action} />
      </div>
    );
  }
  const market = markets.status === 'ready' ? findMarket(markets.data, pair) : undefined;
  if (!market || markets.status !== 'ready')
    return (
      <div data-testid="if-desk" className="if-desk if-desk--state">
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
