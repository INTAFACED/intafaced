import { useState } from 'react';
import { Badge, Button, Skeleton, StateBlock } from '@intafaced/ui';
import type { Loadable } from '../../../data/types';
import { accessCopy } from './access-copy';
import type { Agreement, Eligibility, GatedList } from './api';
import { useAgreements, useEligibility, useFuturesApi, useGatedList } from './data';
import { futuresRefusal } from './refusals';

const note = 'text-xs text-fg-2';

/**
 * Who may open on this contract (D-ops-01, D-account-07): the account's gated list for the contract, every reason it is
 * blocked, and the two things the trader can clear here: the current risk agreement and margin terms, and the knowledge
 * check. The open path runs its own gates; this panel only reads them and sends the trader's own answers.
 */
export function AccessPanel({ symbol, onChanged }: { symbol: string; onChanged: () => void }) {
  const gated = useGatedList();
  const agreements = useAgreements();
  const eligibility = useEligibility();
  return (
    <section
      aria-label={accessCopy.useCopy().t('Access')}
      className="flex flex-col gap-3 border-b border-line p-3"
      data-testid="futures-access"
    >
      <GateLine gated={gated} symbol={symbol} />
      <Agreements agreements={agreements} onChanged={onChanged} />
      <Quiz eligibility={eligibility} onChanged={onChanged} />
    </section>
  );
}

