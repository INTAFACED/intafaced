import { useRef, useState } from 'react';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, DataTable, Failure, Field, Panel } from '../../shared/ui';
import { Read } from './common';
import { agentEvalsCopy, hasEvalWords } from './agent-evals-copy';
import {
  OWN_AGENT_EVAL_LIMITS,
  ownAgentEvalRunSchema,
  ownAgentEvalsSchema,
  type OwnAgent,
  type OwnAgentEvalCase,
  type OwnAgentEvalRun,
  type OwnAgentEvals,
} from '@intafaced/contracts/agents-own';

/**
 * An own agent's Evaluations page (AG-testing-02). Every answer is svc-agents': the stored test set (a visible warning
 * while there is none), the runs and their results. A start runs on the service's test engine, never billed and never
 * near a balance; a blank threshold or repeats count is the service's refusal by name, and nothing runs. "Send again"
 * re-sends the latest run with its own request id, so the service answers with that run, never a second one.
 */

/** The keys of one visit's starts: each new request is the next count; an unsettled one is sent again as itself. */
type RequestKeys = { visit: string; presses: number; pending: string | null };

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const REFUSAL_REASONS: ReadonlySet<Failed['reason']> = new Set(['error', 'forbidden', 'not_mounted']);
const refusalCode = (failed: Failed): string | null =>
  REFUSAL_REASONS.has(failed.reason) && /^agents\.[a-z_.]+$/.test(failed.message) ? failed.message : null;

/** The refusals whose words name a limit, with the limit they name. */
const LIMIT_OF = {
  'agents.eval.too_many_cases': OWN_AGENT_EVAL_LIMITS.cases,
  'agents.eval.repeats_invalid': OWN_AGENT_EVAL_LIMITS.repeats,
  'agents.eval.case_too_long': OWN_AGENT_EVAL_LIMITS.text,
} as const;
type LimitKey = 'code_agents_eval_too_many_cases' | 'code_agents_eval_repeats_invalid' | 'code_agents_eval_case_too_long';

/** A refusal as words with its code beside them, or the app's own account of a failure that is not one. */
function Answer({ failed }: { failed: Failed }) {
  const { t } = agentEvalsCopy.useCopy();
  const code = refusalCode(failed);
  if (!code) return <Failure result={failed} />;
  const key = `code_${code.replaceAll('.', '_')}`;
  const words = Object.hasOwn(LIMIT_OF, code)
    ? t(`code_${code.replaceAll('.', '_')}` as LimitKey, { limit: String(LIMIT_OF[code as keyof typeof LIMIT_OF]) })
    : hasEvalWords(key)
      ? t(key)
      : t('code_other');
  return (
    <p role="alert">
      {words} <code lang="zxx">{code}</code>
    </p>
  );
}

