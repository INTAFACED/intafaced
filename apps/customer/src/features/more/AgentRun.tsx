import { useEffect, useState } from 'react';
import { sessionRunSchema, sessionRunStopSchema, type SessionRun } from '@intafaced/contracts/agents-runs';
import { useApi } from '../session/session';
import { ServiceOffNotice } from '../../shared/service-off';
import { displayAmount } from '../../shared/money';
import { Button, DataTable, Panel } from '../../shared/ui';
import { channelStatus } from '../../screens/notifications/notify-api';
import { Details, TextArea } from './common';
import { agentRunCopy } from './agent-run-copy';

export const agentRunSchema = sessionRunSchema;
export type AgentRun = SessionRun;
const stopSchema = sessionRunStopSchema;

const ENDED: readonly AgentRun['state'][] = ['completed', 'stopped', 'failed'];
/** How often the page reads the run again while it is still going. */
const POLL_MS = 1000;

/** The run id in /agents/runs/:runId, or null. */
export function agentRunId(path: string): string | null {
  const match = /^\/agents\/runs\/([0-9a-f-]{36})$/i.exec(path);
  return match ? match[1]! : null;
}

/**
 * One background run (/agents/runs/:runId, J-agents-06): its status, every step it took with its reply and cost, and
 * its result. While it is still going the page reads it again every second; it can be paused, resumed, asked more and
 * stopped. Every answer is svc-agents': a refusal shows its code, and someone else's run id reads as not found.
 */
export function AgentRunPage({ runId }: { runId: string }) {
  const api = useApi();
  const { t } = agentRunCopy.useCopy();
  const [run, setRun] = useState<AgentRun | null>(null);
  const [missing, setMissing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [repeated, setRepeated] = useState(false);
  const [more, setMore] = useState('');
  const [busy, setBusy] = useState(false);
  const [channelOff, setChannelOff] = useState<'vendor.email' | 'vendor.sms' | 'vendor.push' | null>(null);

  const live = run === null || !ENDED.includes(run.state);
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    const read = () =>
      void api.query('agents', 'run.background.get', { runId }, agentRunSchema, { signal: controller.signal }).then((res) => {
        if (controller.signal.aborted) return;
        if (res.ok) return setRun(res.data);
        if (res.message === 'agents.run_not_found' || res.code === 'NOT_FOUND') setMissing(true);
      });
    read();
    const timer = setInterval(read, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api, runId, live]);

  // The channel the person asked to be told on, when it has no vendor: named as switched off, the inbox row stands.
  const notice = run?.notice ?? 'inapp';
  useEffect(() => {
    if (notice === 'inapp') return;
    const controller = new AbortController();
    void channelStatus(api, controller.signal).then((res) => {
      if (!res.ok || controller.signal.aborted) return;
      const row = res.data.find((c) => c.channel === notice);
      setChannelOff(row && !row.configured ? (`vendor.${notice}` as const) : null);
    });
    return () => controller.abort();
  }, [api, notice]);

  if (missing) {
    return (
      <Panel title={t('notFound')}>
        <p>{t('notFoundBody')}</p>
      </Panel>
    );
  }
  if (!run) return null;

  const act = async (path: 'run.background.pause' | 'run.background.resume') => {
    setBusy(true);
    setRefusal(null);
    setRepeated(false);
    const res = await api.mutate('agents', path, { runId }, agentRunSchema);
    setBusy(false);
    if (res.ok) setRun(res.data);
    else setRefusal(res.message);
  };
  const stop = async () => {
    setBusy(true);
    setRefusal(null);
    const res = await api.mutate('agents', 'run.background.stop', { runId }, stopSchema);
    setBusy(false);
    if (!res.ok) return setRefusal(res.message);
    setRun(res.data.run);
    setRepeated(res.data.repeated);
  };
  const askMore = async () => {
    setBusy(true);
    setRefusal(null);
    setRepeated(false);
    const res = await api.mutate('agents', 'run.background.askMore', { runId, text: more }, agentRunSchema);
    setBusy(false);
    if (!res.ok) return setRefusal(res.message);
    setRun(res.data);
    setMore('');
  };

  const ended = ENDED.includes(run.state);
  const taken = run.steps.filter((s) => s.state !== 'in_flight').length;
  const offAction = notice === 'email' ? t('emailAction') : notice === 'sms' ? t('smsAction') : t('pushAction');
  return (
    <Panel title={t('run')} role="region" aria-label={t('run')}>
      <Details
        items={[
          [t('status'), <span data-testid="run-status">{t(`state_${run.state}`)}</span>],
          [t('ask'), run.ask],
          [t('progress'), t('progressValue', { done: taken, total: run.stepsTotal })],
        ]}
      />
      {run.failureCode ? (
        <p role="alert">
          {t('failed')} <code>{run.failureCode}</code>
        </p>
      ) : null}
      {run.resumedAt ? <p>{t('resumedFrom')}</p> : null}
      {channelOff ? <ServiceOffNotice code={channelOff} action={offAction} role="note" /> : null}
      <DataTable headers={[t('colStep'), t('colState'), t('colReply'), t('colCost')]} label={t('stepsTitle')}>
        {run.steps.map((step) => (
          <tr key={step.n}>
            <td>{step.n}</td>
            <td>{t(`step_${step.state}`)}</td>
            <td lang="und">{step.reply ?? '—'}</td>
            <td>{step.cost === null ? '—' : displayAmount(step.cost)}</td>
          </tr>
        ))}
      </DataTable>
      <section role="region" aria-label={t('reply')}>
        <h3>{t('reply')}</h3>
        {run.state === 'completed' && run.reply ? <p lang="und">{run.reply}</p> : <p className="muted">{t('noReply')}</p>}
      </section>
      {run.state === 'stopped' ? (
        <>
          <p>{t('stoppedNote')}</p>
          {run.stop ? (
            <p className="muted">
              {run.stop.unpaid ? t('unpaid') : t('settled', { amount: displayAmount(run.stop.billed), asset: run.stop.assetId })}
            </p>
          ) : null}
        </>
      ) : null}
      {repeated ? <p role="status">{t('alreadyStopped')}</p> : null}
      {refusal ? (
        <p role="alert">
          {t('refused')} <code>{refusal}</code>
        </p>
      ) : null}
      <div className="actions">
        {run.state === 'paused' ? (
          <Button disabled={busy} onClick={() => void act('run.background.resume')}>
            {t('resume')}
          </Button>
        ) : (
          <Button disabled={busy || ended} onClick={() => void act('run.background.pause')}>
            {t('pause')}
          </Button>
        )}
        <Button variant="secondary" disabled={busy || run.state === 'completed' || run.state === 'failed'} onClick={() => void stop()}>
          {t('stop')}
        </Button>
      </div>
      <TextArea label={t('askMoreLabel')} value={more} onChange={setMore} maxLength={20000} />
      <Button disabled={busy || ended || !more.trim()} onClick={() => void askMore()}>
        {t('askMore')}
      </Button>
    </Panel>
  );
}

