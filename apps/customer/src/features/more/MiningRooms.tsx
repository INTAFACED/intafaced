import { z } from 'zod';
import { useState } from 'react';
import { useDebouncedValue } from '../pay/portal/payments/use-debounced';
import { useApi } from '../session/session';
import { usePreferences } from '../../shared/preferences';
import { displayAmount } from '../../shared/money';
import { useResource } from '../../shared/resource';
import { stamp } from '../../screens/money/time';
import { Button, DataTable, EmptyState, Failure, Field, Loading, Panel } from '../../shared/ui';
import { Read, Select } from './common';
import { DisabledAction, Journey, StatRow, type JourneyStep } from './depth-kit';
import { dependencyReading, MINING_STEPS, poolVerdict, type MiningHealth } from './mining-journey';
import { miningDepthCopy } from './mining-depth-copy';
import { miningWorkersCopy } from './mining-workers-copy';
import { miningWorkerCopy } from './mining-worker-copy';
import './mining-workers.css';
import {
  bpsToPercent,
  minerShares,
  minerWorkers,
  payoutPage,
  PAYOUT_PAGE,
  pendingWindows,
  poolTerms,
  sumByAsset,
  sumWeights,
  WINDOW_MINUTES,
  EMISSION_UNPUBLISHED,
  MODE_CHANGE_IN_WINDOW,
  WORKER_MODES,
  WORKER_PAGE,
  powSpec,
  workerDifficulty,
  workerHref,
  workerMode,
  maintenanceRows,
  type MaintenanceRows,
  type PowSpec,
  type WorkerMode,
  type MinerShares,
  type MinerWorkers,
  type PayoutPage,
  type PendingWindows,
  type PoolTerms,
  type WindowMinutes,
} from './mining-reads';
import type { ApiResult } from '../../shared/api';
import type { Resource } from '../../shared/resource';

type Room = 'Overview' | 'Workers' | 'Shares' | 'Rewards';
type Health = { resource: Resource<MiningHealth>; reload: () => void };
type Read<T> = { resource: Resource<T>; reload: () => void };
type Failed = Extract<ApiResult<unknown>, { ok: false }>;
type Translate = ReturnType<typeof miningDepthCopy.useCopy>['t'];

export function MiningRooms({ room, health }: { room: Room; health: Health }) {
  const { Copy, t } = miningDepthCopy.useCopy();
  const reading = health.resource.status === 'ready' ? health.resource.data : null;
  const loading = health.resource.status === 'loading';
  if (room === 'Workers') return <Workers />;
  if (room === 'Shares') return <Shares />;
  if (room === 'Rewards') return <Rewards />;
  const verdict = poolVerdict(reading);
  // The pool lists a customer's own workers, shares, open windows and paid credits. It still refuses to register a worker.
  const steps: JourneyStep[] = MINING_STEPS.map((step) => {
    const need = dependencyReading(reading, step);
    const canStart = step.access === 'read';
    return {
      id: step.id,
      title: t(`step_${step.id}`),
      body: t(`step_${step.id}_body`),
      state: canStart ? 'info' : 'blocked',
      stateLabel: canStart ? t('stepReadOnly') : t('stepBlocked'),
      reason: (
        <>
          <Copy k={`step_${step.id}_where`} />
          {step.dependency === 'ledger' || step.dependency === 'store' ? (
            <>
              {' '}
              <Copy k="needs" /> <Copy k={step.dependency === 'ledger' ? 'need_ledger' : 'need_store'} />:{' '}
              <Copy k={need === 'configured' ? 'configured' : need === 'absent' ? 'absent' : 'unknown'} />. <Copy k="checked" />.
            </>
          ) : null}
        </>
      ),
    };
  });
  return (
    <div className="more-grid">
      <Panel title={t('verdictTitle')}>
        {loading ? (
          <Loading />
        ) : (
          <>
            <p role="status">
              <Copy k={`verdict_${verdict}`} />
            </p>
            <StatRow
              items={[
                {
                  label: t('readingProcess'),
                  value: <Copy k={reading ? 'responding' : 'silent'} />,
                },
                {
                  label: t('readingLedger'),
                  value: <Copy k={reading ? (reading.ledger.status === 'configured' ? 'configured' : 'absent') : 'unknown'} />,
                  note: t('checked'),
                },
                {
                  label: t('readingStore'),
                  value: <Copy k={reading ? (reading.pg.status === 'configured' ? 'configured' : 'absent') : 'unknown'} />,
                  note: t('checked'),
                },
                { label: t('readingJobs'), value: reading ? reading.jobs.length : t('unknown'), note: t('checked') },
              ]}
            />
            <Button variant="secondary" onClick={health.reload}>
              <Copy k="tabStatus" />
            </Button>
          </>
        )}
      </Panel>
      <Panel title={t('journeyTitle')}>
        <Journey steps={steps} label={t('journeyLabel')} />
        <a className="button button--secondary" href="/support">
          <Copy k="support" />
        </a>
      </Panel>
    </div>
  );
}

