import type { Position } from '@intafaced/exchange-contract/schemas';
import { Amount, ChangeText } from '@intafaced/ui/lit';
import { KeyValue, Table, type Column } from '@intafaced/ui/lit/templates';
import { fmtAmount, fmtPct, fmtPrice } from '../../../data/format';
import type { Loadable } from '../../../data/types';
import { usePreferences } from '../../../shared/preferences';
import { dayTime } from '../desk/time';
import type { FundingRate, TickerStrip } from './api';
import { STALE_AFTER_MS } from './data';
import { fundingEstimate, isLive, stableOrder } from './model';
import { LoadGate, SideBadge, TabHeader } from './HistoryTab';
import { tabsCopy } from './tabs-copy';
import { countdownText, nextFundingAt, sameContract, signedAmount } from './tabs-logic';
import { kvRows } from './kv-rows';
import { RegionNote } from './notes';

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
  const stripData = strip.status === 'ready' ? strip.data : null;
  const rate = funding.status === 'ready' ? funding.data.fundingRate : null;

  const noRate = <RegionNote variant="unavailable" title={t('Funding none title')} reason={t('Funding none reason')} />;

  const columns: Column<Position>[] = [
    { key: 'contract', label: t('Contract'), cell: (p) => p.symbol },
    { key: 'side', label: t('Side'), cell: (p) => <SideBadge side={p.side} /> },
    { key: 'notional', label: t('Notional'), align: 'end', cell: (p) => <Amount value={fmtAmount(p.notional, { places: 4 })} /> },
    {
      key: 'estimate',
      label: t('Funding estimate col'),
      align: 'end',
      // The rate belongs to one contract: another contract's position gets no figure rather than a wrong one.
      cell: (p) => {
        const value = sameContract(p.symbol, symbol) ? fundingEstimate(p, rate) : null;
        return <ChangeText value={value === null ? null : signedAmount(value)} title={t('Funding estimate label')} />;
      },
    },
  ];

  return (
    <section aria-label={t('Funding heading')} className="lt-stack">
      <TabHeader title={t('Funding heading')} load={funding} />
      <LoadGate
        load={funding}
        thing={t('Thing funding')}
        empty={<RegionNote title={t('Choose a contract')} />}
        refused={(code) => (code === 'trade.funding_rate_unavailable' ? noRate : null)}
      >
        {(f) => {
          const nextAt = nextFundingAt(f.nextFundingTimestamp, stripData?.nextFundingTime);
          const mark = f.markPrice ?? stripData?.markPrice ?? null;
          return (
            <KeyValue
              rows={kvRows([
                { label: t('Funding rate'), value: fmtPct(f.fundingRate, { places: 4 }), asOf: f.fundingTimestamp },
                { label: t('Funding next'), value: nextAt === null ? null : dayTime(nextAt, timeZone) },
                { label: t('Funding countdown'), value: countdownText(nextAt, now) },
                { label: t('Funding mark'), value: mark === null ? null : fmtPrice(mark, undefined) },
                { label: t('Funding index'), value: f.indexPrice === null ? null : fmtPrice(f.indexPrice, undefined) },
                { label: t('Funding period'), value: stripData?.fundingPeriodId ?? null, mono: true },
                {
                  label: t('Funding mark source'),
                  value: typeof stripData?.markSource === 'string' ? stripData.markSource : null,
                },
              ])}
            />
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
                caption={t('Funding estimates table')}
                mode="pro"
                dense
                columns={columns}
                rows={live}
                rowKey={(p) => p.id ?? `${p.symbol}:${p.timestamp}`}
                empty={<RegionNote title={t('Funding estimates empty')} />}
              />
              <p className="lt-note">
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

      <h3 className="lt-panel-title">{t('Funding payments title')}</h3>
      <RegionNote variant="unavailable" title={t('Funding payments title')} reason={t('Funding payments reason')} />
    </section>
  );
}