export function EvaluationsPage({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentEvalsCopy.useCopy();
  const [version, setVersion] = useState(0);
  // Kept here, not in the page body below, so the answer to "Send again" and the request keys survive the re-read a
  // start causes.
  const again = useState<{ requestId: string } | null>(null);
  const keys = useRef<RequestKeys>({ visit: Date.now().toString(36), presses: 0, pending: null });
  const loaded = useResource(
    (signal) => api.query('agents', 'own.evals.get', { id: agent.id, limit: 50 }, ownAgentEvalsSchema, { signal }),
    `own-evals:${agent.id}:${version}`,
  );
  return (
    <Panel title={t('title')} role="region" aria-label={t('title')}>
      <p className="muted">{t('intro')}</p>
      <Read resource={loaded.resource} retry={loaded.reload}>
        {(evals) => (
          <Evaluations agent={agent} evals={evals} again={again} keys={keys.current} onChanged={() => setVersion((v) => v + 1)} />
        )}
      </Read>
    </Panel>
  );
}

function Evaluations({
  agent,
  evals,
  again: [again, setAgain],
  keys,
  onChanged,
}: {
  agent: OwnAgent;
  evals: OwnAgentEvals;
  again: [{ requestId: string } | null, (value: { requestId: string } | null) => void];
  keys: RequestKeys;
  onChanged: () => void;
}) {
  const api = useApi();
  const { t } = agentEvalsCopy.useCopy();
  // The saved test set is where the form starts, so it can be run again or changed; it is not run until Start.
  const [cases, setCases] = useState<OwnAgentEvalCase[]>(() => evals.testSet.map((entry) => ({ ...entry })));
  const [repeats, setRepeats] = useState('');
  const [threshold, setThreshold] = useState('');
  const [refused, setRefused] = useState<Failed | null>(null);
  const [againRefused, setAgainRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = evals.latest;
  /** Any change to the form makes the next Start a new request. */
  const edited = () => {
    keys.pending = null;
  };

  async function start() {
    setBusy(true);
    setRefused(null);
    setAgain(null);
    setAgainRefused(null);
    if (!keys.pending) {
      keys.presses += 1;
      keys.pending = `own-eval:${agent.id}:${keys.visit}:${keys.presses}`;
    }
    const requestId = keys.pending;
    const res = await api.mutate(
      'agents',
      'own.evals.start',
      { id: agent.id, requestId, cases, repeats, threshold },
      ownAgentEvalRunSchema,
    );
    setBusy(false);
    // A clear answer settles the request. One whose outcome is unknown (a timeout, a gateway error) keeps its key, so
    // pressing Start again is the same request and can never run the evaluation twice.
    if (res.ok || refusalCode(res)) keys.pending = null;
    if (!res.ok) return setRefused(res);
    onChanged();
  }

  async function sendAgain(run: OwnAgentEvalRun) {
    setBusy(true);
    setAgain(null);
    setAgainRefused(null);
    const res = await api.mutate(
      'agents',
      'own.evals.start',
      { id: agent.id, requestId: run.requestId, cases: run.cases, repeats: String(run.repeats), threshold: run.threshold },
      ownAgentEvalRunSchema,
    );
    setBusy(false);
    if (!res.ok) return setAgainRefused(res);
    if (res.data.id === run.id) setAgain({ requestId: run.requestId });
    onChanged();
  }

  const setCase = (index: number, patch: Partial<OwnAgentEvalCase>) => {
    edited();
    setCases((current) => current.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  };

  return (
    <>
      {evals.testSet.length === 0 ? (
        <p role="alert">{t('noTestSet')}</p>
      ) : (
        <section aria-label={t('testSetTitle')}>
          <h3>{t('testSetTitle')}</h3>
          <p className="muted">{t('testSetCount', { count: String(evals.testSet.length) })}</p>
        </section>
      )}

      <form
        aria-label={t('startTitle')}
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <h3>{t('startTitle')}</h3>
        {cases.length === 0 ? <p className="muted">{t('noCases')}</p> : null}
        {cases.map((entry, index) => {
          const n = String(index + 1);
          return (
            <fieldset key={index}>
              <Field
                label={t('caseInput', { n })}
                value={entry.input}
                maxLength={OWN_AGENT_EVAL_LIMITS.text}
                onChange={(event) => setCase(index, { input: event.target.value })}
              />
              <Field
                label={t('caseExpected', { n })}
                value={entry.expected}
                maxLength={OWN_AGENT_EVAL_LIMITS.text}
                onChange={(event) => setCase(index, { expected: event.target.value })}
              />
              <Button
                variant="ghost"
                onClick={() => {
                  edited();
                  setCases((current) => current.filter((_, i) => i !== index));
                }}
              >
                {t('removeCase', { n })}
              </Button>
            </fieldset>
          );
        })}
        <Button
          variant="secondary"
          disabled={cases.length >= OWN_AGENT_EVAL_LIMITS.cases}
          onClick={() => {
            edited();
            setCases((current) => [...current, { input: '', expected: '' }]);
          }}
        >
          {t('addCase')}
        </Button>
        <Field
          label={t('repeats')}
          hint={t('repeatsHint', { limit: String(OWN_AGENT_EVAL_LIMITS.repeats) })}
          inputMode="numeric"
          value={repeats}
          maxLength={16}
          onChange={(event) => {
            edited();
            setRepeats(event.target.value);
          }}
        />
        <Field
          label={t('threshold')}
          hint={t('thresholdHint')}
          inputMode="decimal"
          value={threshold}
          maxLength={16}
          onChange={(event) => {
            edited();
            setThreshold(event.target.value);
          }}
        />
        <Button type="submit" disabled={busy}>
          {t('start')}
        </Button>
        {refused ? <Answer failed={refused} /> : null}
      </form>

      {latest ? (
        <section aria-label={t('latestTitle')}>
          <h3>{t('latestTitle')}</h3>
          <p>
            {t('score')}: <strong data-testid="eval-score">{latest.score}%</strong> · {t('verdict')}:{' '}
            <strong data-testid="eval-verdict">{t(`verdict_${latest.verdict}`)}</strong> · TEST
          </p>
          <p className="muted">
            {t('scoreLine', { passed: String(latest.passed), total: String(latest.total), threshold: latest.threshold })}
          </p>
          <Button variant="secondary" disabled={busy} onClick={() => void sendAgain(latest)}>
            {t('sendAgain')}
          </Button>
          <p className="muted">{t('sendAgainHint')}</p>
          {again ? <p role="status">{t('sameRun', { requestId: again.requestId })}</p> : null}
          {againRefused ? <Answer failed={againRefused} /> : null}
          <DataTable
            label={t('resultsTitle')}
            headers={[t('colCase'), t('colRepeat'), t('colInput'), t('colExpected'), t('colReply'), t('colResult'), t('colLabel')]}
          >
            {latest.results.map((result) => (
              <tr key={`${result.caseIndex}:${result.repeat}`}>
                <td>{result.caseIndex + 1}</td>
                <td>{result.repeat}</td>
                <td>{result.input}</td>
                <td data-testid="result-expected">{result.expected}</td>
                <td data-testid="result-reply">{result.reply}</td>
                <td data-testid="result-outcome">{t(result.passed ? 'result_pass' : 'result_fail')}</td>
                <td data-testid="result-label">{result.label}</td>
              </tr>
            ))}
          </DataTable>
        </section>
      ) : null}

      <h3>{t('runsTitle')}</h3>
      <DataTable
        label={t('runsTitle')}
        headers={[t('colWhen'), t('colCases'), t('colRepeats'), t('colThreshold'), t('colScore'), t('colVerdict'), t('colLabel')]}
      >
        {evals.runs.map((run) => (
          <tr key={run.id}>
            <td>{new Date(run.createdAt).toLocaleString()}</td>
            <td>{run.cases}</td>
            <td>{run.repeats}</td>
            <td>{run.threshold}%</td>
            <td>{run.score}%</td>
            <td>{t(`verdict_${run.verdict}`)}</td>
            <td>{run.label}</td>
          </tr>
        ))}
      </DataTable>
      {evals.runs.length === 0 ? <p className="muted">{t('noRuns')}</p> : null}
    </>
  );
}