function Workers() {
  const api = useApi();
  const [minutes, setMinutes] = useState<WindowMinutes>(60);
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  // The box shows every key; the service is read once the typing pauses.
  const name = useDebouncedValue(filter);
  const input = { windowMinutes: minutes, limit: WORKER_PAGE, ...(name ? { name } : {}), ...(cursor ? { cursor } : {}) };
  const read = useResource(
    (signal) => api.query('mining', 'workers.mine', input, minerWorkers, { signal }),
    `mining-workers:${minutes}:${name}:${cursor ?? ''}`,
  );
  const setDifficulty = (workerId: string, minDifficulty: string | null) =>
    api.mutate('mining', 'workers.setDifficulty', { workerId, minDifficulty }, workerDifficulty);
  const setMode = (name: string, mode: WorkerMode) => api.mutate('mining', 'workers.setMode', { name, mode }, workerMode);
  const setMaintenance = (workerIds: string[], on: boolean) =>
    api.mutate('mining', 'workers.setMaintenance', { workerIds, on }, maintenanceRows);
  const pow = useResource((signal) => api.query('mining', 'pow', undefined, powSpec, { signal }), 'mining-pow');
  // Solo credit is the service's own answer; today it is always a typed refusal.
  const soloCredit = useResource(
    (signal) => api.query('mining', 'workers.soloCredit', undefined, z.never(), { signal }),
    'mining-solo-credit',
  );
  return (
    <WorkersView
      read={read}
      minutes={minutes}
      onMinutes={(next) => {
        setCursor(null);
        setMinutes(next);
      }}
      filter={filter}
      onFilter={(next) => {
        setCursor(null);
        setFilter(next);
      }}
      paged={cursor !== null}
      onPage={setCursor}
      onSetDifficulty={setDifficulty}
      onSetMode={setMode}
      onSetMaintenance={setMaintenance}
      pow={pow}
      soloCredit={soloCredit}
    />
  );
}

