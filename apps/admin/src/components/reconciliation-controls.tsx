'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { formatAsOf } from '@/lib/as-of';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import { founderMutationHeaders } from '@/lib/founder-browser';
import {
  ACCOUNT_KINDS,
  LIFECYCLE_LABELS,
  STATE_LABELS,
  CADENCES,
  CONTROL_SEVERITIES,
  CONTROL_TEMPLATES,
  OWNER_TYPES,
  buildDefineBody,
  buildUpdateBody,
  controlRefusal,
  describeAccountSet,
  describeRun,
  describeSchedule,
  describeThreshold,
  describeTolerance,
  emptyControlForm,
  formFromControl,
  isMargin,
  lifecycleMoves,
  runInstant,
  runMargin,
  type ControlForm,
  type ReconciliationControlRunView,
  type ReconciliationControlView,
  type ReconciliationLifecycle,
} from '@/lib/ledger/reconciliation';
import './reconciliation-controls.css';

/**
 * Reconciliation controls (J-ops-console-07 steps 1-4, OPS-reconciliation-01): the controls svc-ledger holds, a form to define
 * one or change one, and a two-founder request to run one now or at a past instant.
 *
 * The list is read as the signed-in founder. Define, change and run need the treasury transport; a console without it keeps
 * every form on screen with the missing setting named next to it, and sends nothing. The console never fills a blank policy
 * value: a blank stays blank, and svc-ledger's own refusal is what the founder reads.
 */

type ListView =
  | { readonly kind: 'loading' }
  /** `refreshing`: a new read is on its way. The last list stays on screen, so a form being filled in is not thrown away. */
  | {
      readonly kind: 'ready';
      readonly controls: readonly ReconciliationControlView[];
      readonly readAt: string;
      readonly refreshing?: boolean;
      /** The last re-read was refused: the list above it is the earlier read, kept so nothing typed is lost. */
      readonly stale?: { readonly code: string | null; readonly status: number };
    }
  | { readonly kind: 'refused'; readonly code: string | null; readonly status: number };

type SaveView =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved'; readonly control: ReconciliationControlView }
  | { readonly kind: 'refused'; readonly code: string | null; readonly status: number; readonly detail: string | null };

export interface ReconciliationControlsProps {
  /** Why define, change and run cannot be sent from this console (the treasury transport is missing), or null. */
  readonly treasuryParked: string | null;
  /** The signed-in founder's identity user id: tells the requester from the second founder on the run desk. */
  readonly userId: string;
}

