import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useApi } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { Button, DataTable, Failure, Field, Panel } from '../../shared/ui';
import { agentAutomationCopy, hasAutomationWords } from './agent-automation-copy';
import {
  OWN_AGENT_AUTOMATION_LIMITS,
  OWN_AGENT_TRIGGER_SUBJECTS,
  ownAgentScheduleSchema,
  ownAgentSchedulesSchema,
  ownAgentTriggerSchema,
  type OwnAgent,
  type OwnAgentAutoRun,
  type OwnAgentSchedule,
  type OwnAgentSchedules,
  type OwnAgentTrigger,
} from '@intafaced/contracts/agents-own';

/**
 * An own agent's Schedules and Triggers pages (AG-sessions-02). Every answer is svc-agents': a schedule's status, next
 * occurrence and recent occurrences (each at most one run, with how many workers woke for it), and a trigger's deliveries
 * and the runs they made. The pages re-read every few seconds, since occurrences and events arrive on their own. A
 * refusal is the service's, shown by name; a create whose answer was lost is sent again with its own key, so it can never
 * make two schedules.
 */

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const REFUSAL_REASONS: ReadonlySet<Failed['reason']> = new Set(['error', 'forbidden', 'not_mounted']);
const refusalCode = (failed: Failed): string | null =>
  REFUSAL_REASONS.has(failed.reason) && /^agents\.[a-z_.]+$/.test(failed.message) ? failed.message : null;

/** How often the pages re-read what svc-agents holds. */
const POLL_MS = 3_000;

function Answer({ failed }: { failed: Failed }) {
  const { t } = agentAutomationCopy.useCopy();
  const code = refusalCode(failed);
  if (!code) return <Failure result={failed} />;
  const key = `code_${code.replaceAll('.', '_')}`;
  return (
    <p role="alert">
      {hasAutomationWords(key) ? t(key) : t('code_other')} <code lang="zxx">{code}</code>
    </p>
  );
}

/** A read of svc-agents that keeps showing the last answer while it reads again, every POLL_MS. */
function usePolled<T>(read: () => Promise<ApiResult<T>>): { data: T | null; failed: Failed | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState<Failed | null>(null);
  const reading = useRef(read);
  reading.current = read;
  const reload = useCallback(() => {
    void reading.current().then((res) => {
      if (res.ok) {
        setData(res.data);
        setFailed(null);
      } else setFailed(res);
    });
  }, []);
  useEffect(() => {
    reload();
    const timer = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(timer);
  }, [reload]);
  return { data, failed, reload };
}

/** One create's key: a new one per press, kept while the answer is unknown so pressing again is the same request. */
function useCreateKey(prefix: string) {
  const keys = useRef({ visit: Date.now().toString(36), presses: 0, pending: null as string | null });
  return {
    next: () => {
      if (!keys.current.pending) {
        keys.current.presses += 1;
        keys.current.pending = `${prefix}:${keys.current.visit}:${keys.current.presses}`;
      }
      return keys.current.pending;
    },
    settle: () => {
      keys.current.pending = null;
    },
  };
}

/** What happened to one occurrence or event, in words: ran, skipped with its reason, refused with its code, or running. */
function Outcome({ run }: { run: OwnAgentAutoRun }) {
  const { t } = agentAutomationCopy.useCopy();
  if (run.state === 'skipped') {
    const reason = run.reasonCode ? `reason_${run.reasonCode.replaceAll('.', '_')}` : '';
    return (
      <>
        {t('outcome_skipped', { reason: hasAutomationWords(reason) ? t(reason) : (run.reasonCode ?? '') })}{' '}
        <code lang="zxx">{run.code}</code>
      </>
    );
  }
  if (run.state === 'refused' || run.state === 'failed') {
    return (
      <>
        {t(`outcome_${run.state}`)} <code lang="zxx">{run.code}</code>
      </>
    );
  }
  return <>{t(`outcome_${run.state}`)}</>;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);