export function WorkersView({
  read,
  minutes,
  onMinutes,
  filter = '',
  onFilter = () => undefined,
  paged = false,
  onPage = () => undefined,
  onSetDifficulty,
  onSetMode,
  onSetMaintenance,
  pow,
  soloCredit,
}: {
  read: Read<MinerWorkers>;
  minutes: WindowMinutes;
  onMinutes: (minutes: WindowMinutes) => void;
  filter?: string;
  onFilter?: (filter: string) => void;
  /** True when the roster shows a page after the first. */
  paged?: boolean;
  /** A cursor for the next page, or null for the first. */
  onPage?: (cursor: string | null) => void;
  onSetDifficulty?: (workerId: string, minDifficulty: string | null) => Promise<ApiResult<{ id: string; minDifficulty: string | null }>>;
  onSetMode?: (name: string, mode: WorkerMode) => Promise<ApiResult<{ id: string; name: string; mode: WorkerMode }>>;
  onSetMaintenance?: (workerIds: string[], on: boolean) => Promise<ApiResult<MaintenanceRows>>;
  pow?: Read<PowSpec>;
  soloCredit?: Read<never>;
}) {
  const { Copy, t } = miningDepthCopy.useCopy();
  const w = miningWorkersCopy.useCopy().t;
  const { timeZone } = usePreferences();
  const [name, setName] = useState('');
  // Held here, outside the roster read, so the saved line survives the reload that follows a save.
  const [saving, setSaving] = useState<SaveState>({ status: 'idle' });
  const m = miningWorkerCopy.useCopy().t;
  // The ticked rows, by worker id; a maintenance change applies to these only. Paging, a filter change and an applied
  // change clear them, so the buttons never act on a worker the roster no longer shows.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const clearPicked = () => setPicked(new Set());
  const page = (cursor: string | null) => {
    clearPicked();
    onPage(cursor);
  };
  const [maintenance, setMaintenance] = useState<MaintenanceState>({ status: 'idle' });
  async function applyMaintenance(on: boolean) {
    if (!onSetMaintenance || picked.size === 0) return;
    setMaintenance({ status: 'busy' });
    const result = await onSetMaintenance([...picked], on);
    if (!result.ok) return setMaintenance({ status: 'failed', failure: result });
    setMaintenance({ status: 'saved', n: result.data.rows.length });
    clearPicked();
    read.reload();
  }
  return (
    <div className="more-columns">
      <Panel title={t('workersRegister')}>
        <Field
          label={t('workerName')}
          hint={t('workerNameHint')}
          value={name}
          maxLength={64}
          onChange={(event) => setName(event.target.value.replace(/[^A-Za-z0-9_-]/g, ''))}
        />
        <DisabledAction label={t('workerRegisterAction')} reason={t('workerRegisterReason')} />
      </Panel>
      <Panel title={t('workersRoster')}>
        <Select
          label={t('rosterWindow')}
          value={String(minutes)}
          onChange={(value) => onMinutes(WINDOW_MINUTES.find((option) => String(option) === value) ?? 60)}
          options={WINDOW_MINUTES.map((option) => ({ value: String(option), label: t(`window_${option}`) }))}
        />
        <Field
          type="search"
          label={w('filterWorkers')}
          hint={w('filterHint')}
          value={filter}
          maxLength={64}
          onChange={(event) => {
            clearPicked();
            onFilter(event.target.value.replace(/[^A-Za-z0-9_-]/g, ''));
          }}
        />
        <Read resource={read.resource} retry={read.reload}>
          {(data) => (
            <>
              <p data-testid="mining-default-difficulty">
                {data.defaultDifficulty !== null
                  ? w('defaultDifficulty', { n: data.defaultDifficulty })
                  : data.defaultDifficultyReason === 'mining.default_difficulty_invalid'
                    ? w('defaultInvalid')
                    : w('defaultUnset')}
              </p>
              {data.workers.length === 0 ? (
                filter ? (
                  <EmptyState title={w('noMatch')} />
                ) : (
                  <EmptyState title={<Copy k="workersEmpty" />}>
                    <Copy k="workersEmptyBody" />
                  </EmptyState>
                )
              ) : (
                <DataTable
                  headers={[
                    m('rosterPick'),
                    t('rosterName'),
                    m('rosterState'),
                    w('rosterMode'),
                    t('rosterWeight'),
                    w('rosterMinDifficulty'),
                    t('rosterAdded'),
                  ]}
                  label={t('workersRoster')}
                >
                  {data.workers.map((worker) => (
                    <tr key={worker.id}>
                      <td>
                        <input
                          type="checkbox"
                          className="mining-worker-pick"
                          aria-label={m('rosterSelect', { name: worker.name })}
                          checked={picked.has(worker.id)}
                          onChange={(event) => {
                            const next = new Set(picked);
                            if (event.target.checked) next.add(worker.id);
                            else next.delete(worker.id);
                            setPicked(next);
                          }}
                        />
                      </td>
                      <td lang="und">
                        <a className="text-link" href={workerHref(worker.id)}>
                          {worker.name}
                        </a>
                      </td>
                      <td>
                        <span
                          className="badge"
                          data-testid="mining-worker-badge"
                          data-state={worker.state ?? 'unset'}
                          {...(worker.state === null && worker.stateReason ? { 'data-code': worker.stateReason } : {})}
                        >
                          {m(worker.state === null ? 'badge_unset' : `badge_${worker.state}`)}
                        </span>
                      </td>
                      <td>{w(`mode_${worker.mode}`)}</td>
                      <td className="numeric">{worker.hashrate === null ? t('rosterNoShares') : displayAmount(worker.hashrate)}</td>
                      <td className="numeric">{worker.minDifficulty === null ? w('automatic') : worker.minDifficulty}</td>
                      <td>{stamp(worker.createdAt, timeZone)}</td>
                    </tr>
                  ))}
                </DataTable>
              )}
              {data.workers.length > 0 ? (
                <>
                  <div className="actions">
                    <Button
                      variant="secondary"
                      disabled={!onSetMaintenance || picked.size === 0 || maintenance.status === 'busy'}
                      onClick={() => void applyMaintenance(true)}
                    >
                      {m('maintenanceOn')}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!onSetMaintenance || picked.size === 0 || maintenance.status === 'busy'}
                      onClick={() => void applyMaintenance(false)}
                    >
                      {m('maintenanceOff')}
                    </Button>
                  </div>
                  <p role="status" className="muted" data-testid="mining-maintenance-status">
                    {maintenance.status === 'busy'
                      ? m('maintenanceSaving')
                      : maintenance.status === 'saved'
                        ? m('maintenanceSaved', { n: String(maintenance.n) })
                        : picked.size === 0
                          ? m('maintenancePick')
                          : ''}
                  </p>
                  {maintenance.status === 'failed' ? <Failure result={maintenance.failure} /> : null}
                  <p className="muted">{m('maintenanceNote')}</p>
                </>
              ) : null}
              <div className="actions">
                {paged ? (
                  <Button variant="secondary" onClick={() => page(null)}>
                    {w('firstPage')}
                  </Button>
                ) : null}
                {data.nextCursor !== null ? (
                  <Button variant="secondary" onClick={() => page(data.nextCursor)}>
                    {w('nextPage')}
                  </Button>
                ) : null}
              </div>
              <p className="muted">
                <Copy k="workersNote" />
              </p>
              <p className="muted">{t('asOf', { time: stamp(data.asOf, timeZone) })}</p>
            </>
          )}
        </Read>
      </Panel>
      <Panel title={w('difficultyTitle')}>
        <Read resource={read.resource} retry={read.reload}>
          {(data) =>
            data.workers.length === 0 ? (
              <p className="muted">{w('noWorkerToSet')}</p>
            ) : (
              <DifficultyForm workers={data.workers} onSet={onSetDifficulty} onSaved={read.reload} state={saving} onState={setSaving} />
            )
          }
        </Read>
        <p role="status" className="muted">
          {saving.status === 'busy'
            ? w('saving')
            : saving.status === 'saved'
              ? saving.n === null
                ? w('savedAutomatic', { worker: saving.worker })
                : w('savedSet', { n: saving.n, worker: saving.worker })
              : ''}
        </p>
        {saving.status === 'failed' ? <Failure result={saving.failure} /> : null}
        <p className="muted">{w('difficultyNote')}</p>
      </Panel>
      <ModeForm onSet={onSetMode} onSaved={read.reload} />
      <PowPanel pow={pow} soloCredit={soloCredit} />
    </div>
  );
}

