import { useMemo } from 'react';
import { useDataEnv, useSource } from '../../data/hooks';
import { refusalCopy } from '../../data';
import { knownMode, marketModesFetcher, type MarketMode } from './status';
import { statusCopy } from './status-copy';

type CopyKey = Parameters<ReturnType<typeof statusCopy.useCopy>['t']>[0];

/** /status: public, signed-out. Every row is the market's own reported mode; the page keeps no status of its own. */
export function StatusPage() {
  const copy = statusCopy.useCopy();
  const env = useDataEnv();
  const source = useMemo(
    () => env.poller.source<MarketMode[]>('public-status-modes', marketModesFetcher(env.api), { intervalMs: 30_000 }),
    [env],
  );
  const load = useSource(source);
  return (
    <div className="pub-page">
      <header className="pub-heading">
        <h1>{copy.t('title')}</h1>
        <p>{copy.t('lead')}</p>
      </header>
      <section className="pub-card" aria-labelledby="status-modes">
        <h2 id="status-modes">{copy.t('modesTitle')}</h2>
        {load.status === 'loading' ? <p role="status">{copy.t('loading')}</p> : null}
        {load.status === 'empty' ? <p role="status">{copy.t('none')}</p> : null}
        {load.status === 'refused' ? <p role="alert">{refusalCopy(load.code).title || copy.t('refused')}</p> : null}
        {load.status === 'error' ? (
          <p role="alert">
            {copy.t('failed')}{' '}
            <button type="button" className="text-link" onClick={load.retry}>
              {copy.t('retry')}
            </button>
          </p>
        ) : null}
        {load.status === 'ready' && load.data.length === 0 ? <p role="status">{copy.t('none')}</p> : null}
        {load.status === 'ready' && load.data.length > 0 ? (
          <table className="pub-table">
            <thead>
              <tr>
                <th>{copy.t('colMarket')}</th>
                <th>{copy.t('colMode')}</th>
                <th>{copy.t('colEffect')}</th>
              </tr>
            </thead>
            <tbody>
              {load.data.map((row) => {
                const mode = knownMode(row.state);
                return (
                  <tr key={row.symbol}>
                    <td>{row.symbol}</td>
                    <td>{mode ? copy.t(mode) : row.state === null ? copy.t('notReported') : row.state}</td>
                    <td>
                      {mode
                        ? copy.t(`${mode}_effect` as CopyKey)
                        : row.state === null
                          ? copy.t('notReportedEffect')
                          : copy.t('undescribed')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </section>
      <section className="pub-card" aria-labelledby="status-maintenance">
        <h2 id="status-maintenance">{copy.t('maintenanceTitle')}</h2>
        <p>{copy.t('maintenanceBody')}</p>
        <a className="text-link" href="/notice">
          {copy.t('noticesLink')} →
        </a>
      </section>
    </div>
  );
}
