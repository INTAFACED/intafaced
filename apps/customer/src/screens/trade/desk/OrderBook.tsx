import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { OrderBook as WireBook, Trade } from '@intafaced/exchange-contract/schemas';
import { buildBook, buyShare, type BookRow } from './book-math';
import { deskCopy } from './copy';
import {
  fmtAmount,
  fmtPrice,
  refusalCopy,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StateBlock,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  type Loadable,
  type TickerRow,
} from './deps';
import { useTape } from './data';
import { useFlash, useNow, useTickDirection } from './hooks';
import type { DeskMarket } from './market';
import { scaleStep } from './order-math';
import { clockSeconds } from './time';
import { dollarPrice, placesOf } from './text';
import type { Preferences } from '../../../shared/preferences';

const ROW_H = 22;
const MAX_ROWS = 20;
/** Tools (40) + column heading (24) + mid price (40) + the buy/sell ratio bar with its margins (36) around the rows. */
const CHROME_H = 40 + 24 + 40 + 36;
export const STALE_BOOK_MS = 15_000;

type View = 'both' | 'bids' | 'asks';

export interface BookPick {
  price: string;
  /** Running total at that row, used when Shift is held. */
  amount: string;
  nonce: number;
  /** Flatten from Assets: a market sell of `amount` (all that is free), reviewed at once. No price. */
  flatten?: true;
}

const Row = memo(function Row({
  row,
  side,
  priceDecimals,
  amountDecimals,
  baseAsset,
  onPick,
}: {
  row: BookRow;
  side: 'ask' | 'bid';
  priceDecimals: string;
  amountDecimals: number;
  baseAsset: string;
  onPick: (row: BookRow, shift: boolean) => void;
}) {
  return (
    <div
      data-testid="dk-bk-row"
      className="dk-bk-row"
      data-side={side}
      role="row"
      tabIndex={0}
      style={{ '--depth': row.depth } as React.CSSProperties}
      onClick={(event) => onPick(row, event.shiftKey)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onPick(row, event.shiftKey);
        }
      }}
    >
      <span data-testid="dk-bk-bar" className="dk-bk-bar" aria-hidden="true" />
      <span data-testid="dk-bk-price" className="dk-bk-price" role="gridcell">
        {fmtPrice(row.price, priceDecimals)}
      </span>
      <span
        className="dk-bk-num"
        role="gridcell"
        aria-label={`${fmtAmount(row.amount, { places: amountDecimals, fixed: true })} ${baseAsset}`}
      >
        {fmtAmount(row.amount, { places: amountDecimals, fixed: true })}
      </span>
      <span className="dk-bk-num" role="gridcell">
        {fmtAmount(row.total, { places: amountDecimals, fixed: true })}
      </span>
    </div>
  );
});

function Glyph({ top, bottom }: { top: string; bottom: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1" y="2" width="6" height="5" rx="1" fill={top} />
      <rect x="1" y="9" width="6" height="5" rx="1" fill={bottom} />
      <rect x="9" y="3" width="6" height="2" rx="1" fill={top} opacity="0.55" />
      <rect x="9" y="6" width="6" height="2" rx="1" fill={top} opacity="0.55" />
      <rect x="9" y="9" width="6" height="2" rx="1" fill={bottom} opacity="0.55" />
      <rect x="9" y="12" width="6" height="2" rx="1" fill={bottom} opacity="0.55" />
    </svg>
  );
}

interface BookProps {
  market: DeskMarket;
  book: Loadable<WireBook>;
  ticker: Loadable<TickerRow>;
  zone: Preferences['timeZone'];
  onPick: (pick: BookPick) => void;
  onPickPrice: (price: string) => void;
}