type MaintenanceState = { status: 'idle' } | { status: 'busy' } | { status: 'saved'; n: number } | { status: 'failed'; failure: Failed };

type ModeState =
  { status: 'idle' } | { status: 'busy' } | { status: 'saved'; worker: string; mode: WorkerMode } | { status: 'failed'; failure: Failed };

/** Pooled or solo for one of the account's rigs, by the name the rig sends. */
function ModeForm({
  onSet,
  onSaved,
}: {
  onSet?: (name: string, mode: WorkerMode) => Promise<ApiResult<{ id: string; name: string; mode: WorkerMode }>>;
  onSaved: () => void;
}) {
  const w = miningWorkersCopy.useCopy().t;
  const [rig, setRig] = useState('');
  const [mode, setMode] = useState<WorkerMode>('pooled');
  const [state, setState] = useState<ModeState>({ status: 'idle' });
  async function save() {
    if (!onSet || rig === '') return;
    setState({ status: 'busy' });
    const result = await onSet(rig, mode);
    if (!result.ok) return setState({ status: 'failed', failure: result });
    setState({ status: 'saved', worker: result.data.name, mode: result.data.mode });
    onSaved();
  }
  return (
    <Panel title={w('modeTitle')}>
      <Field
        label={w('modeRig')}
        hint={w('modeRigHint')}
        value={rig}
        maxLength={64}
        onChange={(event) => setRig(event.target.value.replace(/[^A-Za-z0-9_-]/g, ''))}
      />
      <fieldset className="mining-mode-choice" disabled={state.status === 'busy'}>
        <legend>{w('modeLegend')}</legend>
        {WORKER_MODES.map((option) => (
          <label key={option}>
            <input type="radio" name="mining-worker-mode" value={option} checked={mode === option} onChange={() => setMode(option)} />{' '}
            {w(`mode_${option}`)}
          </label>
        ))}
      </fieldset>
      <div className="actions">
        <Button disabled={!onSet || rig === '' || state.status === 'busy'} onClick={() => void save()}>
          {w('modeSave')}
        </Button>
      </div>
      <p role="status" className="muted" data-testid="mining-mode-status">
        {state.status === 'busy'
          ? w('saving')
          : state.status === 'saved'
            ? w('modeSaved', { mode: w(`mode_${state.mode}`), worker: state.worker })
            : ''}
      </p>
      {state.status === 'failed' ? (
        state.failure.code === MODE_CHANGE_IN_WINDOW ? (
          <p role="alert" data-testid="mining-mode-refused" data-code={MODE_CHANGE_IN_WINDOW}>
            {w('modeChangeInWindow')}
          </p>
        ) : (
          <Failure result={state.failure} />
        )
      ) : null}
      <p className="muted">{w('modeNote')}</p>
    </Panel>
  );
}

