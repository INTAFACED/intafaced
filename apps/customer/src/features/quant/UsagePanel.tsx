import { quantQuotaSchema } from '@intafaced/contracts/quant-algo';
import { DataTable, Panel } from '../../shared/ui';
import { useResource } from '../../shared/resource';
import { Read } from '../more/common';
import { useApi } from '../session/session';
import { usageCopy } from './usage-copy';

/**
 * The usage view (AL-limits-01): each resource with what the account holds, counted from the stored rows, against its
 * plan's limit, or "not set" when the owner has not set it. A profile is a name, not a price.
 */
export function UsagePanel({ revision }: { revision: number }) {
  const api = useApi();
  const { t } = usageCopy.useCopy();
  const usage = useResource(
    (signal) => api.query('quant', 'quota.get', undefined, quantQuotaSchema, { signal }),
    `quant-usage:${revision}`,
  );
  return (
    <Panel title={t('title')}>
      <section data-testid="quant-usage" aria-label={t('title')}>
        <p className="muted">{t('intro')}</p>
        <Read resource={usage.resource} retry={usage.reload}>
          {(data) => (
            <>
              {data.profile ? (
                <p data-testid="quant-usage-plan" data-profile={data.profile} data-source={data.source ?? ''}>
                  {t('plan', { profile: data.profile })} ({data.source === 'assigned' ? t('planAssigned') : t('planDefault')})
                </p>
              ) : (
                <p data-testid="quant-usage-plan" data-profile="" role="status">
                  {t('planUnset')}
                </p>
              )}
              <DataTable label={t('title')} headers={[t('resource'), t('used'), t('limit')]}>
                {data.resources.map((row) => (
                  <tr key={row.resource} data-resource={row.resource} data-used={row.used} data-limit={row.limit ?? ''}>
                    <th scope="row">{t(row.resource)}</th>
                    <td lang="zxx">{row.used}</td>
                    <td>{row.limit === null ? t('notSet') : <span lang="zxx">{row.limit}</span>}</td>
                  </tr>
                ))}
              </DataTable>
              <p className="muted">{t('asOf', { at: data.asOf.slice(0, 16).replace('T', ' ') })}</p>
            </>
          )}
        </Read>
      </section>
    </Panel>
  );
}
