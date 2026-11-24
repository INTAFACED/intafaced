import type { Position } from '@intafaced/exchange-contract/schemas';
import { Table, type Column } from '@intafaced/ui/lit/templates';
import { UNKNOWN } from '../../../data/format';
import type { Loadable } from '../../../data/types';
import { usePreferences } from '../../../shared/preferences';
import { dayTime } from '../desk/time';
import { MARGIN_CALL_CAP, STALE_AFTER_MS, type MarginCalls } from './data';
import { LoadGate, SideBadge, TabHeader } from './HistoryTab';
import { bpsToPct, isLive, stableOrder } from './model';
import { tabsCopy } from './tabs-copy';
import { pastCallCap } from './tabs-logic';
import { RegionNote } from './notes';

export function MarginCallsTab({ positions, calls }: { positions: Loadable<Position[]>; calls: Loadable<MarginCalls> }) {
  const { t } = tabsCopy.useCopy();
  const { timeZone } = usePreferences();
  const callOf = (p: Position) => (calls.status === 'ready' && p.id !== null ? calls.data[p.id] : undefined);
  // A call the service has not delivered is a real answer (null); a position past the cap was not asked (undefined).
  const none = (p: Position) => (callOf(p) === undefined ? t('Calls not checked') : t('Calls none'));
  const time = (iso: string | undefined) => (iso === undefined ? null : dayTime(Date.parse(iso), timeZone));

  const columns: Column<Position>[] = [
    { key: 'contract', label: t('Contract'), cell: (p) => p.symbol },
    { key: 'side', label: t('Side'), cell: (p) => <SideBadge side={p.side} /> },
    {
      key: 'sequence',
      label: t('Calls sequence'),
      align: 'end',
      cell: (p) => {
        const call = callOf(p);
        return call ? String(call.sequence) : <span className="lt-quiet">{none(p)}</span>;
      },
    },
    {
      key: 'health',
      label: t('Calls health'),
      align: 'end',
      cell: (p) => {
        const c = callOf(p);
        return c ? `${bpsToPct(c.healthBps)}%` : UNKNOWN;
      },
    },
    { key: 'called', label: t('Calls called'), cell: (p) => time(callOf(p)?.calledAt) ?? UNKNOWN },
    { key: 'delivered', label: t('Calls delivered'), cell: (p) => time(callOf(p)?.deliveredAt) ?? UNKNOWN },
  ];

  return (
    <section aria-label={t('Calls heading')} className="lt-stack">
      <TabHeader title={t('Calls heading')} load={calls} staleAfterMs={STALE_AFTER_MS.positions * 2} />
      <LoadGate load={positions} thing={t('Thing positions')}>
        {(all) => {
          const live = stableOrder(all.filter(isLive));
          return (
            <LoadGate load={calls} thing={t('Thing calls')}>
              {() => (
                <>
                  <Table
                    caption={t('Calls table')}
                    mode="pro"
                    dense
                    columns={columns}
                    rows={live}
                    rowKey={(p) => p.id ?? `${p.symbol}:${p.timestamp}`}
                    empty={<RegionNote title={t('Calls empty')} />}
                  />
                  {pastCallCap(live.length, MARGIN_CALL_CAP) ? (
                    <p className="lt-note">{t('Calls cap note', { cap: String(MARGIN_CALL_CAP), count: String(live.length) })}</p>
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