/** The pool's proof-of-work parameters (a TEST testnet set or blank) and the service's answer on solo credit. */
function PowPanel({ pow, soloCredit }: { pow?: Read<PowSpec>; soloCredit?: Read<never> }) {
  const w = miningWorkersCopy.useCopy().t;
  return (
    <Panel title={w('powTitle')}>
      {pow ? (
        <Read resource={pow.resource} retry={pow.reload}>
          {(spec) =>
            spec.status === 'published' ? (
              <p data-testid="mining-pow" data-testnet="true">
                {w('powPublished', { n: String(spec.dimension), bits: String(spec.targetBits) })}
              </p>
            ) : (
              <p data-testid="mining-pow-unset" data-code={spec.code}>
                {w('powUnset')}
              </p>
            )
          }
        </Read>
      ) : null}
      <p className="muted">{w('powNote')}</p>
      {soloCredit?.resource.status === 'failed' ? (
        soloCredit.resource.failure.code === EMISSION_UNPUBLISHED ? (
          <p role="status" data-testid="mining-solo-credit" data-code={EMISSION_UNPUBLISHED}>
            {w('soloCredit')}
          </p>
        ) : (
          <Failure result={soloCredit.resource.failure} retry={soloCredit.reload} />
        )
      ) : null}
    </Panel>
  );
}

