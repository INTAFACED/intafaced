import { useMemo, useState } from 'react';
import { Segmented, StateBlock } from '@intafaced/ui/lit';
import { DeskTemplate, Select, Skeleton, Table, type Notice } from '@intafaced/ui/lit/templates';
import type { VenueMarketState, VenueMarketStates } from '../../../data/venue-market-states';
import { navigate } from '../../../app/location';
import { usePreferences } from '../../../shared/preferences';
import { displayAmount } from '../../../shared/money';
import { TestMark } from '../../../features/trade/venue/VenueKit';
import { CHART_INTERVALS, useChartCandles, type ChartInterval } from '../chart/candles';
import { ChartSourceContext, type ChartSource } from '../chart/chart-source';
import { PriceChart } from '../chart/PriceChart';
import { zoneName } from '../desk/time';
import { EmptyBook, EmptyChart, EmptyContract, EmptyTicket } from './EmptyDesk';
import { ModeStrip } from './ModeStrip';
import { useVenuePublicBook } from './data';
import { deskCopy } from './desk-copy';

/**
 * The futures desk for a person who is not signed in, on a deployment whose venue door is on: the perpetuals
 * the venue lists (`GET /api/v1/venue/market-states`), each with the venue's chart (`/venue/chart-candles`) and book
 * (`/venue/public-book`), all public reads. Every figure is the venue's; nothing comes from our own book. The ticket is
 * drawn with every control off and says to sign in: a signed-in person gets the venue desk itself.
 */
export function PublicVenueDesk({ states, requested }: { states: VenueMarketStates; requested: string | null }) {
  const { t } = deskCopy.useCopy();
  const venue = states.value.venue.displayName;
  const perps = states.value.markets.filter((m) => m.kind === 'perpetual');
  const market = perps.find((m) => m.symbol === requested) ?? perps[0] ?? null;
  const source = useMemo<ChartSource>(
    () => ({
      kind: 'venue',
      venueId: states.venueId,
      venueName: venue,
      test: states.value.test,
      intervals: CHART_INTERVALS,
      asOf: Date.parse(states.asOf),
      markets: [],
    }),
    [states.venueId, venue, states.value.test, states.asOf],
  );
  const notices: Notice[] = [
    {
      id: 'sign-in',
      refusal: {
        variant: 'refused',
        title: t('Sign in title'),
        body: t('Sign in body'),
        action: { label: t('Sign in'), href: `/login?redirect=${encodeURIComponent('/trade/futures')}` },
      },
    },
  ];

  return (
    <div data-screen="futures" data-venue="public">
      <DeskTemplate
        section={<ModeStrip />}
        title={t('Futures desk')}
        mode="pro"
        state={{ kind: 'ready' }}
        notices={notices}
        instrument={
          market ? (
            <section aria-label={t('Contract')} className="lt-row" data-testid="venue-public-contracts">
              <Select
                label={t('Choose a contract')}
                options={perps.map((m) => ({ value: m.symbol, label: m.symbol }))}
                value={market.symbol}
                onChange={(value) => value && navigate(`/trade/futures?symbol=${encodeURIComponent(value)}`)}
              />
              <span className="lt-note" data-testid="venue-public-source">
                {t('Venue prices', { venue })} <TestMark test={states.value.test} />
              </span>
            </section>
          ) : (
            <EmptyContract />
          )
        }
        chart={
          market ? (
            <ChartSourceContext.Provider value={source}>
              <VenueChart market={market} />
            </ChartSourceContext.Provider>
          ) : (
            <EmptyChart />
          )
        }
        book={market ? <VenueBook market={market} /> : <EmptyBook />}
        ticket={<EmptyTicket why={market ? t('Sign in ticket reason', { contract: market.symbol }) : undefined} />}
      />
    </div>
  );
}

function VenueChart({ market }: { market: VenueMarketState }) {
  const { t } = deskCopy.useCopy();
  const { timeZone } = usePreferences();
  const [interval, setInterval] = useState<ChartInterval>('15m');
  const candles = useChartCandles(market.symbol, interval);
  const labels = useMemo(
    () => ({
      buy: t('Side_buy'),
      sell: t('Side_sell'),
      open: t('O'),
      high: t('H'),
      low: t('L'),
      close: t('C'),
      change: t('Change'),
      chart: t('Chart of contract', { contract: market.symbol }),
    }),
    [t, market.symbol],
  );
  let body: React.ReactNode;
  if (candles.status === 'loading') body = <Skeleton shape="chart" />;
  else if (candles.status === 'empty' || candles.status === 'refused')
    body = <StateBlock kind="empty" title={t('Chart no candles title')} body={t('Chart no candles reason')} />;
  else if (candles.status === 'error')
    body = <StateBlock kind="error" title={t('Chart error title')} onRetry={candles.retry} retryLabel={t('Try again')} />;
  else
    body = (
      <PriceChart
        candles={candles.data}
        mode="candles"
        interval={interval}
        resetKey={`${market.symbol}:${interval}`}
        tickSize={market.tickSize}
        orderLines={[]}
        fills={[]}
        timeZone={zoneName(timeZone)}
        labels={labels}
      />
    );
  return (
    <div className="lt-panel" data-testid="venue-public-chart" data-market={market.symbol}>
      <div className="lt-row">
        <Segmented
          label={t('Chart intervals')}
          value={interval}
          onChange={(value) => setInterval(value)}
          options={CHART_INTERVALS.map((id) => ({ value: id, label: id }))}
        />
      </div>
      <div className="lt-canvas">{body}</div>
    </div>
  );
}

type Level = { side: 'bid' | 'ask'; price: string; amount: string };

function VenueBook({ market }: { market: VenueMarketState }) {
  const { t } = deskCopy.useCopy();
  const book = useVenuePublicBook(market.symbol);
  let body: React.ReactNode;
  if (book.status === 'loading') body = <Skeleton shape="figure" />;
  else if (book.status === 'error')
    body = <StateBlock kind="error" title={t('Book error title')} onRetry={book.retry} retryLabel={t('Try again')} />;
  else if (book.status !== 'ready') body = <p className="lt-note">{t('Book not published')}</p>;
  else if (book.data.value.asks.length === 0 && book.data.value.bids.length === 0) body = <p className="lt-note">{t('Book empty')}</p>;
  else {
    // Asks above bids, the best of each next to the other, as a book reads; one table per side keeps both columns in view.
    const side = (kind: Level['side'], levels: readonly { price: string; amount: string }[]) => (
      <Table
        caption={kind === 'ask' ? t('Asks') : t('Bids')}
        dense
        columns={[
          { key: 'price', label: t('Price in', { asset: market.quoteAsset }), align: 'end', cell: (l: Level) => displayAmount(l.price) },
          { key: 'amount', label: t('Size in', { asset: market.baseAsset }), align: 'end', cell: (l) => displayAmount(l.amount) },
        ]}
        rows={levels.map((l) => ({ side: kind, ...l }))}
        rowKey={(l) => `${l.side}:${l.price}`}
        rowMarks={(l) => ({ 'data-testid': 'venue-public-book-row', 'data-side': l.side })}
      />
    );
    body = (
      <div className="lt-stack-tight">
        {side('ask', [...book.data.value.asks].reverse())}
        {side('bid', book.data.value.bids)}
      </div>
    );
  }
  return (
    <section aria-label={t('Order book')} className="lt-panel" data-testid="venue-public-book" data-market={market.symbol}>
      <h2 className="lt-panel-title">{t('Order book')}</h2>
      {body}
    </section>
  );
}
