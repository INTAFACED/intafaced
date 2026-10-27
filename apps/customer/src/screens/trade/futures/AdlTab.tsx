import type { Position } from '@intafaced/exchange-contract/schemas';
import { Amount, Badge, EmptyState, Table, type TableColumn } from '@intafaced/ui';
import { fmtAmount } from '../../../data/format';
import type { Loadable } from '../../../data/types';
import { usePreferences } from '../../../shared/preferences';
import { dayTime } from '../desk/time';
import type { AdlDisclosure, AdlEvent } from './api';
import { LoadGate, SideBadge, TabHeader } from './HistoryTab';
import { tabsCopy } from './tabs-copy';
import { liquidatedRows } from './tabs-logic';

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

  const eventColumns: TableColumn<AdlEvent>[] = [
    { id: 'at', header: t('ADL time'), value: (e) => dayTime(Date.parse(e.at), timeZone) },
    { id: 'event', header: t('ADL event id'), cell: (e) => <span className="if-mono">{e.eventId}</span> },
    { id: 'version', header: t('ADL version col'), value: (e) => e.version },
    { id: 'bankrupt', header: t('ADL bankrupt'), cell: (e) => <span className="if-mono">{e.bankruptPositionId}</span> },
    { id: 'candidate', header: t('ADL candidate'), cell: (e) => <span className="if-mono">{e.candidatePositionId}</span> },
    { id: 'size', header: t('ADL size'), numeric: true, cell: (e) => <Amount value={fmtAmount(e.sizeToReduce, { places: 8 })} /> },
    { id: 'disclosed', header: t('ADL disclosed'), cell: () => <Badge tone="lime">{t('ADL disclosed')}</Badge> },
  ];

  const liquidationColumns: TableColumn<Position>[] = [
    { id: 'contract', header: t('Contract'), value: (p) => p.symbol },
    { id: 'side', header: t('Side'), cell: (p) => <SideBadge side={p.side} /> },
    { id: 'size', header: t('Size'), numeric: true, cell: (p) => <Amount value={fmtAmount(p.contracts, { places: 8 })} /> },
    { id: 'when', header: t('Closed at'), value: (p) => dayTime(p.timestamp, timeZone) },
    { id: 'status', header: t('Status'), cell: () => <Badge tone="error">{t('Liquidated')}</Badge> },
  ];

  return (
    <section aria-label={t('ADL notice heading')} className="flex flex-col">
      <TabHeader title={t('ADL notice heading')} load={disclosure} />
      <LoadGate load={disclosure} thing={t('Thing disclosure')}>
        {(d) => (
          <div className="flex flex-col gap-2 px-3 pb-3">
            <p className="m-0 text-sm text-fg">{d.copy}</p>
            <div className="flex flex-wrap items-center gap-2 text-xs text-fg-2">
              <span>{t('ADL version', { version: d.version })}</span>
            </div>
          </div>
        )}
      </LoadGate>

      <TabHeader title={t('ADL events heading')} load={events} />
      <LoadGate load={events} thing={t('Thing events')}>
        {(rows) => (
          <Table
            label={t('ADL events table')}
            density="dense"
            columns={eventColumns}
            rows={rows}
            getRowId={(e) => e.eventId}
            emptyState={<EmptyState size="inline" title={t('ADL events empty')} />}
          />
        )}
      </LoadGate>

      <TabHeader title={t('Liquidations heading')} load={closed} />
      <LoadGate load={closed} thing={t('Thing history')}>
        {(all) => (
          <Table
            label={t('Liquidations table')}
            density="dense"
            columns={liquidationColumns}
            rows={liquidatedRows(all)}
            getRowId={(p) => p.id ?? `${p.symbol}:${p.timestamp}`}
            emptyState={<EmptyState size="inline" title={t('Liquidations empty')} />}
          />
        )}
      </LoadGate>
      <EmptyState
        variant="unavailable"
        size="inline"
        title={t('Liquidations unavailable title')}
        reason={t('Liquidations unavailable reason')}
      />
    </section>
  );
}
