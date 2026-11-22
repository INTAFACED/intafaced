import { useMemo } from 'react';
import { Button } from '@intafaced/ui/lit';
import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { useDataEnv, useSource } from '../../../data/hooks';
import { refusalCopy } from '../../../data';
import type { Loadable } from '../../../data/types';
import { knownMode, maintenanceFetcher, marketModesFetcher, modesAsOf, type MaintenanceWindow, type MarketMode } from '../status';
import { statusCopy } from '../status-copy';
import { StatusComponents } from './StatusComponents';

const whenUtc = (instant: string) => `${instant.slice(0, 16).replace('T', ' ')} UTC`;

type CopyKey = Parameters<ReturnType<typeof statusCopy.useCopy>['t']>[0];

/** The time the trading modes are as of, in UTC, or the honest line that no market reported one. */
function ModesAsOf({ at }: { at: string | null }) {
  const copy = statusCopy.useCopy();
  return (
    <p className="lt-hint" data-testid="status-modes-asof">
      {at ? `${copy.t('modesAsOf')} ${whenUtc(at)}` : copy.t('modesAsOfNone')}
    </p>
  );
}

/**
 * /status: public, signed-out, on the reading template. Components come from the founders' status page (readings and
 * published notices); each market row is the market's own reported mode. The page keeps no status of its own. Each part
 * reads on its own, so the room is always ready and each part says its own loading, empty or failed line.
 */
export function StatusRoom() {
  const copy = statusCopy.useCopy();
  const env = useDataEnv();
  const source = useMemo(
    () => env.poller.source<MarketMode[]>('public-status-modes', marketModesFetcher(env.api), { intervalMs: 30_000 }),
    [env],
  );
  const load = useSource(source);
  const maintenanceSource = useMemo(
    () => env.poller.source<MaintenanceWindow[]>('public-status-maintenance', maintenanceFetcher(env.api), { intervalMs: 60_000 }),
    [env],
  );
  const maintenance = useSource(maintenanceSource);
  return (
    <div data-room="status">
      <ReadingTemplate
        title={copy.t('title')}
        description={copy.t('lead')}
        state={{ kind: 'ready' }}
        body={
          <div className="lt-stack">
            <StatusComponents />
            <MarketModes load={load} />
            <Maintenance maintenance={maintenance} />
          </div>
        }
      />
    </div>
  );
}

function MarketModes({ load }: { load: Loadable<MarketMode[]> }) {
  const copy = statusCopy.useCopy();
  return (
    <section className="lt-stack" aria-labelledby="status-modes">
      <h2 id="status-modes">{copy.t('modesTitle')}</h2>
      {load.status === 'loading' ? <p role="status">{copy.t('loading')}</p> : null}
      {load.status === 'empty' ? <p role="status">{copy.t('none')}</p> : null}
      {load.status === 'refused' ? <p role="alert">{refusalCopy(load.code).title || copy.t('refused')}</p> : null}
      {load.status === 'error' ? (
        <p role="alert">
          {copy.t('failed')}{' '}
          <Button tone="quiet" onClick={load.retry}>
            {copy.t('retry')}
          </Button>
        </p>
      ) : null}
      {load.status === 'ready' && load.data.length === 0 ? <p role="status">{copy.t('none')}</p> : null}
      {load.status === 'ready' && load.data.length > 0 ? <ModesAsOf at={modesAsOf(load.data)} /> : null}
      {load.status === 'ready' && load.data.length > 0 ? (
        <table className="lt-table" data-testid="status-modes">
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
                <tr key={row.symbol} data-testid={`status-mode-${row.symbol}`} data-state={row.state ?? 'none'}>
                  <td>{row.symbol}</td>
                  <td>{mode ? copy.t(mode) : row.state === null ? copy.t('notReported') : row.state}</td>
                  <td>
                    {mode ? copy.t(`${mode}_effect` as CopyKey) : row.state === null ? copy.t('notReportedEffect') : copy.t('undescribed')}
                    {row.maintenance ? (
                      <span className="lt-hint" data-testid={`status-maintenance-${row.symbol}`}>
                        {' '}
                        {copy.t('marketMaintenance')}{' '}
                        {row.maintenance.startsAt !== null
                          ? whenUtc(new Date(row.maintenance.startsAt).toISOString())
                          : copy.t('windowNotSet')}{' '}
                        {copy.t('windowTo')}{' '}
                        {row.maintenance.endsAt !== null ? whenUtc(new Date(row.maintenance.endsAt).toISOString()) : copy.t('endNotSet')}
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function Maintenance({ maintenance }: { maintenance: Loadable<MaintenanceWindow[]> }) {
  const copy = statusCopy.useCopy();
  return (
    <section className="lt-stack" aria-labelledby="status-maintenance">
      <h2 id="status-maintenance">{copy.t('maintenanceTitle')}</h2>
      {maintenance.status === 'loading' ? <p role="status">{copy.t('maintenanceLoading')}</p> : null}
      {maintenance.status === 'refused' ? <p role="alert">{refusalCopy(maintenance.code).title || copy.t('refused')}</p> : null}
      {maintenance.status === 'error' ? (
        <p role="alert">
          {copy.t('maintenanceFailed')}{' '}
          <Button tone="quiet" onClick={maintenance.retry}>
            {copy.t('retry')}
          </Button>
        </p>
      ) : null}
      {maintenance.status === 'empty' || (maintenance.status === 'ready' && maintenance.data.length === 0) ? (
        <p role="status">{copy.t('maintenanceNone')}</p>
      ) : null}
      {maintenance.status === 'ready' && maintenance.data.length > 0 ? (
        <ul>
          {maintenance.data.map((window) => (
            <li key={window.id}>
              <strong>{window.title}</strong>{' '}
              <span className="lt-hint">
                {window.startsAt ? whenUtc(window.startsAt) : copy.t('windowNotSet')} {copy.t('windowTo')}{' '}
                {window.endsAt ? whenUtc(window.endsAt) : copy.t('endNotSet')}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <a className="lt-link" href="/notice">
        {copy.t('noticesLink')} →
      </a>
    </section>
  );
}
