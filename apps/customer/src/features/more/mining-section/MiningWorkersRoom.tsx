// volt-room: /mining/workers
import { useState } from 'react';
import { Button, Field, Radio, Select } from '@intafaced/ui/lit';
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { displayAmount } from '../../../shared/money';
import { usePreferences } from '../../../shared/preferences';
import type { Resource } from '../../../shared/resource';
import { stamp } from '../../../screens/money/time';
import { useMiningWorkers } from '../MiningRooms';
import { miningCopy } from '../mining-copy';
import { miningDepthCopy } from '../mining-depth-copy';
import {
  EMISSION_UNPUBLISHED,
  MODE_CHANGE_IN_WINDOW,
  WINDOW_MINUTES,
  WORKER_MODES,
  type MinerWorkers,
  type PowSpec,
  type WorkerMode,
} from '../mining-reads';
import { miningWorkersCopy } from '../mining-workers-copy';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';
import { EmptyNote, FailureNote, KitRead, ScrollTable, Section } from '../volt-parts';
import { MiningSections } from './MiningStatusRoom';

type Read<T> = { resource: Resource<T>; reload: () => void };
type Failed = Extract<ApiResult<unknown>, { ok: false }>;
type SaveState =
  { status: 'idle' } | { status: 'busy' } | { status: 'saved'; worker: string; n: string | null } | { status: 'failed'; failure: Failed };
type ModeState =
  { status: 'idle' } | { status: 'busy' } | { status: 'saved'; worker: string; mode: WorkerMode } | { status: 'failed'; failure: Failed };

const DIFFICULTY = /^[1-9]\d{0,37}$/;

/**
 * `/mining/workers` on the record-list template (J-more-catalogue-05 #5–#7): the account's workers roster with window
 * filter, search, paging, minimum difficulty, pooled/solo mode, proof-of-work parameters and honest registration
 * blocker. Uses the same reads and calls as `../MiningRooms.tsx`.
 */
export function MiningWorkersRoom({ paper }: { paper: boolean }) {
  const { read, minutes, onMinutes, filter, onFilter, paged, onPage, onSetDifficulty, onSetMode, pow, soloCredit } = useMiningWorkers();
  const { Copy, t } = miningDepthCopy.useCopy();
  const w = miningWorkersCopy.useCopy().t;
  const scope = miningCopy.useCopy().t('scope');
  const routes = moreRoomRoutesCopy.useCopy();
  const { timeZone } = usePreferences();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState<SaveState>({ status: 'idle' });

  return (
    <RecordListTemplate
      title={routes.t('workers')}
      description={scope}
      state={{ kind: 'ready' }}
      filters={<MiningSections value="Workers" paper={paper} />}
      list={
        <div className="lt-stack">
          <Section title={t('workersRoster')} className="lt-stack">
            <div className="lt-toolbar">
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
                onChange={(event) => onFilter(event.target.value.replace(/[^A-Za-z0-9_-]/g, ''))}
              />
            </div>
            <KitRead resource={read.resource} retry={read.reload}>
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
                      <EmptyNote title={w('noMatch')} />
                    ) : (
                      <EmptyNote title={<Copy k="workersEmpty" />}>
                        <Copy k="workersEmptyBody" />
                      </EmptyNote>
                    )
                  ) : (
                    <ScrollTable
                      headers={[t('rosterName'), w('rosterMode'), t('rosterWeight'), w('rosterMinDifficulty'), t('rosterAdded')]}
                      label={t('workersRoster')}
                    >
                      {data.workers.map((worker) => (
                        <tr key={worker.id}>
                          <td lang="und">{worker.name}</td>
                          <td>{w(`mode_${worker.mode}`)}</td>
                          <td className="lt-num">{worker.hashrate === null ? t('rosterNoShares') : displayAmount(worker.hashrate)}</td>
                          <td className="lt-num">{worker.minDifficulty === null ? w('automatic') : worker.minDifficulty}</td>
                          <td>{stamp(worker.createdAt, timeZone)}</td>
                        </tr>
                      ))}
                    </ScrollTable>
                  )}
                  <div className="lt-actions">
                    {paged ? (
                      <Button tone="secondary" onClick={() => onPage(null)}>
                        {w('firstPage')}
                      </Button>
                    ) : null}
                    {data.nextCursor !== null ? (
                      <Button tone="secondary" onClick={() => onPage(data.nextCursor)}>
                        {w('nextPage')}
                      </Button>
                    ) : null}
                  </div>
                  <p className="lt-muted">
                    <Copy k="workersNote" />
                  </p>
                  <p className="lt-muted">{t('asOf', { time: stamp(data.asOf, timeZone) })}</p>
                </>
              )}
            </KitRead>
          </Section>
          <Section title={w('difficultyTitle')} className="lt-stack">
            <KitRead resource={read.resource} retry={read.reload}>
              {(data) =>
                data.workers.length === 0 ? (
                  <p className="lt-muted">{w('noWorkerToSet')}</p>
                ) : (
                  <DifficultyForm workers={data.workers} onSet={onSetDifficulty} onSaved={read.reload} state={saving} onState={setSaving} />
                )
              }
            </KitRead>
            <p role="status" className="lt-muted">
              {saving.status === 'busy'
                ? w('saving')
                : saving.status === 'saved'
                  ? saving.n === null
                    ? w('savedAutomatic', { worker: saving.worker })
                    : w('savedSet', { n: saving.n, worker: saving.worker })
                  : ''}
            </p>
            {saving.status === 'failed' ? <FailureNote result={saving.failure} /> : null}
            <p className="lt-muted">{w('difficultyNote')}</p>
          </Section>
          <ModeForm onSet={onSetMode} onSaved={read.reload} />
        </div>
      }
      detail={
        <div className="lt-stack">
          <PowPanel pow={pow} soloCredit={soloCredit} />
          <Section title={t('workersRegister')} className="lt-stack">
            <Field
              label={t('workerName')}
              hint={t('workerNameHint')}
              value={name}
              maxLength={64}
              onChange={(event) => setName(event.target.value.replace(/[^A-Za-z0-9_-]/g, ''))}
            />
            <div className="lt-stack">
              <div className="lt-actions">
                <Button tone="primary" disabled aria-disabled="true">
                  {t('workerRegisterAction')}
                </Button>
              </div>
              <p className="lt-hint" role="note">
                {t('workerRegisterReason')}
              </p>
            </div>
          </Section>
        </div>
      }
    />
  );
}

