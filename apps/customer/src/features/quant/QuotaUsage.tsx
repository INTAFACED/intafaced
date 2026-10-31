import { quantQuotaUsageSchema } from '@intafaced/contracts/quant-algo';
import { useResource } from '../../shared/resource';
import { DataTable, Panel } from '../../shared/ui';
import { Read } from '../more/common';
import { useApi } from '../session/session';
import { quotaCopy } from './quota-copy';

/**
 * The account's quota usage (AL-limits-01): each resource with what is used and its limit, or "Not set" where the limit
 * is blank. A blank limit is never shown as unlimited: a create of that resource refuses until it is set.
 */
export function QuotaUsage() {
  const api = useApi();
  const { t } = quotaCopy.useCopy();
  const usage = useResource((signal) => api.query('quant', 'quota.get', {}, quantQuotaUsageSchema, { signal }), 'quant-quota');
  return (
    <Panel title={t('title')}>
      <div data-testid="quant-usage">
        <p className="muted">{t('intro')}</p>
        <Read resource={usage.resource} retry={usage.reload}>
          {(data) => (
            <>
              <p data-testid="quant-usage-profile" data-profile={data.profile ?? ''}>
                {data.profile ? t('profile', { profile: data.profile }) : t('noProfile')}
              </p>
              <DataTable label={t('title')} headers={[t('resource'), t('used'), t('limit')]}>
                {data.rows.map((row) => (
                  <tr
                    key={row.resource}
                    data-testid="quant-usage-row"
                    data-resource={row.resource}
                    data-used={row.used}
                    data-limit={row.limit ?? ''}
                  >
                    <td>{t(row.resource)}</td>
                    <td lang="zxx">{row.used}</td>
                    <td lang="zxx">{row.limit ?? t('notSet')}</td>
                  </tr>
                ))}
              </DataTable>
            </>
          )}
        </Read>
      </div>
    </Panel>
  );
}
