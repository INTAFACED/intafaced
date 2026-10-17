import type { Position } from '@intafaced/exchange-contract/schemas';
import { EmptyState, Table, type TableColumn } from '@intafaced/ui';
import type { Loadable } from '../../../data/types';
import { usePreferences } from '../../../shared/preferences';
import { dayTime } from '../desk/time';
import { MARGIN_CALL_CAP, STALE_AFTER_MS, type MarginCalls } from './data';
import { LoadGate, SideBadge, TabHeader } from './HistoryTab';
import { bpsToPct, isLive, stableOrder } from './model';
import { tabsCopy } from './tabs-copy';
import { pastCallCap } from './tabs-logic';

export function MarginCallsTab({ positions, calls }: { positions: Loadable<Position[]>; calls: Loadable<MarginCalls> }) {
  const { t } = tabsCopy.useCopy();
  const { timeZone } = usePreferences();
  const callOf = (p: Position) => (calls.status === 'ready' && p.id !== null ? calls.data[p.id] : undefined);
  // A call the service has not delivered is a real answer (null); a position past the cap was not asked (undefined).
  const none = (p: Position) => (callOf(p) === undefined ? t('Calls not checked') : t('Calls none'));
  const time = (iso: string | undefined) => (iso === undefined ? null : dayTime(Date.parse(iso), timeZone));

  const columns: TableColumn<Position>[] = [
    { id: 'contract', header: t('Contract'), value: (p) => p.symbol },
    { id: 'side', header: t('Side'), cell: (p) => <SideBadge side={p.side} /> },
    {
      id: 'sequence',
      header: t('Calls sequence'),
      numeric: true,
      cell: (p) => {
        const call = callOf(p);
        return call ? String(call.sequence) : <span className="text-fg-2">{none(p)}</span>;
      },
    },
    {
      id: 'health',
      header: t('Calls health'),
      numeric: true,
      value: (p) => {
        const c = callOf(p);
        return c ? `${bpsToPct(c.healthBps)}%` : null;
      },
    },
    { id: 'called', header: t('Calls called'), value: (p) => time(callOf(p)?.calledAt) },
    { id: 'delivered', header: t('Calls delivered'), value: (p) => time(callOf(p)?.deliveredAt) },
  ];

  return (
    <section aria-label={t('Calls heading')} className="flex flex-col">
      <TabHeader title={t('Calls heading')} load={calls} staleAfterMs={STALE_AFTER_MS.positions * 2} />
      <LoadGate load={positions} thing={t('Thing positions')}>
        {(all) => {
          const live = stableOrder(all.filter(isLive));
          return (
            <LoadGate load={calls} thing={t('Thing calls')}>
              {() => (
                <>
                  <Table
                    label={t('Calls table')}
                    density="dense"
                    columns={columns}
                    rows={live}
                    getRowId={(p) => p.id ?? `${p.symbol}:${p.timestamp}`}
                    emptyState={<EmptyState size="inline" title={t('Calls empty')} />}
                  />
                  {pastCallCap(live.length, MARGIN_CALL_CAP) ? (
                    <p className="m-0 px-3 py-2 text-xs text-fg-2">
                      {t('Calls cap note', { cap: String(MARGIN_CALL_CAP), count: String(live.length) })}
                    </p>
                  ) : null}
                </>
              )}
            </LoadGate>
          );
        }}
      </LoadGate>
    </section>
  );
}
