import { ArrowLeft } from 'lucide-react';
import type { JournalTrade, TradeJournal } from '@intafaced/contracts/trade-journal-procedures';
import { RecordListTemplate, Skeleton, Table, type Column, type RoomState } from '@intafaced/ui/lit/templates';
import { TestMark, useOwner, useVenueMode, VenueFrame, WalletBar, type VenueMode } from '../../../features/trade';
import { usePreferences } from '../../../shared/preferences';
import { moneyCopy } from '../copy';
import { navigate } from '../deps';
import { stamp } from '../time';
import { EmptyNote, ErrorNote } from '../pnl/parts';
import { useTradeJournal } from './journal-source';

type T = ReturnType<typeof moneyCopy.useCopy>['t'];
type Fill = JournalTrade['fills'][number];
type Excursion = NonNullable<JournalTrade['excursion']['mae']>;

const READY: RoomState = { kind: 'ready' };

/** `?trade=` on /money/journal: the trade opened beside the list. */
function tradeFromSearch(search: string): string | null {
  return new URLSearchParams(search).get('trade');
}

const href = (tradeId: string | null) => (tradeId ? `/money/journal?trade=${encodeURIComponent(tradeId)}` : '/money/journal');

/** An amount in its asset, exactly as the venue reported it. */
const inAsset = (value: string, asset: string) => `${value} ${asset}`;

/**
 * `/money/journal` (J-portfolio-18): every closed perp trade on the person's own venue account, recorded with no entry by
 * them. One row per trade from open to flat; opening one shows its fills, the parts of its net result, how far the price
 * went against and for it, and its planned and actual R. Read from the journal's own record, which keeps a trade whole
 * after the venue stops returning its fills and candles.
 */
export default function Journal({ search }: { search: string }) {
  const venue = useVenueMode();
  // The person's own wallet, on the venue's network, names the venue account the journal reads.
  return venue.mode === 'on' ? (
    <VenueFrame mode={venue}>
      <JournalRoom search={search} venue={venue} />
    </VenueFrame>
  ) : (
    <JournalRoom search={search} venue={venue} />
  );
}

function JournalRoom({ search, venue }: { search: string; venue: VenueMode }) {
  const { t } = moneyCopy.useCopy();
  const owner = useOwner();
  const journal = useTradeJournal(venue.mode === 'on' && venue.status.available ? owner : null);
  const picked = tradeFromSearch(search);

  const back = (
    <a
      className="lt-button lt-button-secondary"
      href="/money"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate('/money');
      }}
    >
      <ArrowLeft size={16} aria-hidden="true" />
      {t('Journal back')}
    </a>
  );

  let list: React.ReactNode;
  let detail: React.ReactNode = null;
  let summary: React.ReactNode = null;
  if (venue.mode !== 'on' || !venue.status.available) {
    list = <EmptyNote title={t('Journal no venue')} body={t('Journal no venue body')} />;
  } else if (!owner) {
    list = <EmptyNote title={t('Journal connect')} body={t('Journal connect body')} />;
  } else if (journal.status === 'loading') {
    list = <Skeleton shape="rows" count={3} />;
  } else if (journal.status === 'error') {
    list = <ErrorNote title={t('Journal unread')} onRetry={journal.retry} retryLabel={t('Try again')} />;
  } else if (journal.status !== 'ready') {
    list = <EmptyNote title={t('Journal unread')} />;
  } else {
    const data = journal.data;
    const trade = picked ? (data.trades.find((x) => x.tradeId === picked) ?? null) : null;
    list = <Trades journal={data} picked={trade?.tradeId ?? null} t={t} />;
    summary = <Summary journal={data} t={t} />;
    detail = trade ? <TradeDetail trade={trade} journal={data} t={t} /> : null;
  }

  return (
    <div data-testid="money-journal">
      <RecordListTemplate
        title={t('Journal')}
        description={t('Journal intro')}
        state={READY}
        roomAction={back}
        filters={<WalletBar />}
        summary={summary}
        list={list}
        detail={detail}
      />
    </div>
  );
}

function Summary({ journal, t }: { journal: TradeJournal; t: T }) {
  const { totals } = journal;
  return (
    <p data-testid="journal-summary" className="lt-muted">
      {t('Journal summary', { count: String(totals.count), net: totals.netPnl })}
      {totals.netUnknown > 0 ? ` ${t('Journal summary unknown', { count: String(totals.netUnknown) })}` : ''}{' '}
      <TestMark test={journal.venue.test} />
    </p>
  );
}

