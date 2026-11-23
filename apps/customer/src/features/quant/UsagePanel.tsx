import { useResource } from '../../shared/resource';
import { ReadView } from '../../shared/record/record-parts';
import { useApi } from '../session';
import { usageCopy } from './usage-copy';
import { limitsCopy } from './limits-copy';
import { QUANT_QUOTA_GET } from '@intafaced/contracts/quant-quota-procedures';

/**
 * The usage view (AL-limits-01): each resource with what the account holds, counted from the stored rows, against its
 * plan's limit, or "not set" when the owner has not set it. A profile is a name, not a price.
 */
export function UsagePanel({ revision }: { revision: number }) {
  const api = useApi();
  const { t } = usageCopy.useCopy();
  const limits = limitsCopy.useCopy();
  const usage = useResource((signal) => api.call(QUANT_QUOTA_GET, undefined, { signal }), `quant-usage:${revision}`);
  return (
    <section>
      <h2>{t('title')}</h2>
      <section data-testid="quant-usage" aria-label={t('title')}>
        <p className="lt-hint">{t('intro')}</p>
        <ReadView resource={usage.resource} retry={usage.reload}>
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
              <div tabIndex={0} role="region" aria-label={t('title')}>
                <table className="lt-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('resource')}</th>
                      <th scope="col">{t('used')}</th>
                      <th scope="col">{t('limit')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.resources.map((row) => (
                      <tr key={row.resource} data-resource={row.resource} data-used={row.used} data-limit={row.limit ?? ''}>
                        <th scope="row">{t(row.resource)}</th>
                        <td lang="zxx">{row.used}</td>
                        <td>{row.limit === null ? t('notSet') : <span lang="zxx">{row.limit}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="lt-hint">{t('asOf', { at: data.asOf.slice(0, 16).replace('T', ' ') })}</p>
              {/* The sandbox limits each run meets are on their own page (J-algo-dev-12 #4). */}
              <a className="lt-link" href="/quant/limits" data-testid="quant-usage-limits-link">
                {limits.t('openLimits')}
              </a>
            </>
          )}
        </ReadView>
      </section>
    </section>
  );
}