function BookView({ market, book, ticker, onPick }: Omit<BookProps, 'zone' | 'onPickPrice'>) {
  const { t } = deskCopy.useCopy();
  const [view, setView] = useState<View>('both');
  const [places, setPlaces] = useState(0);
  const [rows, setRows] = useState(10);
  const body = useRef<HTMLDivElement>(null);
  const nonce = useRef(0);
  const now = useNow(1000);

  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => {
      const free = el.clientHeight - CHROME_H;
      const each = view === 'both' ? Math.floor(free / 2 / ROW_H) : Math.floor(free / ROW_H);
      setRows(Math.max(3, Math.min(MAX_ROWS, each)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [view]);

  const group = useMemo(() => scaleStep(market.tickSize, places), [market.tickSize, places]);
  const groupItems = useMemo(
    () => Object.fromEntries([0, 1, 2].map((p) => [String(p), fmtPrice(scaleStep(market.tickSize, p), scaleStep(market.tickSize, p))])),
    [market.tickSize],
  );
  const amountDecimals = placesOf(market.lotSize);
  const data = book.status === 'ready' ? book.data : null;
  const built = useMemo(
    () => (data ? buildBook(data.bids, data.asks, places === 0 ? null : group, rows) : null),
    [data, group, places, rows],
  );
  const last = ticker.status === 'ready' ? ticker.data.last : null;
  const direction = useTickDirection(last, market.symbol);
  const flash = useFlash(last, market.symbol);
  const share = built ? buyShare(built.bidTotal, built.askTotal) : null;
  const old = data !== null && now - data.timestamp >= STALE_BOOK_MS;
  const empty = data !== null && data.bids.length === 0 && data.asks.length === 0;

  const pick = (row: BookRow, shift: boolean) => {
    nonce.current += 1;
    onPick({ price: row.price, amount: shift ? row.total : '', nonce: nonce.current });
  };
  const stepLabel = (value: number) => groupItems[String(value)];

  let content: React.ReactNode;
  if (book.status === 'loading') {
    content = (
      <div data-testid="dk-bk-skeleton" className="dk-bk-skeleton" role="status" aria-busy="true" aria-label={t('Order book')}>
        {Array.from({ length: 16 }, (_, i) => (
          <Skeleton key={i} height={ROW_H - 4} className="bg-field" />
        ))}
      </div>
    );
  } else if (book.status === 'error') {
    content = <StateBlock kind="error" title={t('Couldn’t load the order book')} onRetry={book.retry} retryLabel={t('Try again')} />;
  } else if (book.status === 'refused') {
    const words = refusalCopy(book.code, { pair: market.symbol.replace('/', '-') });
    content = <StateBlock kind="refused" title={words.title} body={words.body} action={words.action} />;
  } else {
    content = (
      <>
        <div className="dk-bk-head" role="row">
          <span>{t('Price column', { asset: market.quote })}</span>
          <span>{t('Amount column', { asset: market.base })}</span>
          <span>{t('Total column', { asset: market.base })}</span>
        </div>
        <div className="dk-bk-rows" role="rowgroup">
          {view !== 'bids' ? (
            <div className="dk-bk-side dk-bk-side--asks">
              {built?.asks.map((row) => (
                <Row
                  key={`a${row.price}`}
                  row={row}
                  side="ask"
                  priceDecimals={group}
                  amountDecimals={amountDecimals}
                  baseAsset={market.base}
                  onPick={pick}
                />
              ))}
            </div>
          ) : null}
          <div data-testid="dk-bk-mid" className="dk-bk-mid" data-direction={direction ?? undefined} data-flash={flash ?? undefined}>
            <span className="dk-bk-last if-num">
              {last === null || empty ? '—' : dollarPrice(last, market)}
              {direction && !empty ? (
                <span className="dk-bk-arrow" aria-label={direction === 'up' ? t('Price up') : t('Price down')}>
                  {direction === 'up' ? '▲' : '▼'}
                </span>
              ) : null}
            </span>
          </div>
          {view !== 'asks' ? (
            <div className="dk-bk-side dk-bk-side--bids">
              {built?.bids.map((row) => (
                <Row
                  key={`b${row.price}`}
                  row={row}
                  side="bid"
                  priceDecimals={group}
                  amountDecimals={amountDecimals}
                  baseAsset={market.base}
                  onPick={pick}
                />
              ))}
            </div>
          ) : null}
        </div>
        {empty ? (
          <p data-testid="dk-bk-note" className="dk-bk-note">
            {t('No orders')}
          </p>
        ) : null}
        {old && !empty ? (
          <p data-testid="dk-bk-note" className="dk-bk-note">
            {t('Book may be old')}
          </p>
        ) : null}
        {share ? (
          <div
            data-testid="dk-bk-ratio"
            className="dk-bk-ratio"
            role="img"
            aria-label={t('Buy and sell share', { buy: share.buy, sell: share.sell })}
            style={{ '--buy': `${share.buy}%` } as React.CSSProperties}
          >
            <span className="dk-bk-ratio-b">{t('Buy share', { value: share.buy })}</span>
            <span className="dk-bk-ratio-s">{t('Sell share', { value: share.sell })}</span>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div data-testid="dk-bk" className="dk-bk" ref={body}>
      <div className="dk-bk-tools">
        <div className="dk-bk-views" role="group" aria-label={t('Order book')}>
          <button type="button" aria-pressed={view === 'both'} aria-label={t('Book view both')} onClick={() => setView('both')}>
            <Glyph top="var(--if-down-text)" bottom="var(--if-up-text)" />
          </button>
          <button type="button" aria-pressed={view === 'bids'} aria-label={t('Book view bids')} onClick={() => setView('bids')}>
            <Glyph top="var(--if-up-text)" bottom="var(--if-up-text)" />
          </button>
          <button type="button" aria-pressed={view === 'asks'} aria-label={t('Book view asks')} onClick={() => setView('asks')}>
            <Glyph top="var(--if-down-text)" bottom="var(--if-down-text)" />
          </button>
        </div>
        <Select items={groupItems} value={String(places)} onValueChange={(value) => setPlaces(parseInt(value ?? '0', 10))}>
          <SelectTrigger size={32} aria-label={t('Group prices by')} className="dk-bk-group">
            <SelectValue>{stepLabel(places)}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end">
            {[0, 1, 2].map((p) => (
              <SelectItem key={p} value={String(p)}>
                {stepLabel(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="dk-bk-grid" role="grid" aria-label={t('Order book')}>
        {content}
      </div>
    </div>
  );
}

function Tape({
  market,
  zone,
  onPickPrice,
  active,
}: {
  market: DeskMarket;
  zone: Preferences['timeZone'];
  onPickPrice: (price: string) => void;
  active: boolean;
}) {
  const { t } = deskCopy.useCopy();
  const tape = useTape(market.symbol, active);
  const amountDecimals = placesOf(market.lotSize);
  if (tape.status === 'loading' || tape.status === 'empty')
    return (
      <div data-testid="dk-bk-skeleton" className="dk-bk-skeleton" role="status" aria-busy="true" aria-label={t('Last trades')}>
        {Array.from({ length: 16 }, (_, i) => (
          <Skeleton key={i} height={ROW_H - 4} className="bg-field" />
        ))}
      </div>
    );
  if (tape.status === 'error')
    return <StateBlock kind="error" title={t('Couldn’t load trades')} onRetry={tape.retry} retryLabel={t('Try again')} />;
  if (tape.status === 'refused') {
    const words = refusalCopy(tape.code);
    return <StateBlock kind="refused" title={words.title} body={words.body} action={words.action} />;
  }
  const rows: Trade[] = [...tape.data].sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
  if (rows.length === 0) return <StateBlock kind="empty" title={t('No trades')} />;
  return (
    <div className="dk-bk-tape" role="grid" aria-label={t('Last trades')}>
      <div className="dk-bk-head" role="row">
        <span>{t('Time column')}</span>
        <span>{t('Price column', { asset: market.quote })}</span>
        <span>{t('Amount column', { asset: market.base })}</span>
      </div>
      <div className="dk-bk-rows" role="rowgroup">
        {rows.map((trade) => (
          <div
            key={trade.id}
            data-testid="dk-bk-row--tape"
            className="dk-bk-row dk-bk-row--tape"
            role="row"
            tabIndex={0}
            onClick={() => onPickPrice(trade.price)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onPickPrice(trade.price);
              }
            }}
          >
            <span className="dk-bk-time" role="gridcell">
              {clockSeconds(trade.timestamp, zone)}
            </span>
            <span data-testid="dk-bk-price" className="dk-bk-price" data-side={trade.side === 'buy' ? 'bid' : 'ask'} role="gridcell">
              {fmtPrice(trade.price, market.tickSize)}
            </span>
            <span className="dk-bk-num" role="gridcell">
              {fmtAmount(trade.amount, { places: amountDecimals, fixed: true })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Right column (UI-SPEC 5.7): Order book and Last trades. Trades are fetched only while their tab is showing. */
export const BookPanel = memo(function BookPanel({ market, book, ticker, zone, onPick, onPickPrice }: BookProps) {
  const { t } = deskCopy.useCopy();
  const [tab, setTab] = useState<'book' | 'trades'>('book');
  return (
    <div data-testid="dk-book" className="dk-panel dk-book">
      <Tabs value={tab} onValueChange={(value) => setTab(value as 'book' | 'trades')} className="dk-fill">
        <TabsList divider className="dk-tabs">
          <TabsTab value="book">{t('Order book')}</TabsTab>
          <TabsTab value="trades">{t('Last trades')}</TabsTab>
        </TabsList>
        <TabsPanel value="book" className="dk-panel-body">
          <BookView market={market} book={book} ticker={ticker} onPick={onPick} />
        </TabsPanel>
        <TabsPanel value="trades" className="dk-panel-body">
          <Tape market={market} zone={zone} onPickPrice={onPickPrice} active={tab === 'trades'} />
        </TabsPanel>
      </Tabs>
    </div>
  );
});
