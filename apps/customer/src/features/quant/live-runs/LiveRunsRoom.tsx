// volt-room: /quant/live
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { useResource } from '../../../shared/resource';
import { ReadView } from '../../../shared/record/record-parts';
import { useApi } from '../../session';
import { liveRunCopy } from '../live-run-copy';
import { listSchema, liveRunsBase, timeText } from '../LiveRun';

const BASE = liveRunsBase;

/** `/quant/live`: the person's live runs, newest first. */
export function LiveRunsRoom() {
  const api = useApi();
  const { t } = liveRunCopy.useCopy();
  const list = useResource((signal) => api.rest(BASE, listSchema, { signal }), 'quant-live-runs');
  return (
    <RecordListTemplate
      title={t('listTitle')}
      description={t('description')}
      state={{ kind: 'ready' }}
      list={
        <section aria-label={t('listTitle')} data-testid="live-runs">
          <p className="lt-hint">{t('intro')}</p>
          <ReadView resource={list.resource} retry={list.reload}>
            {(data) =>
              data.runs.length === 0 ? (
                <p className="lt-hint">{t('none')}</p>
              ) : (
                <div tabIndex={0} role="region" aria-label={t('listTitle')}>
                  <table className="lt-table">
                    <thead>
                      <tr>
                        <th scope="col">{t('colStrategy')}</th>
                        <th scope="col">{t('colState')}</th>
                        <th scope="col">{t('colStarted')}</th>
                        <th scope="col" />
                      </tr>
                    </thead>
                    <tbody>
                      {data.runs.map((r) => (
                        <tr key={r.runId} data-testid="live-run-row" data-id={r.runId}>
                          <td>
                            {r.strategyName} · {t('version', { version: r.strategyVersion })}
                          </td>
                          <td data-testid="live-run-row-state" data-state={r.state} data-halted={r.halt ? 'true' : 'false'}>
                            {t(`state_${r.state}`)}
                            {r.halt ? ` · ${t('haltedShort')}` : ''}
                          </td>
                          <td className="lt-mono">{r.startedAt ? timeText(r.startedAt) : '—'}</td>
                          <td>
                            <a className="lt-link" href={`/quant/live/${encodeURIComponent(r.runId)}`}>
                              {t('open')}
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </ReadView>
        </section>
      }
    />
  );
}