const DIFFICULTY = /^[1-9]\d{0,37}$/;
type SaveState =
  { status: 'idle' } | { status: 'busy' } | { status: 'saved'; worker: string; n: string | null } | { status: 'failed'; failure: Failed };

function DifficultyForm({
  workers,
  onSet,
  onSaved,
  state,
  onState: setState,
}: {
  workers: MinerWorkers['workers'];
  onSet?: (workerId: string, minDifficulty: string | null) => Promise<ApiResult<{ id: string; minDifficulty: string | null }>>;
  onSaved: () => void;
  state: SaveState;
  onState: (state: SaveState) => void;
}) {
  const w = miningWorkersCopy.useCopy().t;
  const [picked, setPicked] = useState(workers[0]?.id ?? '');
  const [value, setValue] = useState('');
  const worker = workers.find((row) => row.id === picked) ?? workers[0];
  const invalid = value !== '' && !DIFFICULTY.test(value);
  async function save(minDifficulty: string | null) {
    if (!worker || !onSet) return;
    setState({ status: 'busy' });
    const result = await onSet(worker.id, minDifficulty);
    if (!result.ok) return setState({ status: 'failed', failure: result });
    setState({ status: 'saved', worker: worker.name, n: result.data.minDifficulty });
    onSaved();
  }
  return (
    <>
      <Select
        label={w('difficultyWorker')}
        value={worker?.id ?? ''}
        onChange={setPicked}
        options={workers.map((row) => ({ value: row.id, label: row.name }))}
      />
      <Field
        label={w('difficultyField')}
        hint={w('difficultyHint')}
        error={invalid ? w('difficultyInvalid') : undefined}
        inputMode="numeric"
        value={value}
        maxLength={38}
        onChange={(event) => setValue(event.target.value.replace(/\D/g, ''))}
      />
      <div className="actions">
        <Button disabled={!onSet || state.status === 'busy' || value === '' || invalid} onClick={() => void save(value)}>
          {w('save')}
        </Button>
        <Button variant="secondary" disabled={!onSet || state.status === 'busy'} onClick={() => void save(null)}>
          {w('useAutomatic')}
        </Button>
      </div>
    </>
  );
}

function Shares() {
  const api = useApi();
  const read = useResource((signal) => api.query('mining', 'shares.mine', {}, minerShares, { signal }), 'mining-shares');
  return <SharesView read={read} />;
}

export function SharesView({ read }: { read: Read<MinerShares> }) {
  const { Copy, t } = miningDepthCopy.useCopy();
  const { timeZone } = usePreferences();
  return (
    <div className="more-columns">
      <Panel title={t('sharesTitle')}>
        <Read resource={read.resource} retry={read.reload}>
          {(data) =>
            data.windows.length === 0 ? (
              <EmptyState title={<Copy k="sharesNone" />}>
                <Copy k="sharesNoneBody" />
              </EmptyState>
            ) : (
              <>
                <StatRow
                  items={[
                    { label: t('sharesCount'), value: data.windows.reduce((sum, row) => sum + row.acceptedCount, 0) },
                    { label: t('sharesRejected'), value: data.windows.reduce((sum, row) => sum + row.rejectedCount, 0) },
                    {
                      label: t('sharesWeight'),
                      value: (() => {
                        const total = sumWeights(data.windows.map((row) => row.acceptedWeight));
                        return total === null ? t('unknown') : displayAmount(total);
                      })(),
                    },
                  ]}
                />
                <DataTable
                  headers={[t('sharesWindowCol'), t('sharesAccepted'), t('sharesRefused'), t('sharesWeight')]}
                  label={t('sharesByWindow')}
                >
                  {data.windows.map((row, index) => (
                    <tr key={row.windowId}>
                      <td>{t('sharesWindowN', { n: index + 1 })}</td>
                      <td className="numeric">{row.acceptedCount}</td>
                      <td className="numeric">{row.rejectedCount}</td>
                      <td className="numeric">{row.acceptedWeight === null ? '—' : displayAmount(row.acceptedWeight)}</td>
                    </tr>
                  ))}
                </DataTable>
                <p className="muted">{t('asOf', { time: stamp(data.asOf, timeZone) })}</p>
              </>
            )
          }
        </Read>
      </Panel>
      <Panel title={t('sharesRuleTitle')}>
        <p className="muted">
          <Copy k="sharesRule" />
        </p>
      </Panel>
    </div>
  );
}