export function ReconciliationControls({ treasuryParked, userId }: ReconciliationControlsProps) {
  const [list, setList] = useState<ListView>({ kind: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const sequence = useRef(0);

  const read = useCallback(async () => {
    const request = ++sequence.current;
    setList((prev) => (prev.kind === 'ready' ? { ...prev, refreshing: true } : { kind: 'loading' }));
    let next: ListView;
    try {
      const res = await fetch('/api/ledger-reconciliation', { cache: 'no-store', credentials: 'same-origin' });
      const body = (await res.json().catch(() => null)) as {
        controls?: unknown;
        readAt?: unknown;
        code?: unknown;
        upstream?: unknown;
      } | null;
      if (res.ok && Array.isArray(body?.controls) && typeof body?.readAt === 'string') {
        next = { kind: 'ready', controls: body.controls as ReconciliationControlView[], readAt: body.readAt };
      } else {
        const code = typeof body?.upstream === 'string' ? body.upstream : typeof body?.code === 'string' ? body.code : null;
        next = { kind: 'refused', code, status: res.status };
      }
    } catch {
      next = { kind: 'refused', code: 'admin.upstream_unavailable', status: 503 };
    }
    if (request !== sequence.current) return;
    setList((prev) =>
      next.kind === 'refused' && prev.kind === 'ready'
        ? { kind: 'ready', controls: prev.controls, readAt: prev.readAt, stale: { code: next.code, status: next.status } }
        : next,
    );
  }, []);

  useEffect(() => {
    void read();
    return () => {
      sequence.current += 1;
    };
  }, [read]);

  return (
    <ReconciliationControlsView
      list={list}
      selectedId={selectedId}
      onSelect={setSelectedId}
      onRead={() => void read()}
      treasuryParked={treasuryParked}
      userId={userId}
    />
  );
}

export type { ListView as ReconciliationListView };

export interface ReconciliationControlsViewProps extends ReconciliationControlsProps {
  readonly list: ListView;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onRead: () => void;
}

/** The section in each state it can hold, rendered without effects so every state is a test. */
export function ReconciliationControlsView({
  list,
  selectedId,
  onSelect,
  onRead,
  treasuryParked,
  userId,
}: ReconciliationControlsViewProps) {
  const controls = list.kind === 'ready' ? list.controls : [];
  const selected = controls.find((control) => control.id === selectedId) ?? null;
  const reading = list.kind === 'loading' || (list.kind === 'ready' && list.refreshing === true);
  // A run does not change the control's version, so each run the desk reports re-reads the evaluations panel.
  const [runsRead, setRunsRead] = useState(0);

  return (
    <section className="adm-control-card rc" data-testid="reconciliation-controls" aria-labelledby="rc-heading">
      <div className="rc-head">
        <div>
          <h2 id="rc-heading">Reconciliation controls</h2>
          <p className="adm-subtle">
            Checks svc-ledger runs on the book: a schedule in UTC, a severity, a tolerance and the accounts each one reads. The three
            built-in controls cover the whole book and cannot be changed or removed. A run is read-only: nothing posts and nothing freezes.
          </p>
        </div>
        <button type="button" className="adm-btn" onClick={onRead} disabled={reading}>
          {list.kind === 'refused' ? 'Retry read' : 'Refresh'}
        </button>
      </div>

      {treasuryParked && (
        <div className="adm-callout" data-tone="danger" role="status" data-testid="rc-treasury-parked">
          <strong>Define, change and run are parked on this console</strong>
          <p>{treasuryParked}</p>
          <p className="adm-subtle">The list below is read with your own founder sign-in, so it still works.</p>
        </div>
      )}

      {reading && <p className="adm-subtle">Reading the controls…</p>}
      {list.kind === 'ready' && list.stale && (
        <p className="adm-alert" role="alert" data-testid="rc-list-stale">
          The controls could not be read again, so the list below is the earlier read. {controlRefusal(list.stale.code, list.stale.status)}{' '}
          {list.stale.code && <span className="adm-subtle">({list.stale.code})</span>}
        </p>
      )}
      {list.kind === 'refused' && (
        <p className="adm-alert" role="alert" data-testid="rc-list-refused">
          {controlRefusal(list.code, list.status)} {list.code && <span className="adm-subtle">({list.code})</span>}
        </p>
      )}
      {list.kind === 'ready' && <ControlTable controls={list.controls} readAt={list.readAt} selectedId={selectedId} onSelect={onSelect} />}

      <details className="rc-block" data-testid="rc-define">
        <summary>Define a control</summary>
        <ControlEditor mode="define" control={null} parked={treasuryParked} onSaved={(control) => (onSelect(control.id), onRead())} />
      </details>

      <div className="rc-block" data-testid="rc-selected">
        <h3>{selected ? `Control ${selected.id.slice(0, 8)}` : 'Change or run a control'}</h3>
        {!selected && <p className="adm-subtle">Choose a control in the list to change it or run it.</p>}
        {selected?.builtin && (
          <p className="adm-subtle" data-testid="rc-builtin">
            Built-in: this control cannot be changed or removed. It can be run.
          </p>
        )}
        {selected?.state === 'retired' && (
          <p className="adm-subtle" data-testid="rc-retired">
            Retired: this control is final. Its history stays, and it can no longer be changed or run.
          </p>
        )}
        {selected && !selected.builtin && selected.state !== 'retired' && (
          <ControlEditor key={selected.id} mode="update" control={selected} parked={treasuryParked} onSaved={() => onRead()} />
        )}
      </div>

      <LifecycleDesk
        key={`lifecycle:${selected?.id ?? 'none'}`}
        control={selected}
        parked={treasuryParked}
        userId={userId}
        onChanged={onRead}
      />

      <RunDesk
        key={selected?.id ?? 'none'}
        control={selected}
        parked={treasuryParked}
        userId={userId}
        onChanged={() => {
          setRunsRead((n) => n + 1);
          onRead();
        }}
      />

      {selected && <RunHistory key={`runs:${selected.id}:${selected.version}:${runsRead}`} control={selected} />}
    </section>
  );
}

function ControlTable({
  controls,
  readAt,
  selectedId,
  onSelect,
}: {
  controls: readonly ReconciliationControlView[];
  readAt: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="rc-list">
      <p className="adm-subtle">
        As of <time dateTime={readAt}>{formatAsOf(readAt)}</time> · {controls.length} control{controls.length === 1 ? '' : 's'}
      </p>
      {controls.length === 0 ? (
        <p data-testid="rc-empty">svc-ledger holds no controls.</p>
      ) : (
        <div className="adm-table-scroll">
          <table className="adm-table" data-testid="rc-table">
            <thead>
              <tr>
                <th scope="col">Control</th>
                <th scope="col">State</th>
                <th scope="col">Schedule</th>
                <th scope="col">Severity</th>
                <th scope="col">Tolerance</th>
                <th scope="col">Margin (s)</th>
                <th scope="col">Accounts</th>
                <th scope="col">Version</th>
                <th scope="col">
                  <span className="adm-sr-only">Choose</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {controls.map((control) => {
                const threshold = describeThreshold(control);
                return (
                  <tr key={control.id} data-testid="rc-row" data-control-id={control.id} aria-selected={control.id === selectedId}>
                    <td>
                      <strong>{control.template.replace(/_/g, ' ')}</strong>
                      {control.builtin && <span className="adm-chip rc-chip">Built-in</span>}
                      {control.explanation && <div className="adm-subtle">{control.explanation}</div>}
                      {threshold && <div className="adm-subtle">Threshold: {threshold}</div>}
                      <div className="adm-subtle" lang="zxx">
                        {control.id}
                      </div>
                    </td>
                    <td data-testid="rc-state">{STATE_LABELS[control.state]}</td>
                    <td>{describeSchedule(control)}</td>
                    <td>{control.severity.status === 'set' ? control.severity.value : 'Not set'}</td>
                    <td>{describeTolerance(control)}</td>
                    <td>{control.margin.status === 'set' ? control.margin.value : 'Not set'}</td>
                    <td>{describeAccountSet(control)}</td>
                    <td lang="zxx">{control.version}</td>
                    <td>
                      <button
                        type="button"
                        className="adm-btn"
                        onClick={() => onSelect(control.id)}
                        aria-pressed={control.id === selectedId}
                      >
                        {control.id === selectedId ? 'Chosen' : 'Choose'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ControlEditor({
  mode,
  control,
  parked,
  onSaved,
}: {
  mode: 'define' | 'update';
  control: ReconciliationControlView | null;
  parked: string | null;
  onSaved: (control: ReconciliationControlView) => void;
}) {
  const uid = useId();
  const [form, setForm] = useState<ControlForm>(() => (control ? formFromControl(control) : emptyControlForm()));
  const [save, setSave] = useState<SaveView>({ kind: 'idle' });
  const set = <K extends keyof ControlForm>(key: K, value: ControlForm[K]) => setForm((prev) => ({ ...prev, [key]: value }));
  const built = mode === 'define' ? buildDefineBody(form) : control ? buildUpdateBody(control, form) : buildDefineBody(form);
  const busy = save.kind === 'saving';
  const why = parked ? 'Parked: this console holds no treasury credential.' : !built.ok ? built.why : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || parked || !built.ok) return;
    setSave({ kind: 'saving' });
    try {
      const headers = await founderMutationHeaders();
      const res = await fetch('/api/ledger-reconciliation', {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ action: mode, body: built.body }),
      });
      const body = (await res.json().catch(() => null)) as {
        control?: ReconciliationControlView;
        code?: unknown;
        upstream?: unknown;
        detail?: unknown;
      } | null;
      if (res.ok && body?.control) {
        setSave({ kind: 'saved', control: body.control });
        if (mode === 'define') setForm(emptyControlForm());
        onSaved(body.control);
        return;
      }
      const code = typeof body?.upstream === 'string' ? body.upstream : typeof body?.code === 'string' ? body.code : null;
      setSave({ kind: 'refused', code, status: res.status, detail: typeof body?.detail === 'string' ? body.detail : null });
    } catch {
      setSave({ kind: 'refused', code: 'admin.upstream_unavailable', status: 503, detail: null });
    }
  };

  const field = (key: keyof ControlForm) => `${uid}${String(key)}`;
  return (
    <form className="rc-form" onSubmit={(event) => void submit(event)} data-testid={`rc-form-${mode}`}>
      {mode === 'define' && (
        <div className="adm-field">
          <label htmlFor={field('template')}>Template</label>
          <select
            id={field('template')}
            className="adm-select"
            value={form.template}
            onChange={(e) => set('template', e.target.value as ControlForm['template'])}
          >
            {CONTROL_TEMPLATES.map((template) => (
              <option key={template} value={template}>
                {template.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="adm-field">
        <label htmlFor={field('explanation')}>Explanation (optional)</label>
        <input
          id={field('explanation')}
          className="adm-input"
          value={form.explanation}
          maxLength={2000}
          onChange={(e) => set('explanation', e.target.value)}
        />
      </div>

      <fieldset className="rc-fieldset">
        <legend>Schedule (UTC)</legend>
        <div className="rc-grid">
          <div className="adm-field">
            <label htmlFor={field('cadence')}>Cadence</label>
            <select
              id={field('cadence')}
              className="adm-select"
              value={form.cadence}
              onChange={(e) => set('cadence', e.target.value as ControlForm['cadence'])}
            >
              <option value="">Not set</option>
              {CADENCES.map((cadence) => (
                <option key={cadence} value={cadence}>
                  {cadence}
                </option>
              ))}
            </select>
          </div>
          {form.cadence === 'weekly' && (
            <div className="adm-field">
              <label htmlFor={field('isoWeekday')}>Weekday (1 Monday to 7 Sunday)</label>
              <input
                id={field('isoWeekday')}
                className="adm-input"
                inputMode="numeric"
                value={form.isoWeekday}
                onChange={(e) => set('isoWeekday', e.target.value)}
              />
            </div>
          )}
          {form.cadence === 'monthly' && (
            <div className="adm-field">
              <label htmlFor={field('day')}>Day of the month</label>
              <input
                id={field('day')}
                className="adm-input"
                inputMode="numeric"
                value={form.day}
                onChange={(e) => set('day', e.target.value)}
              />
            </div>
          )}
          {form.cadence !== '' && form.cadence !== 'hourly' && (
            <div className="adm-field">
              <label htmlFor={field('hour')}>Hour (UTC)</label>
              <input
                id={field('hour')}
                className="adm-input"
                inputMode="numeric"
                value={form.hour}
                onChange={(e) => set('hour', e.target.value)}
              />
            </div>
          )}
          {form.cadence !== '' && (
            <div className="adm-field">
              <label htmlFor={field('minute')}>Minute</label>
              <input
                id={field('minute')}
                className="adm-input"
                inputMode="numeric"
                value={form.minute}
                onChange={(e) => set('minute', e.target.value)}
              />
            </div>
          )}
        </div>
      </fieldset>

      <fieldset className="rc-fieldset">
        <legend>Policy</legend>
        <div className="rc-grid">
          <div className="adm-field">
            <label htmlFor={field('severity')}>Severity</label>
            <select
              id={field('severity')}
              className="adm-select"
              value={form.severity}
              onChange={(e) => set('severity', e.target.value as ControlForm['severity'])}
            >
              <option value="">Not set</option>
              {CONTROL_SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {severity}
                </option>
              ))}
            </select>
          </div>
          <div className="adm-field">
            <label htmlFor={field('toleranceDefault')}>Tolerance (blank is not set; 0 is zero)</label>
            <input
              id={field('toleranceDefault')}
              className="adm-input"
              inputMode="decimal"
              value={form.toleranceDefault}
              onChange={(e) => set('toleranceDefault', e.target.value)}
            />
          </div>
          <div className="adm-field">
            <label htmlFor={field('toleranceByAsset')}>Tolerance by asset (ASSET=amount, comma separated)</label>
            <input
              id={field('toleranceByAsset')}
              className="adm-input"
              value={form.toleranceByAsset}
              onChange={(e) => set('toleranceByAsset', e.target.value)}
            />
          </div>
          <div className="adm-field">
            <label htmlFor={field('margin')}>Margin in seconds (read before a past instant)</label>
            <input
              id={field('margin')}
              className="adm-input"
              inputMode="decimal"
              value={form.margin}
              onChange={(e) => set('margin', e.target.value)}
            />
          </div>
        </div>
        {(form.template === 'threshold' || form.thresholdByAsset !== '') && (
          <div className="rc-grid">
            <div className="adm-field">
              <label htmlFor={field('thresholdBound')}>Threshold bound</label>
              <select
                id={field('thresholdBound')}
                className="adm-select"
                value={form.thresholdBound}
                onChange={(e) => set('thresholdBound', e.target.value as ControlForm['thresholdBound'])}
              >
                <option value="">Not set</option>
                <option value="min">At least (minimum)</option>
                <option value="max">At most (maximum)</option>
              </select>
            </div>
            <div className="adm-field">
              <label htmlFor={field('thresholdByAsset')}>Threshold by asset (ASSET=amount)</label>
              <input
                id={field('thresholdByAsset')}
                className="adm-input"
                value={form.thresholdByAsset}
                onChange={(e) => set('thresholdByAsset', e.target.value)}
              />
            </div>
          </div>
        )}
      </fieldset>

      <fieldset className="rc-fieldset">
        <legend>Accounts</legend>
        <div className="adm-field">
          <label htmlFor={field('accountMode')}>Account set</label>
          <select
            id={field('accountMode')}
            className="adm-select"
            value={form.accountMode}
            onChange={(e) => set('accountMode', e.target.value as ControlForm['accountMode'])}
          >
            <option value="query">Every account matching filters (a new matching account joins the next run)</option>
            <option value="explicit">Named accounts</option>
          </select>
        </div>
        {form.accountMode === 'explicit' ? (
          <div className="adm-field">
            <label htmlFor={field('accountIds')}>Account ids (one per line, at most 500)</label>
            <textarea
              id={field('accountIds')}
              className="adm-textarea"
              rows={3}
              value={form.accountIds}
              onChange={(e) => set('accountIds', e.target.value)}
            />
          </div>
        ) : (
          <div className="rc-grid">
            <div className="adm-field">
              <label htmlFor={field('assetId')}>Asset</label>
              <input id={field('assetId')} className="adm-input" value={form.assetId} onChange={(e) => set('assetId', e.target.value)} />
            </div>
            <div className="adm-field">
              <label htmlFor={field('ownerType')}>Owner type</label>
              <select
                id={field('ownerType')}
                className="adm-select"
                value={form.ownerType}
                onChange={(e) => set('ownerType', e.target.value as ControlForm['ownerType'])}
              >
                <option value="">Any</option>
                {OWNER_TYPES.map((owner) => (
                  <option key={owner} value={owner}>
                    {owner}
                  </option>
                ))}
              </select>
            </div>
            <div className="adm-field">
              <label htmlFor={field('accountKind')}>Account kind</label>
              <select
                id={field('accountKind')}
                className="adm-select"
                value={form.accountKind}
                onChange={(e) => set('accountKind', e.target.value as ControlForm['accountKind'])}
              >
                <option value="">Any</option>
                {ACCOUNT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </div>
            <div className="adm-field">
              <label htmlFor={field('ownerIdPrefix')}>Owner id starts with</label>
              <input
                id={field('ownerIdPrefix')}
                className="adm-input"
                value={form.ownerIdPrefix}
                onChange={(e) => set('ownerIdPrefix', e.target.value)}
              />
            </div>
            <div className="adm-field">
              <label htmlFor={field('rail')}>Rail boundary</label>
              <input id={field('rail')} className="adm-input" value={form.rail} onChange={(e) => set('rail', e.target.value)} />
            </div>
            <div className="adm-field">
              <label htmlFor={field('purpose')}>Purpose</label>
              <input id={field('purpose')} className="adm-input" value={form.purpose} onChange={(e) => set('purpose', e.target.value)} />
            </div>
          </div>
        )}
      </fieldset>

      <div className="adm-field">
        <label htmlFor={field('labels')}>Labels (comma separated, optional)</label>
        <input id={field('labels')} className="adm-input" value={form.labels} onChange={(e) => set('labels', e.target.value)} />
      </div>
      {control?.state === 'active' || control?.state === 'paused' ? (
        <p className="adm-subtle" data-testid="rc-active-note">
          {control.state === 'active' ? 'Active. Saving keeps it active.' : 'Paused. Saving keeps it paused; resume it below.'} Pause,
          resume and retire are below.
        </p>
      ) : (
        <label className="rc-check">
          <input type="checkbox" checked={form.activate} onChange={(e) => set('activate', e.target.checked)} />{' '}
          {mode === 'define' ? 'Activate it now' : 'Activate it'}
        </label>
      )}
      <div className="adm-field">
        <label htmlFor={field('reason')}>Why (recorded with the change, 12 to 500 characters)</label>
        <textarea
          id={field('reason')}
          className="adm-textarea"
          rows={2}
          maxLength={500}
          value={form.reason}
          onChange={(e) => set('reason', e.target.value)}
        />
      </div>
      <div className="dk-row">
        <button type="submit" className="adm-btn" data-tone="primary" disabled={busy || why !== null}>
          {busy ? 'Sending…' : mode === 'define' ? 'Define control' : 'Save changes'}
        </button>
        {why && (
          <span className="dk-why" data-testid="rc-form-why">
            {why}
          </span>
        )}
      </div>
      {save.kind === 'saved' && (
        <p role="status" data-testid="rc-saved">
          Saved. Control {save.control.id.slice(0, 8)} is {STATE_LABELS[save.control.state].toLowerCase()} at version {save.control.version}
          .
        </p>
      )}
      {save.kind === 'refused' && (
        <p className="adm-alert" role="alert" data-testid="rc-save-refused">
          {save.detail ?? controlRefusal(save.code, save.status)} {save.code && <span className="adm-subtle">({save.code})</span>}
        </p>
      )}
    </form>
  );
}

/**
 * Pause, resume and retire (OPS-reconciliation-02), each a TWO-FOUNDER request like a run: one founder proposes the move bound
 * to the control's version and the reason, a different founder approves exactly that, and svc-ledger spends the approval once
 * under the control's row lock. A paused control runs nothing until it is resumed, and resuming checks the policy again; retired
 * is final and keeps its history. Only the moves svc-ledger accepts from the control's state are offered; it still refuses any other.
 */
function LifecycleDesk({
  control,
  parked,
  userId,
  onChanged,
}: {
  control: ReconciliationControlView | null;
  parked: string | null;
  userId: string;
  onChanged: () => void;
}) {
  const uid = useId();
  const moves = control ? lifecycleMoves(control) : [];
  const [picked, setPicked] = useState<ReconciliationLifecycle | null>(null);
  const move = picked && moves.includes(picked) ? picked : (moves[0] ?? null);
  const hold = !control
    ? 'Choose a control in the list first.'
    : control.builtin
      ? 'A built-in control cannot be paused or retired (ledger.reconcile_builtin_immutable).'
      : move === null
        ? `A ${control.state} control has no pause, resume or retire step (ops.control_state_illegal).`
        : null;
  const action: ControlAction | null =
    control && move
      ? {
          heading: `${LIFECYCLE_LABELS[move]} control ${control.id.slice(0, 8)}`,
          submitLabel: `Ask a second founder to approve: ${LIFECYCLE_LABELS[move].toLowerCase()}`,
          needsReason: true,
          reasonLabel: 'Why (recorded with the step, 12 to 500 characters)',
          danger: move === 'retire',
          build: (reason) => ({
            kind: 'ledger.reconciliation_control.lifecycle',
            controlId: control.id,
            version: String(control.version),
            lifecycle: move,
            reason,
          }),
        }
      : null;
  return (
    <div className="rc-block" data-testid="rc-lifecycle">
      <h3>Pause, resume or retire a control</h3>
      <p className="adm-subtle">
        Two founders: one asks, a different one approves the exact control, move and reason, then either carries it out. A paused control
        runs nothing, on schedule or by hand, until it is resumed; periods that fell due while it was paused are not caught up. Retired is
        final: the control and its runs stay on record and it never runs again.
      </p>
      {moves.length > 1 && (
        <div className="adm-field">
          <label htmlFor={`${uid}move`}>Step</label>
          <select
            id={`${uid}move`}
            className="adm-input"
            data-testid="rc-lifecycle-move"
            value={move ?? ''}
            onChange={(e) => setPicked(e.target.value as ReconciliationLifecycle)}
          >
            {moves.map((m) => (
              <option key={m} value={m}>
                {LIFECYCLE_LABELS[m]}
              </option>
            ))}
          </select>
        </div>
      )}
      {hold && (
        <p className="adm-subtle" data-testid="rc-lifecycle-why">
          {hold}
        </p>
      )}
      {/* One desk per control, not per move: after a move runs, the re-read changes the legal moves, and the service's answer
          must stay on screen. The confirm phrase names the move, so switching the step cannot send the wrong one. */}
      <ControlDesk
        endpoint="/api/ledger-reconciliation/lifecycle"
        userId={userId}
        blockedReason={parked}
        action={action}
        formHold={hold}
        consequence={
          move === 'pause'
            ? 'The scheduler and runs on demand skip it until it is resumed. Its policy, runs and history stay.'
            : move === 'resume'
              ? 'It runs on its schedule again from now. Periods that fell due while it was paused are not caught up.'
              : move === 'retire'
                ? 'It never runs again and cannot be edited or brought back. Its row, runs and history stay.'
                : 'Nothing to do for this control.'
        }
        blockedButtonLabel="Pause, resume or retire unavailable"
        onChanged={onChanged}
      />
    </div>
  );
}

function RunDesk({
  control,
  parked,
  userId,
  onChanged,
}: {
  control: ReconciliationControlView | null;
  parked: string | null;
  userId: string;
  onChanged: () => void;
}) {
  const uid = useId();
  const [instant, setInstant] = useState('');
  const [margin, setMargin] = useState('');
  const asOf = runInstant(instant);
  const chosenMargin = control && asOf ? runMargin(asOf, margin, control) : null;
  const future = asOf !== null && asOf !== 'now' && Date.parse(asOf) > Date.now();
  const hold = !control
    ? 'Choose a control in the list first.'
    : control.state !== 'active'
      ? control.state === 'paused'
        ? 'A paused control runs nothing (ops.control_state_illegal). Resume it first.'
        : control.state === 'retired'
          ? 'A retired control runs nothing (ops.control_state_illegal). Its history stays.'
          : 'Only an active control can run (ops.control_state_illegal). Activate it first.'
      : asOf === null
        ? 'The instant is not a date and time. Leave it blank to run now.'
        : future
          ? 'The instant is in the future (ledger.reconcile_asof_invalid). A run reads only the past.'
          : chosenMargin === null && margin.trim() !== '' && !isMargin(margin.trim())
            ? 'The margin is a number of seconds, for example 30 or 0.5, with no sign or unit.'
            : chosenMargin === null
              ? 'A past instant needs a margin (ops.control_margin_unset): type one, or set it on the control. 0 is accepted.'
              : null;
  // The form stays on screen whenever a control is chosen; `hold` keeps it from sending until the instant and margin are ones
  // svc-ledger accepts, so the stand-in values below are only ever used to print the phrase, never sent.
  const action: ControlAction | null = control
    ? {
        heading: `Run control ${control.id.slice(0, 8)}`,
        submitLabel: 'Ask a second founder to approve the run',
        needsReason: true,
        reasonLabel: 'Why (recorded with the run, 12 to 500 characters)',
        build: (reason) => ({
          kind: 'ledger.reconciliation_control.run',
          controlId: control.id,
          version: String(control.version),
          asOf: asOf ?? 'now',
          margin: asOf && chosenMargin !== null ? chosenMargin : 'unset',
          reason,
        }),
      }
    : null;
  return (
    <div className="rc-block" data-testid="rc-run">
      <h3>Run a control</h3>
      <p className="adm-subtle">
        Two founders: one asks, a different one approves the exact control, instant, margin and reason, then either runs it. svc-ledger
        stores a result row before it reads, and stamps the time each source was read. An outside side with no snapshot shows as unset.
      </p>
      <div className="rc-grid">
        <div className="adm-field">
          <label htmlFor={`${uid}instant`}>At a past instant (UTC; blank runs now)</label>
          <input
            id={`${uid}instant`}
            className="adm-input"
            type="datetime-local"
            step={1}
            value={instant}
            onChange={(e) => setInstant(e.target.value)}
          />
        </div>
        <div className="adm-field">
          <label htmlFor={`${uid}margin`}>Margin in seconds (blank uses the control’s)</label>
          <input
            id={`${uid}margin`}
            className="adm-input"
            inputMode="decimal"
            value={margin}
            disabled={asOf === 'now'}
            onChange={(e) => setMargin(e.target.value)}
          />
        </div>
      </div>
      <ControlDesk
        endpoint="/api/ledger-reconciliation/run"
        userId={userId}
        blockedReason={parked}
        action={action}
        formHold={hold}
        consequence={
          asOf && asOf !== 'now'
            ? `Reads balances as of ${asOf} minus ${chosenMargin ?? 'the margin, in'} seconds. Nothing posts and nothing freezes.`
            : 'Reads the book now. Nothing posts and nothing freezes.'
        }
        blockedButtonLabel="Run control unavailable"
        onChanged={onChanged}
      />
    </div>
  );
}

type RunsView =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly total: number;
      readonly runs: readonly ReconciliationControlRunView[];
      readonly readAt: string;
    }
  | { readonly kind: 'refused'; readonly code: string | null; readonly status: number };

/**
 * One control's evaluations, newest first (OPS-reconciliation-02). Read as the signed-in founder in every state: a paused or
 * retired control keeps every evaluation, and so does this panel.
 */
function RunHistory({ control }: { control: ReconciliationControlView }) {
  const [view, setView] = useState<RunsView>({ kind: 'loading' });
  const sequence = useRef(0);
  const read = useCallback(async () => {
    const request = ++sequence.current;
    setView({ kind: 'loading' });
    let next: RunsView;
    try {
      const res = await fetch(`/api/ledger-reconciliation/runs?controlId=${encodeURIComponent(control.id)}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      const body = (await res.json().catch(() => null)) as {
        total?: unknown;
        runs?: unknown;
        readAt?: unknown;
        code?: unknown;
        upstream?: unknown;
      } | null;
      if (res.ok && typeof body?.total === 'number' && Array.isArray(body?.runs) && typeof body?.readAt === 'string') {
        next = { kind: 'ready', total: body.total, runs: body.runs as ReconciliationControlRunView[], readAt: body.readAt };
      } else {
        const code = typeof body?.upstream === 'string' ? body.upstream : typeof body?.code === 'string' ? body.code : null;
        next = { kind: 'refused', code, status: res.status };
      }
    } catch {
      next = { kind: 'refused', code: 'admin.upstream_unavailable', status: 503 };
    }
    if (request === sequence.current) setView(next);
  }, [control.id]);

  useEffect(() => {
    void read();
    return () => {
      sequence.current += 1;
    };
  }, [read]);

  return <RunHistoryView control={control} view={view} onRead={() => void read()} />;
}

export function RunHistoryView({ control, view, onRead }: { control: ReconciliationControlView; view: RunsView; onRead: () => void }) {
  return (
    <div className="rc-block" data-testid="rc-runs" data-control-id={control.id}>
      <div className="rc-head">
        <h3>Evaluations of control {control.id.slice(0, 8)}</h3>
        <button type="button" className="adm-btn" onClick={onRead} disabled={view.kind === 'loading'}>
          {view.kind === 'refused' ? 'Retry evaluations' : 'Reload evaluations'}
        </button>
      </div>
      <p className="adm-subtle">Every run svc-ledger stored for this control, newest first. A paused or retired control keeps them all.</p>
      {view.kind === 'loading' && <p className="adm-subtle">Reading the evaluations…</p>}
      {view.kind === 'refused' && (
        <p className="adm-alert" role="alert" data-testid="rc-runs-refused">
          {controlRefusal(view.code, view.status)} {view.code && <span className="adm-subtle">({view.code})</span>}
        </p>
      )}
      {view.kind === 'ready' && (
        <>
          <p className="adm-subtle" data-testid="rc-runs-count">
            As of <time dateTime={view.readAt}>{formatAsOf(view.readAt)}</time> · showing {view.runs.length} of {view.total} evaluation
            {view.total === 1 ? '' : 's'}
          </p>
          {view.runs.length === 0 ? (
            <p data-testid="rc-runs-empty">This control has no evaluations yet.</p>
          ) : (
            <ol className="rc-runs" data-testid="rc-runs-list">
              {view.runs.map((run) => (
                <li key={run.id} data-testid="rc-run-row" data-run-id={run.id} data-status={run.status}>
                  <p>{describeRun(run)}</p>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
