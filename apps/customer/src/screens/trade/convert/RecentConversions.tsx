import { fmtAmount, refusalCopy } from '../buy/deps';
import { dayTime } from '../desk/time';
import { usePreferences } from '../../../shared/preferences';
import { Badge, EmptyState, Table, type TableColumn } from './deps';
import { convertCopy } from './copy';
import { recentAt } from './recent';
import { useRecentConversions } from './use-recent';
import type { ConvertHistoryRow } from '../../../features/trade/tool-api';

const ACTIVITY_HREF = '/money/activity?tab=all';

const TONE = { settled: 'lime', accepted: 'warn', refused: 'error', unknown: 'warn', quoted: 'neutral', expired: 'neutral' } as const;

/**
 * Recent conversions (TRMKT R3): the customer's own convert history from the trade service, newest first. Nothing is
 * listed from Activity, which cannot tell a conversion from a zero-fee spot order. A refused or failed read keeps its
 * own typed state and never reads as "none".
 */
export function RecentConversions() {
  const { t } = convertCopy.useCopy();
  const { timeZone } = usePreferences();
  const recent = useRecentConversions();

  const statusWord = (row: ConvertHistoryRow): string =>
    row.lifecycle === 'settled'
      ? t('Settled')
      : row.lifecycle === 'accepted'
        ? t('Recent accepted')
        : row.lifecycle === 'refused'
          ? t('Recent refused')
          : t('Recent unknown');

  const columns: TableColumn<ConvertHistoryRow>[] = [
    { id: 'time', header: t('Time'), value: (row) => dayTime(Date.parse(recentAt(row)), timeZone) },
    {
      id: 'paid',
      header: t('You paid'),
      numeric: true,
      value: (row) => row.inAmount,
      cell: (row) => `${fmtAmount(row.inAmount, { places: 8 })} ${row.inAsset}`,
    },
    {
      id: 'received',
      header: t('You received'),
      numeric: true,
      value: (row) => row.outAmount,
      cell: (row) => `${fmtAmount(row.outAmount, { places: 8 })} ${row.outAsset}`,
    },
    { id: 'status', header: t('Status'), cell: (row) => <Badge tone={TONE[row.lifecycle]}>{statusWord(row)}</Badge> },
  ];

  const refused = recent.status === 'refused' ? refusalCopy(recent.code) : null;

  return (
    <section className="cvt-recent" aria-labelledby="cvt-recent-title" data-testid="cvt-recent">
      <div className="cvt-recent__head">
        <h2 id="cvt-recent-title">{t('Recent conversions')}</h2>
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
      ) : recent.status === 'error' ? (
        <EmptyState
          size="inline"
          variant="unavailable"
          title={t('Recent error title')}
          reason={t('Recent error body')}
          action={{ label: t('Retry'), onClick: recent.retry, variant: 'secondary' }}
        />
      ) : (
        <Table
          label={t('Recent label')}
          density="dense"
          columns={columns}
          rows={recent.status === 'ready' ? recent.rows : []}
          getRowId={(row) => row.quoteId}
          status={recent.status === 'loading' ? 'loading' : 'ready'}
          loadingRows={3}
          emptyState={<EmptyState size="inline" variant="empty" title={t('Recent empty title')} reason={t('Recent empty body')} />}
        />
      )}
    </section>
  );
}
