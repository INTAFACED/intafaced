import type { ReactNode } from 'react';
import type { Position } from '@intafaced/exchange-contract/schemas';
import { Amount, Badge, Button, ChangeText, EmptyState, Price, StateBlock, StatusChip, Table, type TableColumn } from '@intafaced/ui';
import { fmtAmount, fmtPrice } from '../../../data/format';
import type { Loadable } from '../../../data/types';
import { usePreferences } from '../../../shared/preferences';
import { dayTime } from '../desk/time';
import { STALE_AFTER_MS } from './data';
import { stateOf } from './model';
import { futuresRefusal } from './refusals';
import { tabsCopy } from './tabs-copy';
import { historyCsv, historyRows, signedAmount } from './tabs-logic';

/**
 * Shared by the five tabs: one place that turns a Loadable into the honest state of a region (loading, refused,
 * signed out, error with retry) so no tab invents its own wording. `ready` hands the data to the caller.
 */
export function LoadGate<T>({
  load,
  thing,
  empty,
  refused,
  children,
}: {
  load: Loadable<T>;
  thing: string;
  /** What `empty` means for this region (the read is switched off, e.g. no contract chosen). */
  empty?: ReactNode;
  /** A region-specific answer for a refusal code; return null to use the general words. */
  refused?: (code: string) => ReactNode | null;
  children: (data: T) => ReactNode;
}) {
  const { t } = tabsCopy.useCopy();
  if (load.status === 'loading') return <StateBlock kind="loading" rows={4} rowHeight={28} label={t('Couldn’t load', { thing })} />;
  if (load.status === 'empty') return <>{empty ?? <EmptyState size="inline" title={t('Nothing to show')} />}</>;
  if (load.status === 'error')
    return <StateBlock kind="error" title={t('Couldn’t load', { thing })} onRetry={load.retry} retryLabel={t('Try again')} />;
  if (load.status === 'refused') {
    if (load.code === 'auth.required')
      return (
        <EmptyState
          variant="refused"
          size="inline"
          title={t('Sign in title')}
          reason={t('Sign in body')}
          action={{ label: t('Sign in'), href: `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}` }}
        />
      );
    const special = refused?.(load.code);
    if (special) return <>{special}</>;
    const words = futuresRefusal({ code: load.code });
    return <EmptyState variant="refused" size="inline" title={words.title} reason={words.body} code={words.code ?? undefined} />;
  }
  return <>{children(load.data)}</>;
}

/** Title on the left, the data-freshness chip on the right. The chip appears once there is a read to date. */
export function TabHeader({
  title,
  load,
  staleAfterMs = STALE_AFTER_MS.funding,
}: {
  title: string;
  load: Loadable<unknown>;
  staleAfterMs?: number;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <h3 className="m-0 text-sm font-medium text-fg">{title}</h3>
      {load.status === 'ready' ? (
        <StatusChip asOf={load.asOf} staleAfterMs={staleAfterMs} showAsOf />
      ) : load.status === 'refused' ? (
        <StatusChip refused />
      ) : null}
    </div>
  );
}

export function SideBadge({ side }: { side: 'long' | 'short' }) {
  const { t } = tabsCopy.useCopy();
  return <Badge variant="outline">{side === 'long' ? t('Long') : t('Short')}</Badge>;
}

/** Hand the text to the browser as a file. Client side only: nothing is sent anywhere. */
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function HistoryTab({ closed }: { closed: Loadable<Position[]> }) {
  const { t } = tabsCopy.useCopy();
  const { timeZone } = usePreferences();
  const columns: TableColumn<Position>[] = [
    { id: 'contract', header: t('Contract'), value: (p) => p.symbol },
    { id: 'side', header: t('Side'), cell: (p) => <SideBadge side={p.side} /> },
    { id: 'size', header: t('Size'), numeric: true, cell: (p) => <Amount value={fmtAmount(p.contracts, { places: 8 })} /> },
    { id: 'entry', header: t('Entry'), numeric: true, cell: (p) => <Price value={fmtPrice(p.entryPrice, undefined)} /> },
    { id: 'exit', header: t('Exit'), numeric: true, cell: (p) => <Price value={fmtPrice(p.markPrice, undefined)} /> },
    {
      id: 'pnl',
      header: t('Realised PnL'),
      numeric: true,
      cell: (p) => <ChangeText value={p.realizedPnl === null ? null : signedAmount(p.realizedPnl)} />,
    },
    // What the position's fills paid in trading fees; a dash where the service recorded none.
    { id: 'fees', header: t('Fees'), numeric: true, cell: (p) => <Amount value={fmtAmount(p.fees, { places: 8 })} /> },
    {
      id: 'status',
      header: t('Status'),
      cell: (p) => {
        const state = stateOf(p);
        return state === 'liquidated' ? (
          <Badge tone="error">{t('Liquidated')}</Badge>
        ) : (
          <Badge>{state === 'closed' ? t('Closed') : t('Closing')}</Badge>
        );
      },
    },
    { id: 'closed', header: t('Closed at'), value: (p) => dayTime(p.timestamp, timeZone) },
  ];
  return (
    <section aria-label={t('History table')} className="flex flex-col">
      <TabHeader title={t('History heading')} load={closed} />
      <LoadGate load={closed} thing={t('Thing history')}>
        {(all) => {
          const rows = historyRows(all);
          return (
            <>
              <Table
                label={t('History table')}
                density="dense"
                columns={columns}
                rows={rows}
                getRowId={(p) => p.id ?? `${p.symbol}:${p.timestamp}`}
                emptyState={<EmptyState size="inline" title={t('History empty title')} reason={t('History empty reason')} />}
              />
              <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                <p className="m-0 text-xs text-fg-2">{t('History footer')}</p>
                <Button
                  variant="secondary"
                  size={28}
                  disabled={rows.length === 0}
                  onClick={() => download(t('History export file'), historyCsv(rows))}
                >
                  {t('History export')}
                </Button>
              </div>
            </>
          );
        }}
      </LoadGate>
    </section>
  );
}