function ModeForm({
  onSet,
  onSaved,
}: {
  onSet: (name: string, mode: WorkerMode) => Promise<ApiResult<{ id: string; name: string; mode: WorkerMode }>>;
  onSaved: () => void;
}) {
  const w = miningWorkersCopy.useCopy().t;
  const [rig, setRig] = useState('');
  const [mode, setMode] = useState<WorkerMode>('pooled');
  const [state, setState] = useState<ModeState>({ status: 'idle' });
  async function save() {
    if (rig === '') return;
    setState({ status: 'busy' });
    const result = await onSet(rig, mode);
    if (!result.ok) return setState({ status: 'failed', failure: result });
    setState({ status: 'saved', worker: result.data.name, mode: result.data.mode });
    onSaved();
  }
  return (
    <Section title={w('modeTitle')} className="lt-stack">
      <Field
        label={w('modeRig')}
        hint={w('modeRigHint')}
        value={rig}
        maxLength={64}
        onChange={(event) => setRig(event.target.value.replace(/[^A-Za-z0-9_-]/g, ''))}
      />
      <fieldset className="lt-group lt-actions" disabled={state.status === 'busy'}>
        <legend>{w('modeLegend')}</legend>
        {WORKER_MODES.map((option) => (
          <Radio key={option} name="mining-worker-mode" value={option} checked={mode === option} onSelect={() => setMode(option)}>
            {w(`mode_${option}`)}
          </Radio>
        ))}
      </fieldset>
      <div className="lt-actions">
        <Button tone="primary" disabled={rig === '' || state.status === 'busy'} onClick={() => void save()}>
          {w('modeSave')}
        </Button>
      </div>
      <p role="status" className="lt-muted" data-testid="mining-mode-status">
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
          <FailureNote result={state.failure} />
        )
      ) : null}
      <p className="lt-muted">{w('modeNote')}</p>
    </Section>
  );
}

function PowPanel({ pow, soloCredit }: { pow: Read<PowSpec>; soloCredit: Read<never> }) {
  const w = miningWorkersCopy.useCopy().t;
  return (
    <Section title={w('powTitle')} className="lt-stack">
      <KitRead resource={pow.resource} retry={pow.reload}>
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
      </KitRead>
      <p className="lt-muted">{w('powNote')}</p>
      {soloCredit.resource.status === 'failed' ? (
        soloCredit.resource.failure.code === EMISSION_UNPUBLISHED ? (
          <p role="status" data-testid="mining-solo-credit" data-code={EMISSION_UNPUBLISHED}>
            {w('soloCredit')}
          </p>
        ) : (
          <FailureNote result={soloCredit.resource.failure} retry={soloCredit.reload} />
        )
      ) : null}
    </Section>
  );
}

function DifficultyForm({
  workers,
  onSet,
  onSaved,
  state,
  onState: setState,
}: {
  workers: MinerWorkers['workers'];
  onSet: (workerId: string, minDifficulty: string | null) => Promise<ApiResult<{ id: string; minDifficulty: string | null }>>;
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
    if (!worker) return;
    setState({ status: 'busy' });
    const result = await onSet(worker.id, minDifficulty);
    if (!result.ok) return setState({ status: 'failed', failure: result });
    setState({ status: 'saved', worker: worker.name, n: result.data.minDifficulty });
    onSaved();
  }
  return (
    <div className="lt-stack">
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
      <div className="lt-actions">
        <Button tone="primary" disabled={state.status === 'busy' || value === '' || invalid} onClick={() => void save(value)}>
          {w('save')}
        </Button>
        <Button tone="secondary" disabled={state.status === 'busy'} onClick={() => void save(null)}>
          {w('useAutomatic')}
        </Button>
      </div>
    </div>
  );
}