export function SchedulesPage({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentAutomationCopy.useCopy();
  const { data, failed, reload } = usePolled(() => api.query('agents', 'own.schedules.list', { id: agent.id }, ownAgentSchedulesSchema));
  return (
    <Panel title={t('schedulesTitle')}>
      <p className="muted">{t('schedulesIntro')}</p>
      {failed && !data ? <Failure result={failed} retry={reload} /> : null}
      {data ? <Schedules agent={agent} held={data} onChanged={reload} /> : failed ? null : <p className="muted">{t('loading')}</p>}
    </Panel>
  );
}

function Schedules({ agent, held, onChanged }: { agent: OwnAgent; held: OwnAgentSchedules; onChanged: () => void }) {
  const api = useApi();
  const { t } = agentAutomationCopy.useCopy();
  const keys = useCreateKey(`own-schedule:${agent.id}`);
  const [repeat, setRepeat] = useState<'once' | 'repeat'>('repeat');
  const [interval, setIntervalText] = useState('');
  const [cap, setCap] = useState('');
  const [ask, setAsk] = useState('');
  const [refused, setRefused] = useState<Failed | null>(null);
  const [cancelRefused, setCancelRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const edited = () => keys.settle();

  async function create() {
    setBusy(true);
    setRefused(null);
    const res = await api.mutate(
      'agents',
      'own.schedules.create',
      { id: agent.id, createKey: keys.next(), repeat, intervalMinutes: repeat === 'repeat' ? interval : '', perRunCap: cap, ask },
      ownAgentScheduleSchema,
    );
    setBusy(false);
    if (res.ok || refusalCode(res)) keys.settle();
    if (!res.ok) return setRefused(res);
    setOpen(res.data.id);
    onChanged();
  }

  async function cancel(schedule: OwnAgentSchedule) {
    setBusy(true);
    setCancelRefused(null);
    const res = await api.mutate('agents', 'own.schedules.cancel', { id: agent.id, scheduleId: schedule.id }, ownAgentScheduleSchema);
    setBusy(false);
    if (!res.ok) return setCancelRefused(res);
    onChanged();
  }

  const shown = held.schedules.find((s) => s.id === open) ?? null;
  const { minIntervalMinutes } = held.cadence;
  return (
    <>
      <form
        aria-label={t('newSchedule')}
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <h3>{t('newSchedule')}</h3>
        <label className="field" htmlFor={`schedule-repeat-${agent.id}`}>
          <span>{t('repeat')}</span>
          <select
            id={`schedule-repeat-${agent.id}`}
            value={repeat}
            onChange={(event) => {
              edited();
              setRepeat(event.target.value === 'once' ? 'once' : 'repeat');
            }}
          >
            <option value="repeat">{t('repeat_repeat')}</option>
            <option value="once">{t('repeat_once')}</option>
          </select>
        </label>
        {repeat === 'repeat' ? (
          <Field
            label={t('interval')}
            hint={minIntervalMinutes === null ? t('intervalHintUnset') : t('intervalHint', { minimum: String(minIntervalMinutes) })}
            inputMode="numeric"
            value={interval}
            maxLength={16}
            onChange={(event) => {
              edited();
              setIntervalText(event.target.value);
            }}
          />
        ) : null}
        <Field
          label={t('cap')}
          hint={t('capHint')}
          inputMode="decimal"
          value={cap}
          maxLength={64}
          onChange={(event) => {
            edited();
            setCap(event.target.value);
          }}
        />
        <Field
          label={t('ask')}
          hint={t('askHint')}
          value={ask}
          maxLength={OWN_AGENT_AUTOMATION_LIMITS.ask}
          onChange={(event) => {
            edited();
            setAsk(event.target.value);
          }}
        />
        <Button type="submit" disabled={busy}>
          {t('createSchedule')}
        </Button>
        {refused ? <Answer failed={refused} /> : null}
      </form>

      <h3>{t('schedulesTitle')}</h3>
      <DataTable
        label={t('schedulesTitle')}
        headers={[t('colCreated'), t('colRepeat'), t('colCap'), t('colAsk'), t('colStatus'), t('colNext'), t('colActions')]}
      >
        {held.schedules.map((schedule) => (
          <tr key={schedule.id}>
            <td>{when(schedule.createdAt)}</td>
            <td>
              {schedule.repeat === 'once' ? t('repeat_once') : t('everyMinutes', { minutes: String(schedule.intervalMinutes ?? '') })}
            </td>
            <td>{schedule.perRunCap === null ? t('capBlank') : `${schedule.perRunCap} ${schedule.recent[0]?.assetId ?? ''}`.trim()}</td>
            <td>{schedule.ask}</td>
            <td data-testid="schedule-status">{t(`status_${schedule.state}`)}</td>
            <td data-testid="next-occurrence">{when(schedule.nextDueAt) ?? t('none')}</td>
            <td>
              <Button variant="secondary" onClick={() => setOpen(schedule.id)}>
                {t('recentRuns')}
              </Button>
              {schedule.state === 'active' ? (
                <Button variant="ghost" disabled={busy} onClick={() => void cancel(schedule)}>
                  {t('cancel')}
                </Button>
              ) : null}
            </td>
          </tr>
        ))}
      </DataTable>
      {held.schedules.length === 0 ? <p className="muted">{t('noSchedules')}</p> : null}
      {cancelRefused ? <Answer failed={cancelRefused} /> : null}

      {shown ? (
        <section aria-label={t('occurrencesTitle')}>
          <h3>{t('occurrencesTitle')}</h3>
          <p className="muted">{t('occurrencesIntro')}</p>
          <DataTable
            label={t('occurrencesTitle')}
            headers={[t('colOccurrence'), t('colDue'), t('colOutcome'), t('colRuns'), t('colWakes'), t('colCost')]}
          >
            {shown.recent.map((run) => (
              <tr key={run.id}>
                <td>{run.ordinal}</td>
                <td>{when(run.dueAt)}</td>
                <td data-testid="occurrence-outcome">
                  <Outcome run={run} />
                </td>
                <td data-testid="runs-for-occurrence">{t(run.runs === 1 ? 'oneRun' : 'manyRuns', { count: String(run.runs) })}</td>
                <td data-testid="wakes">{t('wakes', { count: String(run.wakes) })}</td>
                <td>{run.cost === null ? '—' : `${run.cost} ${run.assetId}`}</td>
              </tr>
            ))}
          </DataTable>
          {shown.recent.length === 0 ? <p className="muted">{t('noOccurrences')}</p> : null}
        </section>
      ) : null}
    </>
  );
}

const triggersSchema = z.array(ownAgentTriggerSchema);

export function TriggersPage({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentAutomationCopy.useCopy();
  const { data, failed, reload } = usePolled(() => api.query('agents', 'own.triggers.list', { id: agent.id }, triggersSchema));
  return (
    <Panel title={t('triggersTitle')}>
      <p className="muted">{t('triggersIntro')}</p>
      {failed && !data ? <Failure result={failed} retry={reload} /> : null}
      {data ? <Triggers agent={agent} held={data} onChanged={reload} /> : failed ? null : <p className="muted">{t('loading')}</p>}
    </Panel>
  );
}

function Triggers({ agent, held, onChanged }: { agent: OwnAgent; held: OwnAgentTrigger[]; onChanged: () => void }) {
  const api = useApi();
  const { t } = agentAutomationCopy.useCopy();
  const keys = useCreateKey(`own-trigger:${agent.id}`);
  const [subject, setSubject] = useState('');
  const [cap, setCap] = useState('');
  const [ask, setAsk] = useState('');
  const [refused, setRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  const edited = () => keys.settle();

  async function create() {
    setBusy(true);
    setRefused(null);
    const res = await api.mutate(
      'agents',
      'own.triggers.create',
      { id: agent.id, createKey: keys.next(), subject, perRunCap: cap, ask },
      ownAgentTriggerSchema,
    );
    setBusy(false);
    if (res.ok || refusalCode(res)) keys.settle();
    if (!res.ok) return setRefused(res);
    onChanged();
  }

  // Each delivery of an event, newest first: the first of an event id shows what its run did, a later one is ignored.
  const deliveries = held.flatMap((trigger) =>
    trigger.deliveries.map((delivery) => ({
      trigger,
      delivery,
      run: trigger.runs.find((run) => run.eventId === delivery.eventId) ?? null,
    })),
  );
  return (
    <>
      <form
        aria-label={t('newTrigger')}
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <h3>{t('newTrigger')}</h3>
        <label className="field" htmlFor={`trigger-subject-${agent.id}`}>
          <span>{t('when')}</span>
          <select
            id={`trigger-subject-${agent.id}`}
            value={subject}
            onChange={(event) => {
              edited();
              setSubject(event.target.value);
            }}
          >
            <option value="">{t('whenPick')}</option>
            {OWN_AGENT_TRIGGER_SUBJECTS.map((s) => (
              <option key={s} value={s}>
                {t(`subject_${s.replaceAll('.', '_') as 'trade_fill_settled'}`)}
              </option>
            ))}
          </select>
        </label>
        <Field
          label={t('cap')}
          hint={t('capHint')}
          inputMode="decimal"
          value={cap}
          maxLength={64}
          onChange={(event) => {
            edited();
            setCap(event.target.value);
          }}
        />
        <Field
          label={t('ask')}
          hint={t('askHintTrigger')}
          value={ask}
          maxLength={OWN_AGENT_AUTOMATION_LIMITS.ask}
          onChange={(event) => {
            edited();
            setAsk(event.target.value);
          }}
        />
        <Button type="submit" disabled={busy}>
          {t('addTrigger')}
        </Button>
        {refused ? <Answer failed={refused} /> : null}
      </form>

      <h3>{t('triggersTitle')}</h3>
      <DataTable label={t('triggersTitle')} headers={[t('colAdded'), t('colWhen'), t('colCap'), t('colAsk'), t('colStatus')]}>
        {held.map((trigger) => (
          <tr key={trigger.id}>
            <td>{when(trigger.createdAt)}</td>
            <td>{t(`subject_${trigger.subject.replaceAll('.', '_') as 'trade_fill_settled'}`)}</td>
            <td>{trigger.perRunCap ?? t('capBlank')}</td>
            <td>{trigger.ask}</td>
            <td>{t(`status_${trigger.state}`)}</td>
          </tr>
        ))}
      </DataTable>
      {held.length === 0 ? <p className="muted">{t('noTriggers')}</p> : null}

      <h3>{t('triggerRunsTitle')}</h3>
      <p className="muted">{t('triggerRunsIntro')}</p>
      <DataTable label={t('triggerRunsTitle')} headers={[t('colReceived'), t('colEvent'), t('colOutcome'), t('colRuns'), t('colCost')]}>
        {deliveries.map(({ trigger, delivery, run }) => (
          <tr key={`${trigger.id}:${delivery.envelopeId}`}>
            <td>{when(delivery.receivedAt)}</td>
            <td>
              <code lang="zxx">{delivery.eventId}</code>
            </td>
            <td data-testid="delivery-outcome">
              {delivery.redelivered ? t('redelivered') : run ? <Outcome run={run} /> : t('outcome_claimed')}
            </td>
            <td data-testid="runs-for-event">
              {delivery.redelivered || !run ? '—' : t(run.runs === 1 ? 'oneRun' : 'manyRuns', { count: String(run.runs) })}
            </td>
            <td>{!delivery.redelivered && run?.cost ? `${run.cost} ${run.assetId}` : '—'}</td>
          </tr>
        ))}
      </DataTable>
      {deliveries.length === 0 ? <p className="muted">{t('noDeliveries')}</p> : null}
    </>
  );
}