function Trades({ journal, picked, t }: { journal: TradeJournal; picked: string | null; t: T }) {
  const { timeZone } = usePreferences();
  const columns: Column<JournalTrade>[] = [
    { key: 'market', label: t('Journal market'), cell: (r) => r.symbol },
    { key: 'side', label: t('Journal side'), cell: (r) => (r.side === 'long' ? t('Journal long') : t('Journal short')) },
    { key: 'opened', label: t('Journal opened'), cell: (r) => stamp(r.openedAt, timeZone, Date.now(), true) },
    { key: 'closed', label: t('Journal closed'), cell: (r) => stamp(r.closedAt, timeZone, Date.now(), true) },
    { key: 'entry', label: t('Journal entry'), align: 'end', cell: (r) => r.entryPrice, cellMarks: () => ({ 'data-cell': 'entry' }) },
    { key: 'exit', label: t('Journal exit'), align: 'end', cell: (r) => r.exitPrice, cellMarks: () => ({ 'data-cell': 'exit' }) },
    { key: 'size', label: t('Journal size'), align: 'end', cell: (r) => r.size, cellMarks: () => ({ 'data-cell': 'size' }) },
    {
      key: 'realised',
      label: t('Journal realised'),
      align: 'end',
      cell: (r) => (r.realisedPnl === null ? t('Journal not reported') : inAsset(r.realisedPnl, r.feeAsset)),
      cellMarks: () => ({ 'data-cell': 'realised' }),
    },
    {
      key: 'venue-fee',
      label: t('Journal venue fee'),
      align: 'end',
      cell: (r) => inAsset(r.venueFees, r.feeAsset),
      cellMarks: () => ({ 'data-cell': 'venue-fee' }),
    },
    {
      key: 'builder-fee',
      label: t('Journal builder fee'),
      align: 'end',
      cell: (r) => inAsset(r.builderFees, r.feeAsset),
      cellMarks: () => ({ 'data-cell': 'builder-fee' }),
    },
    {
      key: 'funding',
      label: t('Journal funding column'),
      align: 'end',
      cell: (r) => inAsset(r.funding, r.feeAsset),
      cellMarks: () => ({ 'data-cell': 'funding' }),
    },
    {
      key: 'net',
      label: t('Journal net'),
      align: 'end',
      cell: (r) => (r.netPnl === null ? t('Journal not reported') : inAsset(r.netPnl, r.feeAsset)),
      cellMarks: () => ({ 'data-cell': 'net' }),
    },
  ];
  return (
    <Table
      caption={t('Journal caption')}
      columns={columns}
      rows={journal.trades}
      rowKey={(r) => r.tradeId}
      rowHref={(r) => href(r.tradeId)}
      selected={picked ?? undefined}
      scroll
      rowMarks={(r) => ({
        'data-testid': 'journal-row',
        'data-trade': r.tradeId,
        'data-symbol': r.symbol,
        'data-side': r.side,
        'data-source': r.source,
        'data-stored-at': r.storedAt,
      })}
      empty={<EmptyNote title={t('Journal empty')} body={t('Journal empty body')} />}
    />
  );
}

function Line({ part, label, children }: { part: string; label: string; children: React.ReactNode }) {
  return (
    <div className="lt-row" data-part={part}>
      <dt>{label}</dt>
      <dd>
        <bdi dir="ltr">{children}</bdi>
      </dd>
    </div>
  );
}

function ExcursionLine({ part, label, value, t }: { part: string; label: string; value: Excursion; t: T }) {
  return (
    <div
      className="lt-row"
      data-part={part}
      data-price={value.price}
      data-per-unit={value.perUnit}
      data-usd={value.usd}
      data-pct={value.pct}
    >
      <dt>{label}</dt>
      <dd>
        <bdi dir="ltr">{t('Journal excursion figures', value)}</bdi>
      </dd>
    </div>
  );
}

