import { quantLimitsSchema } from '@intafaced/contracts/quant-algo';
import { DataTable, Panel } from '../../shared/ui';
import { useResource } from '../../shared/resource';
import { Read } from '../more/common';
import { useApi } from '../session/session';
import { limitsCopy } from './limits-copy';
import { QuantRooms } from './QuantRooms';
import { UsagePanel } from './UsagePanel';
import './algo.css';

/**
 * The developer limits page (J-algo-dev-12 #4, AL-limits-02): every limit a run of this account meets, with its value
 * as the sandbox applies it, or "not set" (and then no run starts). The plan's quotas are the usage view beside it.
 */
export function LimitsRoom({ paper }: { paper: boolean }) {
  return (
    <>
      <QuantRooms active="strategies" paper={paper} />
      <SandboxLimitsPanel />
      <UsagePanel revision={0} />
    </>
  );
}

function SandboxLimitsPanel() {
  const api = useApi();
  const { t } = limitsCopy.useCopy();
  const limits = useResource((signal) => api.query('quant', 'limits.get', undefined, quantLimitsSchema, { signal }), 'quant-limits');
  return (
    <Panel title={t('sandboxTitle')}>
      <section data-testid="quant-limits" aria-label={t('sandboxTitle')}>
        <p className="muted">{t('sandboxIntro')}</p>
        <Read resource={limits.resource} retry={limits.reload}>
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
              <DataTable label={t('sandboxTitle')} headers={[t('limit'), t('value')]}>
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
              </DataTable>
              <p className="muted">{t('asOf', { at: data.asOf.slice(0, 16).replace('T', ' ') })}</p>
            </>
          )}
        </Read>
      </section>
    </Panel>
  );
}