/**
 * The workspace's background option (J-agents-06 #1): ticked, the ask runs as a background run on this session, which
 * goes on when the person leaves the page; it shows the run's id and status and links to its page. Unticked, the
 * workspace's own Run button runs the ask in the page as before.
 */
export function BackgroundRunStart({
  sessionId,
  task,
  ask,
  disabled,
  background,
  onBackground,
}: {
  sessionId: string;
  task: string | undefined;
  ask: string;
  disabled: boolean;
  background: boolean;
  onBackground: (on: boolean) => void;
}) {
  const api = useApi();
  const { t } = agentRunCopy.useCopy();
  const [steps, setSteps] = useState('1');
  const [notice, setNotice] = useState<AgentRun['notice']>('inapp');
  const [started, setStarted] = useState<AgentRun | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const count = /^[1-9]\d{0,3}$/.test(steps) ? Number(steps) : null;

  const start = async () => {
    if (!task || count === null) return;
    setBusy(true);
    setRefusal(null);
    // One click is one run: a retry of this request is the same run, never a second one.
    const requestId = `bg:${crypto.randomUUID()}`;
    const res = await api.mutate(
      'agents',
      'run.background.start',
      { sessionId, requestId, task, ask, steps: count, notice },
      agentRunSchema,
    );
    setBusy(false);
    if (res.ok) setStarted(res.data);
    else setRefusal(res.message);
  };

  return (
    <div>
      <label className="field">
        <span>
          <input type="checkbox" checked={background} onChange={(event) => onBackground(event.target.checked)} /> {t('background')}
        </span>
      </label>
      {background ? (
        <>
          <p className="muted">{t('backgroundHint')}</p>
          <label className="field">
            <span>{t('steps')}</span>
            <input inputMode="numeric" value={steps} onChange={(event) => setSteps(event.target.value)} />
          </label>
          <label className="field">
            <span>{t('notice')}</span>
            <select value={notice} onChange={(event) => setNotice(event.target.value as AgentRun['notice'])}>
              {(['inapp', 'email', 'sms', 'push'] as const).map((channel) => (
                <option key={channel} value={channel}>
                  {t(`notice_${channel}`)}
                </option>
              ))}
            </select>
          </label>
          <Button disabled={disabled || busy || !task || !ask.trim() || count === null} onClick={() => void start()}>
            {t('runButton')}
          </Button>
          {refusal ? (
            <p role="alert">
              {t('refused')} <code>{refusal}</code>
            </p>
          ) : null}
          {started ? (
            <p role="status">
              {t('started')}{' '}
              <code data-testid="run-id" lang="zxx">
                {started.runId}
              </code>{' '}
              · <span data-testid="run-status">{t(`state_${started.state}`)}</span> ·{' '}
              <a href={`/agents/runs/${started.runId}`}>{t('open')}</a>
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
