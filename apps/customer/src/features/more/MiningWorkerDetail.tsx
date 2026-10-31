import { useState } from 'react';
import { useApi } from '../session/session';
import { usePreferences } from '../../shared/preferences';
import { displayAmount } from '../../shared/money';
import { useResource } from '../../shared/resource';
import { stamp } from '../../screens/money/time';
import { Button, DataTable, EmptyState, Failure, Field, Panel } from '../../shared/ui';
import type { ApiResult } from '../../shared/api';
import type { Resource } from '../../shared/resource';
import { Read, Select } from './common';
import { StatRow } from './depth-kit';
import { miningDepthCopy } from './mining-depth-copy';
import { miningWorkerCopy } from './mining-worker-copy';
import {
  ALERT_LIMIT,
  ALERT_LIMIT_MODES,
  ALERT_LIMIT_UNSET,
  alertLimitSetting,
  WINDOW_MINUTES,
  workerOne,
  workerStateChanges,
  type AlertLimitMode,
  type AlertLimitSetting,
  type WindowMinutes,
  type WorkerOne,
  type WorkerStateChanges,
} from './mining-reads';
import './mining-workers.css';

type Read<T> = { resource: Resource<T>; reload: () => void };
type Failed = Extract<ApiResult<unknown>, { ok: false }>;
type SetAlertLimit = (mode: AlertLimitMode | null, limit: string | null) => Promise<ApiResult<AlertLimitSetting>>;

/** /mining/workers/:workerId: one of the account's own workers, as the pool answers `workers.one` and `workers.stateChanges`. */
export function MiningWorkerDetail({ workerId }: { workerId: string }) {
  const api = useApi();
  const [minutes, setMinutes] = useState<WindowMinutes>(60);
  const worker = useResource(
    (signal) => api.query('mining', 'workers.one', { workerId, windowMinutes: minutes }, workerOne, { signal }),
    `mining-worker:${workerId}:${minutes}`,
  );
  const changes = useResource(
    (signal) => api.query('mining', 'workers.stateChanges', { workerId }, workerStateChanges, { signal }),
    `mining-worker-changes:${workerId}`,
  );
  const setAlertLimit: SetAlertLimit = (mode, limit) =>
    api.mutate('mining', 'workers.setAlertLimit', { workerId, mode, limit }, alertLimitSetting);
  return (
    <WorkerDetailView
      worker={worker}
      changes={changes}
      minutes={minutes}
      onMinutes={setMinutes}
      onRefresh={() => {
        worker.reload();
        changes.reload();
      }}
      onSetAlertLimit={setAlertLimit}
    />
  );
}

export function WorkerDetailView({
  worker,
  changes,
  minutes,
  onMinutes = () => undefined,
  onRefresh = () => undefined,
  onSetAlertLimit,
}: {
  worker: Read<WorkerOne>;
  changes: Read<WorkerStateChanges>;
  minutes: WindowMinutes;
  onMinutes?: (minutes: WindowMinutes) => void;
  onRefresh?: () => void;
  onSetAlertLimit?: SetAlertLimit;
}) {
  const { t } = miningWorkerCopy.useCopy();
  const depth = miningDepthCopy.useCopy().t;
  const { timeZone } = usePreferences();
  // The alert panel keeps the worker's last answer while a reload (after a save, or a new window) is on its way, so it
  // stays mounted and the person still sees that the save worked.
  const shown = useLastReady(worker.resource);
  return (
    <div className="more-columns">
      <Panel title={t('statusTitle')}>
        <Select
          label={t('window')}
          value={String(minutes)}
          onChange={(value) => onMinutes(WINDOW_MINUTES.find((option) => String(option) === value) ?? 60)}
          options={WINDOW_MINUTES.map((option) => ({ value: String(option), label: depth(`window_${option}`) }))}
        />
        <Read resource={worker.resource} retry={worker.reload}>
          {(data) => (
            <>
              <h3 lang="und">{data.name}</h3>
              <StatRow
                items={[
                  {
                    label: t('hashingLabel'),
                    value: (
                      <span data-testid="mining-worker-hashing" data-state={data.hashing}>
                        {t(`hashing_${data.hashing}`)}
                      </span>
                    ),
                  },
                  {
                    label: t('connectivityLabel'),
                    value: (
                      <span data-testid="mining-worker-connectivity" data-state={data.connectivity}>
                        {t(`connectivity_${data.connectivity}`)}
                      </span>
                    ),
                  },
                  {
                    label: t('stateLabel'),
                    value: (
                      <span className="badge" data-testid="mining-worker-state" data-state={data.state}>
                        {t(`badge_${data.state}`)}
                      </span>
                    ),
                  },
                  {
                    label: t('weightLabel'),
                    value: data.hashrate === null ? t('noShares') : displayAmount(data.hashrate),
                  },
                  {
                    label: t('lastShareLabel'),
                    value: (
                      <span data-testid="mining-worker-last-share" data-at={data.lastShareAt ?? ''}>
                        {data.lastShareAt ? stamp(data.lastShareAt, timeZone) : t('lastShareNone')}
                      </span>
                    ),
                  },
                ]}
              />
              <p className="muted">{t('quietRule', { n: String(data.quietSeconds) })}</p>
              {data.maintenanceSince ? <p>{t('maintenanceSince', { time: stamp(data.maintenanceSince, timeZone) })}</p> : null}
              <p className="muted">{t('asOf', { time: stamp(data.asOf, timeZone) })}</p>
            </>
          )}
        </Read>
        <div className="actions">
          <Button variant="secondary" onClick={onRefresh}>
            {t('refresh')}
          </Button>
          <a className="text-link" href="/mining/workers">
            {t('allWorkers')}
          </a>
        </div>
      </Panel>
      <Panel title={t('changesTitle')}>
        <Read resource={changes.resource} retry={changes.reload}>
          {(data) => (
            <>
              {data.rows.length === 0 ? (
                <EmptyState title={t('changesNone')} />
              ) : (
                <DataTable headers={[t('changeFrom'), t('changeTo'), t('changeAt')]} label={t('changesTitle')}>
                  {data.rows.map((row) => (
                    <tr key={`${row.at}:${row.to}`}>
                      <td>{t(`connectivity_${row.from}`)}</td>
                      <td>{t(`connectivity_${row.to}`)}</td>
                      <td>{stamp(row.at, timeZone)}</td>
                    </tr>
                  ))}
                </DataTable>
              )}
              <p className="muted">
                {data.evaluatedAt ? t('evaluated', { time: stamp(data.evaluatedAt, timeZone) }) : t('evaluatedNever')}
              </p>
            </>
          )}
        </Read>
      </Panel>
      <Panel title={t('alertTitle')}>
        {shown ? <AlertLimit key={shown.id} worker={shown} onSet={onSetAlertLimit} onSaved={worker.reload} /> : null}
        <p className="muted">{t('alertNote')}</p>
      </Panel>
    </div>
  );
}

