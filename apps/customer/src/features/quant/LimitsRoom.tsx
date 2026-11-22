import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { useResource } from '../../shared/resource';
import { ReadView } from '../../shared/record/record-parts';
import { useApi } from '../session';
import { limitsCopy } from './limits-copy';
import { QuantRooms } from './QuantRooms';
import { UsagePanel } from './UsagePanel';
import { QUANT_LIMITS_GET } from '@intafaced/contracts/quant-limits-procedures';

/**
 * The developer limits page (J-algo-dev-12 #4, AL-limits-02): every limit a run of this account meets, with its value
 * as the sandbox applies it, or "not set" (and then no run starts). The plan's quotas are the usage view beside it.
 */
export function LimitsRoom({ paper }: { paper: boolean }) {
  const { t } = limitsCopy.useCopy();
  return (
    <RecordListTemplate
      title={t('title')}
      description={t('description')}
      state={{ kind: 'ready' }}
      filters={<QuantRooms active="strategies" paper={paper} />}
      list={
        <>
          <SandboxLimitsPanel />
          <UsagePanel revision={0} />
        </>
      }
    />
  );
}

function SandboxLimitsPanel() {
  const api = useApi();
  const { t } = limitsCopy.useCopy();
  const limits = useResource((signal) => api.call(QUANT_LIMITS_GET, undefined, { signal }), 'quant-limits');
  return (
    <section>
      <h2>{t('sandboxTitle')}</h2>
      <section data-testid="quant-limits" aria-label={t('sandboxTitle')}>
        <p className="lt-hint">{t('sandboxIntro')}</p>
        <ReadView resource={limits.resource} retry={limits.reload}>
          {(data) => (
            <>
              {data.profile ? (
                <p data-testid="quant-limits-plan" data-profile={data.profile}>
                  {t('plan', { profile: data.profile })}
                </p>
              ) : (
                <p data-testid="quant-limits-plan" data-profile="" role="status">
                  {t('planUnset')}
                </p>
              )}
              <div tabIndex={0} role="region" aria-label={t('sandboxTitle')}>
                <table className="lt-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('limit')}</th>
                      <th scope="col">{t('value')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sandbox.map((row) => (
                      <tr key={row.limit} data-limit={row.limit} data-value={row.value ?? ''}>
                        <th scope="row">{t(row.limit)}</th>
                        <td>{row.value === null ? t('notSet') : <span lang="zxx">{row.value}</span>}</td>
                      </tr>
                    ))}
                    <tr data-limit="max_ops" data-value={data.ceilings.maxOps ?? ''}>
                      <th scope="row">{t('maxOps')}</th>
                      <td>{data.ceilings.maxOps === null ? t('notSet') : <span lang="zxx">{data.ceilings.maxOps}</span>}</td>
                    </tr>
                    <tr data-limit="max_source" data-value={data.ceilings.maxSource ?? ''}>
                      <th scope="row">{t('maxSource')}</th>
                      <td>{data.ceilings.maxSource === null ? t('notSet') : <span lang="zxx">{data.ceilings.maxSource}</span>}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="lt-hint">{t('asOf', { at: data.asOf.slice(0, 16).replace('T', ' ') })}</p>
            </>
          )}
        </ReadView>
      </section>
    </section>
  );
}
