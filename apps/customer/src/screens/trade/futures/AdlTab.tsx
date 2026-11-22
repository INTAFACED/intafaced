import type { Position } from '@intafaced/exchange-contract/schemas';
import { Amount, Badge } from '@intafaced/ui/lit';
import { Table, type Column } from '@intafaced/ui/lit/templates';
import { fmtAmount } from '../../../data/format';
import type { Loadable } from '../../../data/types';
import { usePreferences } from '../../../shared/preferences';
import { dayTime } from '../desk/time';
import type { AdlDisclosure, AdlEvent } from './api';
import { LoadGate, SideBadge, TabHeader } from './HistoryTab';
import { tabsCopy } from './tabs-copy';
import { liquidatedRows } from './tabs-logic';
import { RegionNote } from './notes';

export function AdlTab({
  disclosure,
  events,
  closed,
}: {
  disclosure: Loadable<AdlDisclosure>;
  events: Loadable<AdlEvent[]>;
  closed: Loadable<Position[]>;
}) {
  const { t } = tabsCopy.useCopy();
  const { timeZone } = usePreferences();

  const eventColumns: Column<AdlEvent>[] = [
    { key: 'at', label: t('ADL time'), cell: (e) => dayTime(Date.parse(e.at), timeZone) },
    { key: 'event', label: t('ADL event id'), cell: (e) => <span className="lt-mono">{e.eventId}</span> },
    { key: 'version', label: t('ADL version col'), cell: (e) => e.version },
    { key: 'bankrupt', label: t('ADL bankrupt'), cell: (e) => <span className="lt-mono">{e.bankruptPositionId}</span> },
    { key: 'candidate', label: t('ADL candidate'), cell: (e) => <span className="lt-mono">{e.candidatePositionId}</span> },
    { key: 'size', label: t('ADL size'), align: 'end', cell: (e) => <Amount value={fmtAmount(e.sizeToReduce, { places: 8 })} /> },
    { key: 'disclosed', label: t('ADL disclosed'), cell: () => <Badge tone="accent">{t('ADL disclosed')}</Badge> },
  ];

  const liquidationColumns: Column<Position>[] = [
    { key: 'contract', label: t('Contract'), cell: (p) => p.symbol },
    { key: 'side', label: t('Side'), cell: (p) => <SideBadge side={p.side} /> },
    { key: 'size', label: t('Size'), align: 'end', cell: (p) => <Amount value={fmtAmount(p.contracts, { places: 8 })} /> },
    { key: 'when', label: t('Closed at'), cell: (p) => dayTime(p.timestamp, timeZone) },
    { key: 'status', label: t('Status'), cell: () => <Badge tone="error">{t('Liquidated')}</Badge> },
  ];

  return (
    <section aria-label={t('ADL notice heading')} className="lt-stack">
      <TabHeader title={t('ADL notice heading')} load={disclosure} />
      <LoadGate load={disclosure} thing={t('Thing disclosure')}>
        {(d) => (
          <div className="lt-stack-tight">
            <p className="lt-text">{d.copy}</p>
            <div className="lt-row lt-note">
              <span>{t('ADL version', { version: d.version })}</span>
            </div>
          </div>
        )}
      </LoadGate>

      <TabHeader title={t('ADL events heading')} load={events} />
      <LoadGate load={events} thing={t('Thing events')}>
        {(rows) => (
          <Table
            caption={t('ADL events table')}
            mode="pro"
            dense
            columns={eventColumns}
            rows={rows}
            rowKey={(e) => e.eventId}
            empty={<RegionNote title={t('ADL events empty')} />}
          />
        )}
      </LoadGate>

      <TabHeader title={t('Liquidations heading')} load={closed} />
      <LoadGate load={closed} thing={t('Thing history')}>
        {(all) => (
          <Table
            caption={t('Liquidations table')}
            mode="pro"
            dense
            columns={liquidationColumns}
            rows={liquidatedRows(all)}
            rowKey={(p) => p.id ?? `${p.symbol}:${p.timestamp}`}
            empty={<RegionNote title={t('Liquidations empty')} />}
          />
        )}
      </LoadGate>
      <RegionNote variant="unavailable" title={t('Liquidations unavailable title')} reason={t('Liquidations unavailable reason')} />
    </section>
  );
}
