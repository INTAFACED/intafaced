import { Tag } from '@intafaced/ui/lit';
import { Table, type Column } from '@intafaced/ui/lit/templates';
import { fmtAmount, refusalCopy } from '../../../data';
import type { ConvertHistoryRow } from '../../../features/trade/tool-api';
import { usePreferences } from '../../../shared/preferences';
import { dayTime } from '../desk/time';
import { KitState } from '../kit-parts';
import { convertCopy } from './copy';
import { recentAt } from './recent';
import { useRecentConversions } from './use-recent';

const ACTIVITY_HREF = '/money/activity?tab=all';

const TONE = { settled: 'accent', accepted: 'warn', refused: 'error', unknown: 'warn', quoted: 'neutral', expired: 'neutral' } as const;

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

  const columns: Column<ConvertHistoryRow>[] = [
    { key: 'time', label: t('Time'), cell: (row) => dayTime(Date.parse(recentAt(row)), timeZone) },
    {
      key: 'paid',
      label: t('You paid'),
      align: 'end',
      cell: (row) => `${fmtAmount(row.inAmount, { places: 8 })} ${row.inAsset}`,
    },
    {
      key: 'received',
      label: t('You received'),
      align: 'end',
      cell: (row) => `${fmtAmount(row.outAmount, { places: 8 })} ${row.outAsset}`,
    },
    { key: 'status', label: t('Status'), cell: (row) => <Tag tone={TONE[row.lifecycle]}>{statusWord(row)}</Tag> },
  ];

  const refused = recent.status === 'refused' ? refusalCopy(recent.code) : null;

  return (
    <section className="lt-stack" aria-labelledby="cvt-recent-title" data-testid="cvt-recent">
      <div className="lt-toolbar">
        <h2 id="cvt-recent-title">{t('Recent conversions')}</h2>
        <a className="lt-link" href={ACTIVITY_HREF}>
          {t('View activity')}
        </a>
      </div>
      {refused ? (
        <KitState
          kind="refused"
          title={refused.title}
          body={refused.body}
          code={refused.reference}
          action={refused.action ? { label: refused.action.label, href: refused.action.href } : undefined}
        />
      ) : recent.status === 'error' ? (
        <KitState kind="error" title={t('Recent error title')} onRetry={recent.retry} retryLabel={t('Retry')} />
      ) : recent.status === 'loading' ? (
        <KitState kind="loading" rows={3} label={t('Recent label')} />
      ) : (
        <Table
          caption={t('Recent label')}
          dense
          columns={columns}
          rows={recent.status === 'ready' ? recent.rows : []}
          rowKey={(row) => row.quoteId}
          empty={<KitState kind="empty" title={t('Recent empty title')} body={t('Recent empty body')} />}
        />
      )}
      {recent.status === 'ready' && recent.more ? <p className="lt-hint">{t('Recent more')}</p> : null}
    </section>
  );
}
