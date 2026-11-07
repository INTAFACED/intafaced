import { useState } from 'react';
import { useApi } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { Button, Failure } from '../../shared/ui';
import { agentTestRunsCopy, hasTestRunsWords } from './agent-test-runs-copy';
import { ownAgentTestRunSchema, type OwnAgentTestRun } from '@intafaced/contracts/agents-own';

/**
 * The hostile content and output guards of a test engine run, as the Test panel shows them (AG-guardrails-03;
 * J-agents-10 #1-#3). svc-agents decides every outcome; this only shows it:
 * - the outside content the agent read, labelled Untrusted;
 * - a blocked step's code as the one alert (`agents.content.untrusted`, `agents.output.blocked`), with no reply;
 * - a value-moving action's approval request, whose amount and destination are read from the person's own words, and
 *   the person's decision on it, refused `agents.payload.mismatch` when the drafted step differs. A test run sends
 *   nothing either way.
 */

type EngineRun = Extract<OwnAgentTestRun, { kind: 'engine_run' }>;
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** A code from svc-agents in the panel's words, with the code beside it: the one alert. */
export function CodeAlert({ code }: { code: string }) {
  const { t } = agentTestRunsCopy.useCopy();
  const key = `code_${code.replaceAll('.', '_')}`;
  return (
    <p role="alert">
      {hasTestRunsWords(key) ? t(key) : t('code_other')} <code lang="zxx">{code}</code>
    </p>
  );
}

const coded = (failed: Failed): string | null =>
  failed.reason !== 'unreachable' && /^agents\.[a-z_.]+$/.test(failed.message) ? failed.message : null;

/** Whether the run's reply may be shown: only when no guard withheld it. */
export const replyShown = (run: EngineRun): boolean => run.guard.outcome !== 'blocked';

/** What the guards decided on one engine run; `onDecided` takes the run once the person has approved or been refused. */
export function GuardOutcome({ agentId, run, onDecided }: { agentId: string; run: EngineRun; onDecided: (run: EngineRun) => void }) {
  const api = useApi();
  const { t } = agentTestRunsCopy.useCopy();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Failed | null>(null);
  const { guard } = run;

  async function approve() {
    if (!guard.approval) return;
    setBusy(true);
    setRefused(null);
    const res = await api.mutate(
      'agents',
      'own.testApprove',
      { id: agentId, runId: run.id, payload: guard.approval },
      ownAgentTestRunSchema,
    );
    setBusy(false);
    if (!res.ok) return setRefused(res);
    if (res.data.kind === 'engine_run') onDecided(res.data);
  }

  const refusedCode = refused ? coded(refused) : null;
  return (
    <>
      {run.content !== null && guard.content ? (
        <section role="region" aria-label={t('contentTitle')}>
          <h4>
            {t('contentTitle')} · <strong data-testid="content-trust">{t(`trust_${guard.content.trust}`)}</strong>
          </h4>
          <p className="muted">{t('contentNote')}</p>
          <blockquote data-testid="content-text" lang="und">
            {run.content}
          </blockquote>
        </section>
      ) : null}
      {guard.approval ? (
        <section role="region" aria-label={t('approvalTitle')}>
          <h4>{t('approvalTitle')}</h4>
          <dl>
            <dt>{t('approvalAmount')}</dt>
            <dd data-testid="approval-amount">
              {guard.approval.amount} {guard.approval.assetId}
            </dd>
            <dt>{t('approvalDestination')}</dt>
            <dd data-testid="approval-destination" lang="und">
              {guard.approval.destination}
            </dd>
          </dl>
          <p>{t('approvalOnly')}</p>
          {guard.outcome === 'awaiting_approval' ? (
            <Button disabled={busy} onClick={() => void approve()}>
              {t('approve')}
            </Button>
          ) : null}
          {guard.outcome === 'approved' ? <p data-testid="approval-decided">{t('approvedNote')}</p> : null}
        </section>
      ) : null}
      {guard.code ? (
        <CodeAlert code={guard.code} />
      ) : refused ? (
        refusedCode ? (
          <CodeAlert code={refusedCode} />
        ) : (
          <Failure result={refused} />
        )
      ) : null}
    </>
  );
}