function Rewards() {
  const api = useApi();
  const terms = useResource((signal) => api.query('mining', 'terms', undefined, poolTerms, { signal }), 'mining-terms');
  const pending = useResource((signal) => api.query('mining', 'windows.pending', undefined, pendingWindows, { signal }), 'mining-pending');
  const firstPage = useResource(
    (signal) => api.query('mining', 'payouts.mine', { limit: PAYOUT_PAGE }, payoutPage, { signal }),
    'mining-payouts',
  );
  const [more, setMore] = useState<{ rows: PayoutPage['payouts']; next: string | null; busy: boolean; failed: boolean } | null>(null);
  const first = firstPage.resource.status === 'ready' ? firstPage.resource.data : null;
  const next = more ? more.next : (first?.nextCursor ?? null);
  async function showMore() {
    if (!next || more?.busy) return;
    setMore({ rows: more?.rows ?? [], next, busy: true, failed: false });
    const result = await api.query('mining', 'payouts.mine', { limit: PAYOUT_PAGE, cursor: next }, payoutPage);
    setMore((current) => ({
      rows: [...(current?.rows ?? []), ...(result.ok ? result.data.payouts : [])],
      next: result.ok ? result.data.nextCursor : next,
      busy: false,
      failed: !result.ok,
    }));
  }
  return (
    <RewardsView
      terms={terms}
      pending={pending}
      payouts={firstPage}
      extra={more?.rows ?? []}
      hasMore={next !== null}
      busy={more?.busy ?? false}
      moreFailed={more?.failed ?? false}
      onMore={() => void showMore()}
    />
  );
}