/** The resource's data when ready; while it loads again, the last data it was ready with; nothing once it fails. */
function useLastReady<T>(resource: Resource<T>): T | null {
  const current = resource.status === 'ready' ? resource.data : null;
  const [last, setLast] = useState<T | null>(current);
  if (current !== null && current !== last) setLast(current);
  if (resource.status === 'failed') return null;
  return current ?? last;
}

type AlertState = { status: 'idle' } | { status: 'busy' } | { status: 'saved' } | { status: 'failed'; failure: Failed };

/** The worker's alert limit as the pool answers it, and the account's own choice of how it is set. */
function AlertLimit({ worker, onSet, onSaved }: { worker: WorkerOne; onSet?: SetAlertLimit; onSaved: () => void }) {
  const { t } = miningWorkerCopy.useCopy();
  const [mode, setMode] = useState<AlertLimitMode | 'none'>(worker.alertLimitMode ?? 'none');
  const [manual, setManual] = useState('');
  const [state, setState] = useState<AlertState>({ status: 'idle' });
  const invalid = mode === 'manual' && (!ALERT_LIMIT.test(manual) || /^0(\.0+)?$/.test(manual));
  async function save() {
    if (!onSet || invalid) return;
    setState({ status: 'busy' });
    const result = await onSet(mode === 'none' ? null : mode, mode === 'manual' ? manual : null);
    if (!result.ok) return setState({ status: 'failed', failure: result });
    setState({ status: 'saved' });
    onSaved();
  }
  return (
    <>
      <p>
        {t('alertLabel')}:{' '}
        {worker.alertLimit !== null ? (
          <span data-testid="mining-worker-alert-limit" data-mode={worker.alertLimitMode ?? ''} className="numeric">
            {displayAmount(worker.alertLimit)}
          </span>
        ) : (
          <span data-testid="mining-worker-alert-limit" data-code={worker.alertLimitReason ?? ALERT_LIMIT_UNSET}>
            {worker.alertLimitReason === ALERT_LIMIT_UNSET || worker.alertLimitReason === null ? t('alertNotSet') : t('alertNoShares')}
          </span>
        )}
      </p>
      <fieldset className="mining-mode-choice" disabled={state.status === 'busy'}>
        <legend>{t('alertModeLegend')}</legend>
        {(['none', ...ALERT_LIMIT_MODES] as const).map((option) => (
          <label key={option}>
            <input type="radio" name="mining-alert-limit-mode" value={option} checked={mode === option} onChange={() => setMode(option)} />{' '}
            {t(`alertMode_${option}`)}
          </label>
        ))}
      </fieldset>
      {mode === 'manual' ? (
        <Field
          label={t('alertManual')}
          hint={t('alertManualHint')}
          error={manual !== '' && invalid ? t('alertManualInvalid') : undefined}
          inputMode="decimal"
          value={manual}
          maxLength={39}
          onChange={(event) => setManual(event.target.value.replace(/[^\d.]/g, ''))}
        />
      ) : null}
      <div className="actions">
        <Button disabled={!onSet || state.status === 'busy' || invalid} onClick={() => void save()}>
          {t('alertSave')}
        </Button>
      </div>
      <p role="status" className="muted">
        {state.status === 'busy' ? t('maintenanceSaving') : state.status === 'saved' ? t('alertSaved') : ''}
      </p>
      {state.status === 'failed' ? <Failure result={state.failure} /> : null}
    </>
  );
}