function GateLine({ gated, symbol }: { gated: Loadable<GatedList>; symbol: string }) {
  const { t } = accessCopy.useCopy();
  if (gated.status === 'loading') return <Skeleton className="h-6 w-full" />;
  if (gated.status === 'error')
    return <StateBlock kind="error" title={t('Access')} thing={t('Access thing')} onRetry={gated.retry} retryLabel={t('Try again')} />;
  if (gated.status !== 'ready') {
    const words = futuresRefusal({ code: gated.status === 'refused' ? gated.code : undefined });
    return <p className={note}>{words.title}</p>;
  }
  const contract = gated.data.contracts.find((c) => c.symbol === symbol);
  if (!contract) return <p className={note}>{t('Access not listed')}</p>;
  return (
    <div className="flex flex-col gap-1" data-testid="futures-gate">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-sm font-medium">{t('Access')}</h3>
        <Badge tone={contract.open ? 'lime' : 'warn'}>{contract.open ? t('Access open') : t('Access blocked')}</Badge>
      </div>
      {contract.blockers.length > 0 ? (
        <ul aria-label={t('Access reasons')} className="m-0 flex list-disc flex-col gap-1 pl-4">
          {contract.blockers.map((blocker) => {
            const words = futuresRefusal({ code: blocker.code, message: blocker.message });
            return (
              <li key={blocker.code} className={note} data-code={blocker.code}>
                <span className="text-fg">{words.title}.</span> {words.body}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function Agreements({ agreements, onChanged }: { agreements: Loadable<{ agreements: Agreement[] }>; onChanged: () => void }) {
  const { t } = accessCopy.useCopy();
  if (agreements.status === 'loading') return <Skeleton className="h-10 w-full" />;
  if (agreements.status === 'error')
    return (
      <StateBlock
        kind="error"
        title={t('Agreements heading')}
        thing={t('Agreements thing')}
        onRetry={agreements.retry}
        retryLabel={t('Try again')}
      />
    );
  if (agreements.status !== 'ready') {
    const words = futuresRefusal({ code: agreements.status === 'refused' ? agreements.code : undefined });
    return (
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-sm font-medium">{t('Agreements heading')}</h3>
        <p className={note}>
          {words.title}. {words.body}
        </p>
      </div>
    );
  }
  const list = agreements.data.agreements;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="m-0 text-sm font-medium">{t('Agreements heading')}</h3>
      {list.length === 0 ? <p className={note}>{t('Agreements none')}</p> : null}
      {list.map((agreement) => (
        <AgreementRow key={agreement.kind} agreement={agreement} onChanged={onChanged} />
      ))}
    </div>
  );
}

function AgreementRow({ agreement, onChanged }: { agreement: Agreement; onChanged: () => void }) {
  const { t } = accessCopy.useCopy();
  const api = useFuturesApi();
  const [state, setState] = useState<{ kind: 'idle' | 'busy' } | { kind: 'failed'; reason: string }>({ kind: 'idle' });
  if (!agreement.available)
    return <p className={note}>{t('Agreement unavailable', { title: agreement.kind, message: agreement.message })}</p>;
  if (agreement.accepted)
    return (
      <p className={note} data-testid={`agreement-${agreement.kind}`}>
        <span className="text-fg">{agreement.title}</span> ·{' '}
        {t('Agreement accepted', { date: agreement.acceptedAt ? new Date(agreement.acceptedAt).toLocaleDateString() : '' })}
      </p>
    );
  const accept = async () => {
    setState({ kind: 'busy' });
    // Idempotent per account, kind and version: a second press accepts the same version once.
    const result = await api.acceptAgreement({ kind: agreement.kind, version: agreement.version });
    if (result.ok) {
      setState({ kind: 'idle' });
      onChanged();
    } else setState({ kind: 'failed', reason: futuresRefusal(result).title });
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line p-3" data-testid={`agreement-${agreement.kind}`}>
      <h4 className="m-0 text-sm font-medium">{agreement.title}</h4>
      <p className={`${note} max-h-32 overflow-y-auto whitespace-pre-line`}>{agreement.body}</p>
      <Button
        variant="secondary"
        size={32}
        aria-label={t('Agreement accept', { title: agreement.title })}
        loading={state.kind === 'busy'}
        onClick={() => void accept()}
      >
        {t('Agreement accept short')}
      </Button>
      {state.kind === 'failed' ? <p className="text-xs text-warn">{t('Agreement failed', { reason: state.reason })}</p> : null}
    </div>
  );
}

/**
 * A submission's business key: this rule version and these answers, as a digest (the service takes at most 64
 * characters). The same answers replay the same assessment; different answers always make a different key.
 */
async function submissionId(ruleVersion: number | null | undefined, answers: Record<string, string>): Promise<string> {
  const sorted = Object.keys(answers)
    .sort()
    .map((id) => [id, answers[id]]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(sorted)));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `quiz:v${ruleVersion ?? 0}:${hex.slice(0, 40)}`;
}

function Quiz({ eligibility, onChanged }: { eligibility: Loadable<Eligibility>; onChanged: () => void }) {
  const { t } = accessCopy.useCopy();
  const api = useFuturesApi();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [state, setState] = useState<
    { kind: 'idle' | 'busy' } | { kind: 'result'; passed: boolean; score: number; mark: number } | { kind: 'failed'; reason: string }
  >({ kind: 'idle' });
  if (eligibility.status === 'loading') return <Skeleton className="h-10 w-full" />;
  if (eligibility.status === 'error')
    return (
      <StateBlock kind="error" title={t('Quiz heading')} thing={t('Quiz thing')} onRetry={eligibility.retry} retryLabel={t('Try again')} />
    );
  if (eligibility.status !== 'ready') {
    const words = futuresRefusal({ code: eligibility.status === 'refused' ? eligibility.code : undefined });
    return (
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-sm font-medium">{t('Quiz heading')}</h3>
        <p className={note}>
          {words.title}. {words.body}
        </p>
      </div>
    );
  }
  const { state: level, questions } = eligibility.data;
  const heading = <h3 className="m-0 text-sm font-medium">{t('Quiz heading')}</h3>;
  if (level.status === 'eligible')
    return (
      <div className="flex flex-col gap-1" data-testid="futures-quiz">
        {heading}
        <p className={note}>{t('Quiz passed')}</p>
      </div>
    );
  if (level.reason === 'rules_unpublished' || !questions || questions.length === 0)
    return (
      <div className="flex flex-col gap-1" data-testid="futures-quiz">
        {heading}
        <p className={note}>{t('Quiz unpublished')}</p>
      </div>
    );
  const complete = questions.every((q) => answers[q.id]);
  const submit = async () => {
    setState({ kind: 'busy' });
    const result = await api.assessEligibility({ clientSubmissionId: await submissionId(level.ruleVersion, answers), answers });
    if (!result.ok) return setState({ kind: 'failed', reason: futuresRefusal(result).title });
    setState({ kind: 'result', passed: result.data.passed, score: result.data.score, mark: result.data.passMark });
    onChanged();
  };
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="futures-quiz"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete && state.kind !== 'busy') void submit();
      }}
    >
      {heading}
      <p className={note}>
        {t('Quiz intro', { count: String(questions.length), mark: String(level.passMark ?? '') })}
        {level.lastScore != null ? ` ${t('Quiz last', { score: String(level.lastScore) })}` : ''}
      </p>
      {level.identity && !level.identity.met ? <p className="text-xs text-warn">{t('Quiz identity')}</p> : null}
      {questions.map((question) => (
        <fieldset key={question.id} className="m-0 flex flex-col gap-1 border-0 p-0">
          <legend className="mb-1 text-sm">{question.prompt}</legend>
          {question.options.map((option) => (
            <label key={option.id} className="flex items-start gap-2 text-sm text-fg-2">
              <input
                className="mt-0.5 size-4 shrink-0 appearance-auto accent-lime"
                type="radio"
                name={`quiz-${question.id}`}
                value={option.id}
                checked={answers[question.id] === option.id}
                onChange={() => setAnswers((now) => ({ ...now, [question.id]: option.id }))}
              />
              <span>{option.text}</span>
            </label>
          ))}
        </fieldset>
      ))}
      <Button type="submit" variant="secondary" size={32} disabled={!complete} loading={state.kind === 'busy'}>
        {t('Quiz submit')}
      </Button>
      {!complete ? <p className={note}>{t('Quiz answer all')}</p> : null}
      {state.kind === 'result' ? (
        <p role="status" className={state.passed ? note : 'text-xs text-warn'}>
          {state.passed
            ? t('Quiz result pass', { score: String(state.score) })
            : t('Quiz result fail', { score: String(state.score), mark: String(state.mark) })}
        </p>
      ) : null}
      {state.kind === 'failed' ? <p className="text-xs text-warn">{t('Quiz failed', { reason: state.reason })}</p> : null}
    </form>
  );
}