function TradeDetail({ trade, journal, t }: { trade: JournalTrade; journal: TradeJournal; t: T }) {
  const { timeZone } = usePreferences();
  const a = trade.feeAsset;
  const when = (iso: string) => stamp(iso, timeZone, Date.now(), true);
  const fillColumns: Column<Fill>[] = [
    { key: 'time', label: t('Journal fill time'), cell: (f) => when(f.filledAt) },
    { key: 'side', label: t('Journal side'), cell: (f) => (f.side === 'buy' ? t('Journal buy') : t('Journal sell')) },
    { key: 'price', label: t('Journal fill price'), align: 'end', cell: (f) => f.price, cellMarks: () => ({ 'data-cell': 'price' }) },
    { key: 'size', label: t('Journal size'), align: 'end', cell: (f) => f.amount, cellMarks: () => ({ 'data-cell': 'size' }) },
    {
      key: 'fee',
      label: t('Journal fill fee'),
      align: 'end',
      cell: (f) => inAsset(f.venueFee, f.feeAsset),
      cellMarks: () => ({ 'data-cell': 'venue-fee' }),
    },
    {
      key: 'builder',
      label: t('Journal fill builder fee'),
      align: 'end',
      cell: (f) => inAsset(f.builderFee, f.feeAsset),
      cellMarks: () => ({ 'data-cell': 'builder-fee' }),
    },
    {
      key: 'part',
      label: t('Journal fill part'),
      cell: (f) => `${f.opening ? t('Journal fill opens') : t('Journal fill closes')}${f.split ? ` · ${t('Journal fill split')}` : ''}`,
      cellMarks: (f) => ({ 'data-cell': 'part', 'data-opening': String(f.opening), 'data-split': String(f.split) }),
    },
  ];
  return (
    <section
      data-testid="journal-trade"
      data-trade={trade.tradeId}
      data-source={trade.source}
      className="lt-stack"
      aria-label={t('Journal trade')}
    >
      <h3 className="lt-heading">
        {t('Journal trade title', {
          side: trade.side === 'long' ? t('Journal long') : t('Journal short'),
          symbol: trade.symbol,
        })}{' '}
        <TestMark test={journal.venue.test} />
      </h3>
      <p data-testid="journal-source" data-stored-at={trade.storedAt} className="lt-muted">
        {trade.source === 'record'
          ? t('Journal from record', { time: when(trade.storedAt) })
          : t('Journal from venue', { venue: journal.venue.name, time: when(trade.storedAt) })}
      </p>
      <p className="lt-muted">{t('Journal times', { opened: when(trade.openedAt), closed: when(trade.closedAt) })}</p>

      <dl data-testid="journal-result" className="lt-stack-tight">
        <Line part="realised" label={t('Journal realised')}>
          {trade.realisedPnl === null ? t('Journal not reported') : inAsset(trade.realisedPnl, a)}
        </Line>
        <Line part="venue-fee" label={t('Journal venue fee')}>
          {inAsset(trade.venueFees, a)}
        </Line>
        <Line part="builder-fee" label={t('Journal builder fee')}>
          {inAsset(trade.builderFees, a)}
        </Line>
        <Line part="funding" label={t('Journal funding', { count: String(trade.fundingPayments) })}>
          {inAsset(trade.funding, a)}
        </Line>
        <Line part="net" label={t('Journal net')}>
          {trade.netPnl === null ? t('Journal not reported') : inAsset(trade.netPnl, a)}
        </Line>
      </dl>

      <dl data-testid="journal-prices" className="lt-stack-tight">
        <Line part="entry" label={t('Journal entry average')}>
          {trade.entryPrice}
        </Line>
        <Line part="exit" label={t('Journal exit average')}>
          {trade.exitPrice}
        </Line>
        <Line part="size" label={t('Journal largest size')}>
          {trade.size}
        </Line>
      </dl>

      <Table
        caption={t('Journal fills caption')}
        columns={fillColumns}
        rows={trade.fills}
        rowKey={(f) => `${f.fillId}:${f.opening ? 'open' : 'close'}`}
        scroll
        rowMarks={(f) => ({ 'data-testid': 'journal-fill', 'data-fill': f.fillId, 'data-at': f.filledAt })}
      />

      <dl data-testid="journal-excursion" data-complete={String(trade.excursion.complete)} className="lt-stack-tight">
        <p className="lt-hint">{t('Journal excursion rule')}</p>
        {trade.excursion.mae && trade.excursion.mfe ? (
          <>
            <ExcursionLine part="mae" label={t('Journal mae')} value={trade.excursion.mae} t={t} />
            <ExcursionLine part="mfe" label={t('Journal mfe')} value={trade.excursion.mfe} t={t} />
          </>
        ) : (
          <>
            <Line part="mae" label={t('Journal mae')}>
              {t('Journal incomplete')}
            </Line>
            <Line part="mfe" label={t('Journal mfe')}>
              {t('Journal incomplete')}
            </Line>
            <p className="lt-hint">{t('Journal incomplete why')}</p>
          </>
        )}
      </dl>

      <dl data-testid="journal-r" className="lt-stack-tight">
        <Line part="stop" label={t('Journal stop')}>
          {trade.plannedStop ?? t('Journal no stop')}
        </Line>
        {trade.rMissing === 'no_stop_when_opened' ? (
          <Line part="r" label={t('Journal r')}>
            {t('Journal no r')}
          </Line>
        ) : (
          <>
            <Line part="risk" label={t('Journal one r')}>
              {trade.risk === null ? t('Journal not reported') : inAsset(trade.risk, a)}
            </Line>
            <Line part="r" label={t('Journal r')}>
              {trade.rMissing === 'stop_at_entry'
                ? t('Journal r stop at entry')
                : trade.rMultiple === null
                  ? t('Journal not reported')
                  : `${trade.rMultiple}R`}
            </Line>
          </>
        )}
        <p className="lt-hint">{t('Journal r rule')}</p>
      </dl>
    </section>
  );
}