export function RewardsView({
  terms,
  pending,
  payouts,
  extra = [],
  hasMore = false,
  busy = false,
  moreFailed = false,
  onMore = () => undefined,
}: {
  terms: Read<PoolTerms>;
  pending: Read<PendingWindows>;
  payouts: Read<PayoutPage>;
  extra?: PayoutPage['payouts'];
  hasMore?: boolean;
  busy?: boolean;
  moreFailed?: boolean;
  onMore?: () => void;
}) {
  const { Copy, t } = miningDepthCopy.useCopy();
  const { timeZone } = usePreferences();
  const amounts = (rows: { assetId: string; amount: string }[]) =>
    rows.length ? rows.map((row) => `${displayAmount(row.amount)} ${row.assetId}`).join(', ') : null;
  const termsData = terms.resource.status === 'ready' ? terms.resource.data : null;
  const pendingData = pending.resource.status === 'ready' ? pending.resource.data : null;
  const rows = payouts.resource.status === 'ready' ? [...payouts.resource.data.payouts, ...extra] : null;
  const credited = rows ? amounts(sumByAsset(rows)) : null;
  // A payout whose amount can't be read is left out of the total, and the total says so. It is never counted as zero.
  const missing = rows?.some((row) => row.amount === null) ?? false;
  const estimated = pendingData
    ? amounts(sumByAsset(pendingData.windows.map((row) => ({ assetId: row.assetId, amount: row.estimate?.estimatedGross ?? null }))))
    : null;
  const loadingOf = (read: Read<unknown>) => read.resource.status === 'loading';
  const unknown = t('unknown');
  return (
    <div className="more-columns">
      <Panel title={t('rewardsTitle')}>
        <StatRow
          items={[
            {
              label: t('rewardsCredited'),
              value: loadingOf(payouts) ? '…' : rows ? (rows.length === 0 ? displayAmount('0') : (credited ?? unknown)) : unknown,
              ...(rows && missing && credited ? { note: t('creditedIncomplete') } : rows && hasMore ? { note: t('payoutsSoFar') } : {}),
            },
            {
              label: t('rewardsPending'),
              value: loadingOf(pending) ? '…' : pendingData ? (estimated ?? t('noEstimate')) : unknown,
              ...(pendingData ? { note: t('pendingEstimateNote') } : {}),
            },
            {
              label: t('rewardsFee'),
              value: loadingOf(terms)
                ? '…'
                : termsData
                  ? termsData.feeBps === null
                    ? t('notSet')
                    : t('feeValue', { percent: bpsToPercent(termsData.feeBps) })
                  : unknown,
            },
            {
              label: t('rewardsWindow'),
              value: loadingOf(terms)
                ? '…'
                : termsData
                  ? termsData.windowSize === null
                    ? t('notSet')
                    : t('windowSizeValue', { count: termsData.windowSize })
                  : unknown,
            },
          ]}
        />
        <p className="muted">
          <Copy k="rewardsMethod" />
        </p>
        <Read resource={payouts.resource} retry={payouts.reload}>
          {(page) => {
            const all = [...page.payouts, ...extra];
            return all.length === 0 ? (
              <EmptyState title={<Copy k="payoutsNone" />}>
                <Copy k="payoutsNoneBody" />
              </EmptyState>
            ) : (
              <>
                <DataTable headers={[t('payoutPaid'), t('payoutAmount')]} label={t('payoutsTitle')}>
                  {all.map((row) => (
                    <tr key={`${row.windowId}:${row.minerId}`}>
                      <td>
                        {row.paidAt ? stamp(row.paidAt, timeZone) : '—'}
                        {row.ledgerReason ? (
                          <>
                            <br />
                            <small className="muted">{t('payoutUnconfirmed')}</small>
                          </>
                        ) : null}
                      </td>
                      <td className="numeric">
                        {row.amount === null ? t('payoutAmountMissing') : `${displayAmount(row.amount)} ${row.assetId}`}
                      </td>
                    </tr>
                  ))}
                </DataTable>
                {hasMore ? (
                  <Button variant="ghost" disabled={busy} onClick={onMore}>
                    <Copy k="payoutsMore" />
                  </Button>
                ) : null}
                {moreFailed ? (
                  <p role="status" className="muted">
                    <Copy k="moreFailed" />
                  </p>
                ) : null}
                <p className="muted">{t('asOf', { time: stamp(page.asOf, timeZone) })}</p>
              </>
            );
          }}
        </Read>
        <DisabledAction label={t('rewardsExport')} reason={t('rewardsExportReason')} />
      </Panel>
      <Panel title={t('openWindows')}>
        <Read resource={pending.resource} retry={pending.reload}>
          {(data) =>
            data.windows.length === 0 ? (
              <EmptyState title={<Copy k="pendingNone" />}>
                <Copy k="pendingNoneBody" />
              </EmptyState>
            ) : (
              <DataTable
                headers={[t('sharesWindowCol'), t('pendingMine'), t('pendingTotal'), t('pendingReward'), t('pendingEstimate')]}
                label={t('openWindows')}
              >
                {data.windows.map((row, index) => (
                  <tr key={row.windowId}>
                    <td>{t('openWindowN', { n: index + 1 })}</td>
                    <td className="numeric">{displayAmount(row.callerWeight)}</td>
                    <td className="numeric">{row.totalWeight === null ? '—' : displayAmount(row.totalWeight)}</td>
                    <td className="numeric">{row.reward === null ? '—' : `${displayAmount(row.reward)} ${row.assetId}`}</td>
                    <td className="numeric">
                      {row.estimate ? `${displayAmount(row.estimate.estimatedGross)} ${row.assetId}` : t('noEstimate')}
                    </td>
                  </tr>
                ))}
              </DataTable>
            )
          }
        </Read>
        <p>
          <Copy k="rewardsDestinationBody" />
        </p>
      </Panel>
    </div>
  );
}
