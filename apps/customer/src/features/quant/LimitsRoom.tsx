// volt-room: /quant/limits
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { useResource } from '../../shared/resource';
import { ReadView } from '../../shared/record/record-parts';
import { useApi } from '../session';
import { limitsCopy } from './limits-copy';
import { QuantRooms } from './QuantRooms';
import { UsagePanel } from './UsagePanel';
import { limitText, readTime, type LimitUnit, type LimitWords } from './limit-words';
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
      section={<QuantRooms paper={paper} />}
      list={
        <>
          <SandboxLimitsPanel />
          <UsagePanel revision={0} />
        </>
      }
    />
  );
}

const UNIT: Record<'wall_clock_ms' | 'memory_bytes' | 'output_bytes', LimitUnit> = {
  wall_clock_ms: 'milliseconds',
  memory_bytes: 'bytes',
  output_bytes: 'bytes',
};

/** The limit words from the limits copy, for `limitText`. */
export function limitWords(t: ReturnType<typeof limitsCopy.useCopy>['t']): LimitWords {
  return {
    seconds: (n) => t('seconds', { n }),
    oneSecond: t('oneSecond'),
    bytes: (n) => t('bytes', { n }),
    kb: (n) => t('kb', { n }),
    mb: (n) => t('mb', { n }),
    characters: (n) => t('characters', { n }),
  };
}

function SandboxLimitsPanel() {
  const api = useApi();
  const { t, requestedLocale } = limitsCopy.useCopy();
  const words = limitWords(t);
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
              <div>
                <table className="lt-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('limit')}</th>
                      <th scope="col" data-align="end">
                        {t('value')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sandbox.map((row) => (
                      <tr key={row.limit} data-limit={row.limit} data-value={row.value ?? ''}>
                        <th scope="row">{t(row.limit)}</th>
                        <td data-align="end">{row.value === null ? t('notSet') : limitText(row.value, UNIT[row.limit], words)}</td>
                      </tr>
                    ))}
                    <tr data-limit="max_ops" data-value={data.ceilings.maxOps ?? ''}>
                      <th scope="row">{t('maxOps')}</th>
                      <td data-align="end">
                        {data.ceilings.maxOps === null ? t('notSet') : limitText(data.ceilings.maxOps, 'count', words)}
                      </td>
                    </tr>
                    <tr data-limit="max_source" data-value={data.ceilings.maxSource ?? ''}>
                      <th scope="row">{t('maxSource')}</th>
                      <td data-align="end">
                        {data.ceilings.maxSource === null ? t('notSet') : limitText(data.ceilings.maxSource, 'characters', words)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="lt-hint">{t('asOf', { at: readTime(data.asOf, requestedLocale) })}</p>
            </>
          )}
        </ReadView>
      </section>
    </section>
  );
}
