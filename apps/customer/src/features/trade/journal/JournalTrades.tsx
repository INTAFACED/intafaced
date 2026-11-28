import type { JournalTrade, TradeJournal } from '@intafaced/contracts/trade-journal-procedures';
import { Table, type Column } from '@intafaced/ui/lit/templates';
import { TestMark } from '../venue/volt/VoltVenue';
import { journalTradesCopy } from './journal-trades-copy';

type T = ReturnType<typeof journalTradesCopy.useCopy>['t'];
type Excursion = NonNullable<JournalTrade['excursion']['mae']>;

/** `?trade=` on /trade/journal: the trade opened beside the list. */
export function tradeFromPath(path: string): string | null {
  return new URL(path, 'http://journal.invalid').searchParams.get('trade');
}

const href = (tradeId: string) => `/trade/journal?trade=${encodeURIComponent(tradeId)}`;

/** An amount in its asset, exactly as the venue reported it. */
const inAsset = (value: string, asset: string) => `${value} ${asset}`;

/** A time as the journal names it: UTC, to the second. */
const when = (iso: string) => new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

/**
 * The Trades tab (J-portfolio-18): every closed perp trade, one row from open to flat with each part of its net result as
 * the venue reports it; the one picked (`?trade=`) opens beside the list with its fills, how far the price went against
 * and for it, and its planned and actual R. Read from the journal's own record, which keeps a trade whole after the venue
 * stops returning its fills and candles.
 */
export function JournalTrades({ journal, picked }: { journal: TradeJournal; picked: string | null }) {
  const { t } = journalTradesCopy.useCopy();
  const trade = picked ? (journal.trades.find((x) => x.tradeId === picked) ?? null) : null;
  return (
    <section className="lt-stack" aria-label={t('Journal caption')} data-testid="journal-trades">
      <Summary journal={journal} t={t} />
      <div className={trade ? 'lt-grid lt-grid-list-detail' : 'lt-grid'}>
        <Trades journal={journal} picked={trade?.tradeId ?? null} t={t} />
        {trade ? <TradeDetail trade={trade} journal={journal} t={t} /> : null}
      </div>
    </section>
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
  const columns: Column<JournalTrade>[] = [
    { key: 'market', label: t('Journal market'), cell: (r) => r.symbol },
    { key: 'side', label: t('Journal side'), cell: (r) => (r.side === 'long' ? t('Journal long') : t('Journal short')) },
    { key: 'closed', label: t('Journal closed'), cell: (r) => when(r.closedAt) },
    { key: 'entry', label: t('Journal entry'), align: 'end', cell: (r) => r.entryPrice, cellMarks: () => ({ 'data-cell': 'entry' }) },
    { key: 'exit', label: t('Journal exit'), align: 'end', cell: (r) => r.exitPrice, cellMarks: () => ({ 'data-cell': 'exit' }) },
    { key: 'size', label: t('Journal size'), align: 'end', cell: (r) => r.size, cellMarks: () => ({ 'data-cell': 'size' }) },
    {
      // The net result, and beneath it each part as the venue reports it: realised, the venue's fee, our builder fee,
      // funding. One column, so every part fits beside the others in the room's width.
      key: 'net',
      label: t('Journal net'),
      align: 'end',
      cell: (r) => (
        <span className="lt-stack-tight">
          <strong data-cell="net">{r.netPnl === null ? t('Journal not reported') : inAsset(r.netPnl, r.feeAsset)}</strong>
          <span className="lt-hint">
            {t('Journal realised column')}{' '}
            <span data-cell="realised">{r.realisedPnl === null ? t('Journal not reported') : inAsset(r.realisedPnl, r.feeAsset)}</span>
            {' · '}
            {t('Journal venue fee')} <span data-cell="venue-fee">{inAsset(r.venueFees, r.feeAsset)}</span>
            {' · '}
            {t('Journal builder fee')} <span data-cell="builder-fee">{inAsset(r.builderFees, r.feeAsset)}</span>
            {' · '}
            {t('Journal funding column')} <span data-cell="funding">{inAsset(r.funding, r.feeAsset)}</span>
          </span>
        </span>
      ),
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
      rowMarks={(r) => ({
        'data-testid': 'journal-row',
        'data-trade': r.tradeId,
        'data-symbol': r.symbol,
        'data-side': r.side,
        'data-source': r.source,
        'data-stored-at': r.storedAt,
      })}
    />
  );
}

function Line({ part, cell, label, children }: { part: string; cell?: string; label: string; children: React.ReactNode }) {
  return (
    <div className="lt-row" data-part={part}>
      <dt>{label}</dt>
      <dd data-cell={cell}>
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
  const a = trade.feeAsset;
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

      <ol aria-label={t('Journal fills caption')} className="lt-stack-tight">
        {trade.fills.map((f) => (
          <li
            key={`${f.fillId}:${f.opening ? 'open' : 'close'}`}
            data-testid="journal-fill"
            data-fill={f.fillId}
            data-at={f.filledAt}
            className="lt-stack-tight"
          >
            <p className="lt-muted">
              {when(f.filledAt)} · {f.side === 'buy' ? t('Journal buy') : t('Journal sell')} ·{' '}
              <span data-cell="part" data-opening={String(f.opening)} data-split={String(f.split)}>
                {f.opening ? t('Journal fill opens') : t('Journal fill closes')}
                {f.split ? ` · ${t('Journal fill split')}` : ''}
              </span>
            </p>
            <dl className="lt-stack-tight">
              <Line part="price" cell="price" label={t('Journal fill price')}>
                {f.price}
              </Line>
              <Line part="size" cell="size" label={t('Journal size')}>
                {f.amount}
              </Line>
              <Line part="venue-fee" cell="venue-fee" label={t('Journal fill fee')}>
                {inAsset(f.venueFee, f.feeAsset)}
              </Line>
              <Line part="builder-fee" cell="builder-fee" label={t('Journal fill builder fee')}>
                {inAsset(f.builderFee, f.feeAsset)}
              </Line>
            </dl>
          </li>
        ))}
      </ol>

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
