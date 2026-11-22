import { fmtAmount, refusalCopy } from '../buy/deps';
import { dayTime } from '../desk/time';
import { usePreferences } from '../../../shared/preferences';
import { Button, EmptyState, RefusalBox } from '@intafaced/ui/lit';
import { Skeleton, StatusChip } from '@intafaced/ui/lit/templates';
import { convertCopy } from './copy';
import { recentAt } from './recent';
import { useRecentConversions } from './use-recent';
import type { ConvertHistoryRow } from '../../../features/trade/tool-api';

const ACTIVITY_HREF = '/money/activity?tab=all';

const STATUS = {
  settled: 'done',
  accepted: 'pending',
  refused: 'failed',
  unknown: 'unknown',
  quoted: 'unknown',
  expired: 'unknown',
} as const;

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

  const refused = recent.status === 'refused' ? refusalCopy(recent.code) : null;

  const rows = recent.status === 'ready' ? recent.rows : [];

  return (
    <section aria-labelledby="cvt-recent-title" data-testid="cvt-recent">
      <div className="lt-title-row">
        <h2 id="cvt-recent-title">{t('Recent conversions')}</h2>
        <a className="lt-link" href={ACTIVITY_HREF}>
          {t('View activity')}
        </a>
      </div>
      {refused ? (
        <RefusalBox
          refusal={{
            variant: 'refused',
            title: refused.title,
            body: refused.body,
            ...(refused.reference ? { reference: refused.reference } : {}),
            ...(refused.action ? { action: { label: refused.action.label, href: refused.action.href } } : {}),
          }}
        />
      ) : recent.status === 'error' ? (
        <RefusalBox refusal={{ variant: 'unreachable', title: t('Recent error title'), body: t('Recent error body') }}>
          <Button onClick={recent.retry}>{t('Retry')}</Button>
        </RefusalBox>
      ) : recent.status === 'loading' ? (
        <Skeleton shape="rows" count={3} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('Recent empty title')} body={t('Recent empty body')} />
      ) : (
        <table className="lt-table" data-mode="simple">
          <caption className="lt-sr">{t('Recent label')}</caption>
          <thead>
            <tr>
              <th scope="col" data-align="start">
                {t('Time')}
              </th>
              <th scope="col" data-align="end">
                {t('You paid')}
              </th>
              <th scope="col" data-align="end">
                {t('You received')}
              </th>
              <th scope="col" data-align="start">
                {t('Status')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.quoteId}>
                <td data-label={t('Time')} data-cell="time" data-align="start">
                  {dayTime(Date.parse(recentAt(row)), timeZone)}
                </td>
                <td data-label={t('You paid')} data-cell="paid" data-align="end">
                  {fmtAmount(row.inAmount, { places: 8 })} {row.inAsset}
                </td>
                <td data-label={t('You received')} data-cell="received" data-align="end">
                  {fmtAmount(row.outAmount, { places: 8 })} {row.outAsset}
                </td>
                <td data-label={t('Status')} data-cell="status" data-align="start">
                  <StatusChip status={STATUS[row.lifecycle]} label={statusWord(row)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {recent.status === 'ready' && recent.more ? <p className="lt-hint">{t('Recent more')}</p> : null}
    </section>
  );
}
