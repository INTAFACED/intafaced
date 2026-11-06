import { useState } from 'react';
import type { Position } from '@intafaced/exchange-contract/schemas';
import { Amount, Button, ChangeText, EmptyState, KeyValue, Table, type TableColumn } from '@intafaced/ui';
import { fmtAmount } from '../../../data/format';
import type { Loadable } from '../../../data/types';
import { usePreferences } from '../../../shared/preferences';
import { dayTime } from '../desk/time';
import type { FundingHistory, FundingRate, FundingSeries, FundingStatement, FundingStatementRow, TickerStrip } from './api';
import { STALE_AFTER_MS, useFundingHistory, useFundingStatement } from './data';
import { fundingEstimate, isLive, stableOrder } from './model';
import { LoadGate, SideBadge, TabHeader } from './HistoryTab';
import { tabsCopy } from './tabs-copy';
import { countdownText, exactDecimal, exactPct, nextFundingAt, periodOutcome, sameContract, signedAmount } from './tabs-logic';

type HistoryRow = FundingHistory['rates'][number];
type SeriesPoint = FundingSeries['series'][number];

const withAsset = (value: string | null, asset: string) => (value === null ? null : `${value} ${asset}`);

export function FundingTab({
  symbol,
  funding,
  strip,
  positions,
  now,
}: {
  symbol: string | null;
  funding: Loadable<FundingRate>;
  strip: Loadable<TickerStrip>;
  positions: Loadable<Position[]>;
  now: number;
}) {
  const { t } = tabsCopy.useCopy();
  const { timeZone } = usePreferences();
  const [statementOpen, setStatementOpen] = useState(false);
  const statement = useFundingStatement(true);
  const history = useFundingHistory(symbol, true);
  const stripData = strip.status === 'ready' ? strip.data : null;
  const rate = funding.status === 'ready' ? funding.data.fundingRate : null;

  const noRate = <EmptyState variant="unavailable" size="inline" title={t('Funding none title')} reason={t('Funding none reason')} />;

  const columns: TableColumn<Position>[] = [
    { id: 'contract', header: t('Contract'), value: (p) => p.symbol },
    { id: 'side', header: t('Side'), cell: (p) => <SideBadge side={p.side} /> },
    { id: 'notional', header: t('Notional'), numeric: true, cell: (p) => <Amount value={fmtAmount(p.notional, { places: 4 })} /> },
    {
      id: 'estimate',
      header: t('Funding estimate col'),
      numeric: true,
      // The rate belongs to one contract: another contract's position gets no figure rather than a wrong one.
      cell: (p) => {
        const value = sameContract(p.symbol, symbol) ? fundingEstimate(p, rate) : null;
        return <ChangeText value={value === null ? null : signedAmount(value)} title={t('Funding estimate label')} />;
      },
    },
  ];

  const direction = (r: FundingStatementRow) => (r.direction === 'paid' ? t('Funding paid') : t('Funding received'));
  const paymentColumns: TableColumn<FundingStatementRow>[] = [
    { id: 'contract', header: t('Contract'), value: (r) => r.symbol },
    { id: 'side', header: t('Side'), cell: (r) => <SideBadge side={r.side} /> },
    { id: 'period', header: t('Funding col period'), cell: (r) => <span className="font-mono text-xs">{r.periodId}</span> },
    { id: 'time', header: t('Funding col time'), value: (r) => dayTime(Date.parse(r.time), timeZone) },
    { id: 'rate', header: t('Funding col rate'), value: (r) => exactPct(r.rate) },
    { id: 'amount', header: t('Funding col amount'), value: (r) => withAsset(exactDecimal(r.amount), r.asset) },
    { id: 'direction', header: t('Funding col direction'), value: direction },
  ];
  const statementColumns: TableColumn<FundingStatementRow>[] = [
    { id: 'contract', header: t('Contract'), value: (r) => r.symbol },
    { id: 'side', header: t('Side'), cell: (r) => <SideBadge side={r.side} /> },
    { id: 'position', header: t('Funding col position'), cell: (r) => <span className="font-mono text-xs">{r.positionId}</span> },
    { id: 'period', header: t('Funding col period'), cell: (r) => <span className="font-mono text-xs">{r.periodId}</span> },
    { id: 'direction', header: t('Funding col direction'), value: direction },
    { id: 'amount', header: t('Funding col amount'), value: (r) => withAsset(exactDecimal(r.amount), r.asset) },
  ];
  const historyColumns: TableColumn<HistoryRow>[] = [
    { id: 'period', header: t('Funding col period'), cell: (r) => <span className="font-mono text-xs">{r.periodId}</span> },
    { id: 'rate', header: t('Funding col rate'), value: (r) => exactPct(r.fundingRate) },
    { id: 'premium', header: t('Funding col premium'), value: (r) => exactPct(r.premium) },
    { id: 'interest', header: t('Funding col interest'), value: (r) => exactPct(r.interestComponent) },
    { id: 'annualised', header: t('Funding col annualised'), value: (r) => exactPct(r.annualisedRate) },
    { id: 'mark', header: t('Funding col mark'), value: (r) => exactDecimal(r.mark_price) },
    { id: 'index', header: t('Funding col index'), value: (r) => exactDecimal(r.index_price) },
    {
      id: 'settled',
      header: t('Funding col settled'),
      value: (r) =>
        r.settlement ? `${exactDecimal(r.settlement.paid)} / ${exactDecimal(r.settlement.received)}` : t('Funding not settled'),
    },
  ];
  const seriesColumns: TableColumn<SeriesPoint>[] = [
    { id: 'time', header: t('Funding col time'), value: (p) => dayTime(Date.parse(p.at), timeZone) },
    { id: 'mark', header: t('Funding col mark'), value: (p) => exactDecimal(p.mark) },
    {
      id: 'index',
      header: t('Funding col index'),
      value: (p) => (p.index === null ? `${t('Funding index unpublished')} (${p.indexReason ?? '—'})` : exactDecimal(p.index)),
    },
  ];

  return (
    <section aria-label={t('Funding heading')} className="flex flex-col">
      <TabHeader title={t('Funding heading')} load={funding} />
      <LoadGate
        load={funding}
        thing={t('Thing funding')}
        empty={<EmptyState size="inline" title={t('Choose a contract')} />}
        refused={(code) => (code === 'trade.funding_rate_unavailable' ? noRate : null)}
      >
        {(f) => {
          const nextAt = nextFundingAt(f.nextFundingTimestamp, stripData?.nextFundingTime);
          const mark = f.markPrice ?? stripData?.markPrice ?? null;
          const outcome = periodOutcome(f.lastPeriod);
          const lastPeriod =
            outcome === null || !f.lastPeriod
              ? null
              : outcome.status === 'published'
                ? `${t('Funding period published')} ${f.lastPeriod.periodId}`
                : t(
                    outcome.status === 'unset'
                      ? 'Funding period unset'
                      : outcome.status === 'paused'
                        ? 'Funding period paused'
                        : 'Funding period refused',
                    {
                      period: f.lastPeriod.periodStart ?? f.lastPeriod.periodId,
                      code: outcome.code ?? '—',
                    },
                  );
          const indexNow = f.indexNow
            ? f.indexNow.price === null
              ? t('Funding index unpublished')
              : exactDecimal(f.indexNow.price)
            : null;
          return (
            <>
              <KeyValue
                density="dense"
                className="px-3"
                items={[
                  { label: t('Funding rate'), value: exactPct(f.fundingRate), asOf: f.fundingTimestamp },
                  { label: t('Funding next'), value: nextAt === null ? null : dayTime(nextAt, timeZone) },
                  { label: t('Funding countdown'), value: countdownText(nextAt, now) },
                  { label: t('Funding premium'), value: exactPct(f.premium) },
                  { label: t('Funding interest'), value: exactPct(f.interestComponent) },
                  { label: t('Funding cap'), value: exactPct(f.cap) },
                  { label: t('Funding mark close'), value: exactDecimal(f.periodMarkPrice ?? null) },
                  { label: t('Funding index close'), value: exactDecimal(f.periodIndexPrice ?? null) },
                  { label: t('Funding mark'), value: exactDecimal(mark) },
                  { label: t('Funding index now'), value: indexNow },
                  { label: t('Funding last period'), value: lastPeriod },
                  { label: t('Funding period'), value: f.periodId ?? stripData?.fundingPeriodId ?? null, mono: true },
                  {
                    label: t('Funding mark source'),
                    value: typeof stripData?.markSource === 'string' ? stripData.markSource : null,
                  },
                ]}
              />
              <p className="m-0 px-3 py-2 text-xs text-fg-2">{t('Funding built from')}</p>
            </>
          );
        }}
      </LoadGate>

      <TabHeader title={t('Funding estimates title')} load={positions} staleAfterMs={STALE_AFTER_MS.positions} />
      <LoadGate load={positions} thing={t('Thing positions')}>
        {(all) => {
          const live = stableOrder(all.filter(isLive));
          return (
            <>
              <Table
                label={t('Funding estimates table')}
                density="dense"
                columns={columns}
                rows={live}
                getRowId={(p) => p.id ?? `${p.symbol}:${p.timestamp}`}
                emptyState={<EmptyState size="inline" title={t('Funding estimates empty')} />}
              />
              <p className="m-0 px-3 py-2 text-xs text-fg-2">
                {t('Funding estimate note')}
                {rate === null
                  ? ` ${t('Funding none reason')}`
                  : live.some((p) => !sameContract(p.symbol, symbol))
                    ? ` ${t('Funding other contract')}`
                    : ''}
              </p>
            </>
          );
        }}
      </LoadGate>

      <TabHeader title={t('Funding payments title')} load={statement} />
      <LoadGate load={statement} thing={t('Thing funding records')}>
        {(s: FundingStatement) => (
          <>
            <Table
              label={t('Funding payments table')}
              density="dense"
              columns={paymentColumns}
              rows={s.rows}
              getRowId={(r) => `${r.positionId}:${r.periodId}`}
              emptyState={<EmptyState size="inline" title={t('Funding payments empty')} />}
            />
            <div className="px-3 py-2">
              <Button variant="secondary" size={32} onClick={() => setStatementOpen((open) => !open)} aria-expanded={statementOpen}>
                {statementOpen ? t('Funding statement hide') : t('Funding statement')}
              </Button>
            </div>
            {statementOpen ? (
              <section aria-label={t('Funding statement')} className="flex flex-col">
                <h3 className="m-0 px-3 pt-2 pb-1 text-sm font-medium text-fg">{t('Funding statement')}</h3>
                <p className="m-0 px-3 pb-2 text-xs text-fg-2">{t('Funding statement note')}</p>
                <Table
                  label={t('Funding statement')}
                  density="dense"
                  columns={statementColumns}
                  rows={s.rows}
                  getRowId={(r) => `${r.positionId}:${r.periodId}`}
                  emptyState={<EmptyState size="inline" title={t('Funding statement empty')} />}
                />
                {s.totals.map((total) => (
                  <KeyValue
                    key={total.asset}
                    density="dense"
                    className="px-3"
                    items={[
                      { label: t('Funding total paid'), value: withAsset(exactDecimal(total.paid), total.asset) },
                      { label: t('Funding total received'), value: withAsset(exactDecimal(total.received), total.asset) },
                      { label: t('Funding net'), value: withAsset(exactDecimal(total.net), total.asset) },
                    ]}
                  />
                ))}
              </section>
            ) : null}
          </>
        )}
      </LoadGate>

      <TabHeader title={t('Funding history title')} load={history.rates} />
      <LoadGate
        load={history.rates}
        thing={t('Thing funding records')}
        empty={<EmptyState size="inline" title={t('Choose a contract')} />}
        refused={(code) =>
          code === 'trade.funding_rate_unavailable' ? <EmptyState size="inline" title={t('Funding history empty')} /> : null
        }
      >
        {(h) => (
          <Table
            label={t('Funding history title')}
            density="dense"
            columns={historyColumns}
            rows={[...h.rates].reverse()}
            getRowId={(r) => r.periodId}
            emptyState={<EmptyState size="inline" title={t('Funding history empty')} />}
          />
        )}
      </LoadGate>

      <TabHeader title={t('Funding series title')} load={history.series} />
      <LoadGate
        load={history.series}
        thing={t('Thing funding records')}
        empty={<EmptyState size="inline" title={t('Choose a contract')} />}
      >
        {(s) => (
          <Table
            label={t('Funding series title')}
            density="dense"
            columns={seriesColumns}
            rows={[...s.series].reverse()}
            getRowId={(p) => p.at}
            emptyState={<EmptyState size="inline" title={t('Funding series empty')} />}
          />
        )}
      </LoadGate>
    </section>
  );
}
