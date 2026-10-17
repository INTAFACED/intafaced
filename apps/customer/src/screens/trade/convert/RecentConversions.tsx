import { useMemo } from 'react';
import { fmtAmount, refusalCopy } from '../buy/deps';
import { Badge, EmptyState, StatusChip, Table, useActivity, type TableColumn } from './deps';
import { convertCopy } from './copy';
import { recentConversions, type RecentConversion } from './recent';

const ACTIVITY_HREF = '/money/activity?tab=all';
/** How long a read of the ledger counts as fresh before the chip says Stale. */
const FRESH_MS = 60_000;

const when = (iso: string): string => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
};

/** Recent conversions (TRMKT R3): the signed-in person's last conversions, from the same ledger read Activity uses. */
export function RecentConversions() {
  const { t } = convertCopy.useCopy();
  const activity = useActivity();
  const rows = useMemo(() => (activity.status === 'ready' ? recentConversions(activity.data.items) : []), [activity]);

  const columns: TableColumn<RecentConversion>[] = [
    { id: 'time', header: t('Time'), cell: (row) => <time dateTime={row.at}>{when(row.at)}</time>, width: 200 },
    {
      id: 'from',
      header: t('From'),
      cell: (row) => `${fmtAmount(row.fromAmount, { places: 18 })} ${row.fromAsset}`,
    },
    {
      id: 'to',
      header: t('To'),
      cell: (row) => `${fmtAmount(row.toAmount, { places: 18 })} ${row.toAsset}`,
    },
    { id: 'status', header: t('Status'), cell: () => <Badge tone="lime">{t('Settled')}</Badge>, width: 120 },
  ];

  const refused = activity.status === 'refused' ? refusalCopy(activity.code) : null;
  const tableStatus = activity.status === 'loading' ? 'loading' : activity.status === 'error' ? 'error' : 'ready';

  return (
    <section className="cvt-recent" aria-labelledby="cvt-recent-title" data-testid="cvt-recent">
      <div className="cvt-recent__head">
        <h2 id="cvt-recent-title">{t('Recent conversions')}</h2>
        {activity.status === 'ready' ? <StatusChip asOf={activity.asOf} staleAfterMs={FRESH_MS} density="dense" /> : null}
        <a className="cvt-recent__all" href={ACTIVITY_HREF}>
          {t('View activity')}
        </a>
      </div>
      {refused ? (
        <EmptyState
          variant="refused"
          title={refused.title}
          reason={refused.body}
          code={refused.reference}
          action={refused.action ? { label: refused.action.label, href: refused.action.href } : undefined}
        />
      ) : (
        <Table
          label={t('Recent conversions')}
          density="dense"
          columns={columns}
          rows={rows}
          getRowId={(row) => row.id}
          status={tableStatus}
          loadingRows={3}
          onRetry={activity.status === 'error' ? activity.retry : undefined}
          emptyState={
            <EmptyState
              size="inline"
              title={t('No conversions yet')}
              reason={t('No conversions body')}
              action={{ label: t('View activity'), href: ACTIVITY_HREF, variant: 'ghost' }}
            />
          }
          errorState={
            <EmptyState
              size="inline"
              variant="unavailable"
              title={t('Recent error title')}
              reason={t('Recent error body')}
              action={activity.status === 'error' ? { label: t('Retry'), onClick: activity.retry, variant: 'secondary' } : undefined}
            />
          }
        />
      )}
    </section>
  );
}
