import { memo } from 'react';
import { useSession } from '../../../features/session/session';
import { deskCopy } from './copy';
import { DESK_INTERVALS, useBalances, useBook, useOpenOrders } from './data';
import { Popover, PopoverContent, PopoverTrigger, useTicker } from './deps';
import { overall, streamOf, type Stream, type StreamState } from './feed-status';
import { useNow } from './hooks';
import { useOrdersPaused } from './orders-paused';
import { STALE_BOOK_MS } from './OrderBook';

const STREAM_KEY = {
  session: 'Status session',
  book: 'Status book',
  ticker: 'Status ticker',
  orders: 'Status orders',
  balances: 'Status balances',
} as const;

const STATE_KEY = {
  ok: 'Status ok',
  old: 'Status old',
  down: 'Status down',
  loading: 'Status loading',
  off: 'Status off',
} as const satisfies Record<StreamState, string>;

/**
 * One chip, one popover: each feed on its own line with its own state and age. The words say "Data", never "Connected":
 * the desk reads the service every few seconds, and a single green dot would hide an order list that failed.
 */
export const FeedStatus = memo(function FeedStatus({ symbol }: { symbol: string }) {
  const { t } = deskCopy.useCopy();
  const { userId } = useSession();
  const signedIn = userId !== null;
  // The same reads the desk already makes (the scheduler shares identical ones), so this adds no requests. Only this
  // chip re-renders when they change or age: the rest of the desk never sees it.
  const book = useBook(symbol);
  const ticker = useTicker(symbol, { intervalMs: DESK_INTERVALS.ticker });
  const openOrders = useOpenOrders();
  const balances = useBalances();
  const now = useNow(2_000);
  const streams: Stream[] = [
    { id: 'session', state: signedIn ? 'ok' : 'off', ageSeconds: null },
    streamOf('book', book, {
      now,
      intervalMs: DESK_INTERVALS.book,
      stampedAt: book.status === 'ready' ? book.data.timestamp : undefined,
      stampStaleMs: STALE_BOOK_MS,
    }),
    streamOf('ticker', ticker, { now, intervalMs: DESK_INTERVALS.ticker }),
    streamOf('orders', openOrders, { now, intervalMs: DESK_INTERVALS.openOrders, signedIn, privateRead: true }),
    streamOf('balances', balances, { now, intervalMs: DESK_INTERVALS.balances, signedIn, privateRead: true }),
  ];
  const paused = useOrdersPaused();
  const state = paused ? 'paused' : overall(streams);
  return (
    <Popover>
      <PopoverTrigger className="lt-chip" data-state={state} aria-label={t('Status chip label', { state: t(`Status chip ${state}`) })}>
        <span className="lt-chip-mark" aria-hidden="true" />
        {t(`Status chip ${state}`)}
      </PopoverTrigger>
      <PopoverContent align="end" data-testid="dk-feed-pop" className="lt-stack">
        <p className="lt-pop-title">{t('Status title')}</p>
        <ul className="lt-list lt-tight lt-list-rule">
          <li className="lt-row lt-row-between" data-state={paused ? 'old' : 'ok'}>
            <span>{t('Status placing')}</span>
            <span className="lt-quiet">{paused ? t('Status paused') : t('Status ready')}</span>
          </li>
          {streams.map((stream) => (
            <li key={stream.id} className="lt-row lt-row-between" data-state={stream.state}>
              <span>{t(STREAM_KEY[stream.id])}</span>
              <span className="lt-quiet">
                {stream.id === 'session'
                  ? t(signedIn ? 'Status signed in' : 'Status signed out')
                  : stream.state === 'ok' || stream.state === 'old'
                    ? t(`${STATE_KEY[stream.state]} ago`, { seconds: stream.ageSeconds ?? 0 })
                    : t(STATE_KEY[stream.state])}
              </span>
            </li>
          ))}
        </ul>
        <p className="lt-note">{t('Status note')}</p>
      </PopoverContent>
    </Popover>
  );
});
