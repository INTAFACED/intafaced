import { useResource } from '../../../../shared/resource';
import type { PortalApi } from '../api';
import { MoneyLines } from '../components';
import { dateRange } from '../ui/FilterRow';
import { portalCopy } from './copy';
import { refundsIssuedTotals } from './model';

export type RefundsWindow = 'today' | '7d' | '30d';

/**
 * Refunds made in a window, read from the refunds list. The headline "refunded" figure counts a refund on the day its
 * payment was taken, so this is the figure for "what did I give back today".
 */
export function RefundsIssuedValue({ portal, merchantId, when }: { portal: PortalApi; merchantId: string; when: RefundsWindow }) {
  const { t } = portalCopy.useCopy();
  const range = dateRange(when, Date.now());
  const read = useResource(
    (signal) => portal.refundsIssued(merchantId, range, signal),
    `portal:refunds-issued:${merchantId}:${when}:${range.from ?? ''}`,
  );
  if (read.resource.status === 'loading') return <span className="pp-none">…</span>;
  if (read.resource.status === 'failed')
    return (
      <>
        <span className="pp-none">—</span>
        <small className="pp-kpi-note"> {t('refundsIssuedFailed')}</small>
      </>
    );
  const { rows, complete } = read.resource.data;
  const totals = refundsIssuedTotals(rows);
  if (totals.length === 0) return <span className="pp-none">{t('refundsIssuedNone')}</span>;
  return (
    <>
      <MoneyLines items={totals} />
      {!complete && <small className="pp-kpi-note"> {t('refundsIssuedPartial')}</small>}
    </>
  );
}
