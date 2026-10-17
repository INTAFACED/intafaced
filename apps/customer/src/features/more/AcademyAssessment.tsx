import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { Button, Loading } from '../../shared/ui';
import { useApi, useSession } from '../session/session';
import {
  academyCodeOf,
  maxScoreOf,
  newAttemptId,
  readAssessment,
  readAttempts,
  submitAssessment,
  type Assessment as AssessmentData,
  type Attempt,
} from './academy-flows';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { formatMoment } from './academy-lms';
import { AcademyRefusal, GuardedButton } from './AcademyLmsParts';
import './academy-lms.css';

type Failure = Extract<ApiResult<never>, { ok: false }>;
export type History = { status: 'loading' } | { status: 'ready'; data: Attempt[] } | { status: 'failed'; failure: Failure };
export type Problem = { kind: 'failure'; failure: Failure } | { kind: 'not-recorded' } | { kind: 'unconfirmed'; failure: Failure };
export type Result = { attempt: Attempt; recovered: boolean };

export type SubmitBlock =
  | { key: 'submitInFlight' }
  | { key: 'submitCheckFirst' }
  | { key: 'submitNeedsHistory' }
  | { key: 'submitNeedsAnswers'; remaining: number };

/**
 * Why Submit is off, or null when it is on. The order matters: a request in flight and a lost reply come before
 * anything the person can fix by answering, and the attempt history must be loaded so a lost reply can be checked.
 */
export function submitBlock(state: {
  sending: boolean;
  unconfirmed: boolean;
  historyReady: boolean;
  refreshing: boolean;
  remaining: number;
}): SubmitBlock | null {
  if (state.sending) return { key: 'submitInFlight' };
  if (state.unconfirmed) return { key: 'submitCheckFirst' };
  if (!state.historyReady || state.refreshing) return { key: 'submitNeedsHistory' };
  if (state.remaining > 0) return { key: 'submitNeedsAnswers', remaining: state.remaining };
  return null;
}

/** This account's attempts at one assessment, read from Academy. A refresh keeps the last answer on screen while it runs. */
function useAttemptHistory(slug: string) {
  const api = useApi();
  const [history, setHistory] = useState<History>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const live = useRef(true);
  const latest = useRef(0);
  const refresh = useCallback(async (): Promise<ApiResult<Attempt[]>> => {
    const mine = ++latest.current;
    setRefreshing(true);
    const result = await readAttempts(api, slug);
    if (live.current && latest.current === mine) {
      setHistory(result.ok ? { status: 'ready', data: result.data } : { status: 'failed', failure: result });
      setRefreshing(false);
    }
    return result;
  }, [api, slug]);
  useEffect(() => {
    live.current = true;
    void refresh();
    return () => {
      live.current = false;
    };
  }, [refresh]);
  return { history, refreshing, refresh };
}

/** The lesson's own self-check questions: study prompts from the lesson text. Nothing here is sent or scored. */
export function StudyQuestions({ prompts }: { prompts: readonly string[] }) {
  const { t } = copy.useCopy();
  if (prompts.length === 0) return null;
  return (
    <div className="academy-lms-stack">
      <h4>{t('studyTitle')}</h4>
      <p className="muted">{t('studyNote')}</p>
      <ol className="academy-lms-stack" lang="und">
        {prompts.map((prompt) => (
          <li key={prompt}>{prompt}</li>
        ))}
      </ol>
    </div>
  );
}

/** Attempt history: newest first, as Academy lists it, numbered from the first attempt. */
export function AttemptHistory({ history, onRetry }: { history: History; onRetry: () => void }) {
  const { t } = copy.useCopy();
  const { language } = usePreferences();
  return (
    <section className="academy-lms-stack" aria-label={t('attemptsTitle')}>
      <h4>{t('attemptsTitle')}</h4>
      {history.status === 'loading' && <Loading />}
      {history.status === 'failed' && <AcademyRefusal failure={history.failure} retry={onRetry} />}
      {history.status === 'ready' &&
        (history.data.length === 0 ? (
          <p>{t('attemptsEmpty')}</p>
        ) : (
          <>
            <p className="muted" role="status">
              {history.data.length === 1 ? t('attemptsCountOne') : t('attemptsCount', { count: history.data.length })}
            </p>
            <ul className="academy-lms-rows">
              {history.data.map((attempt, index) => (
                <li key={`${attempt.submittedAt}-${index}`}>
                  <span>{history.data.length - index}</span>
                  <div>
                    <strong>{t('attemptRow', { number: history.data.length - index })}</strong>
                    <div className="academy-lms-meta">
                      <span>{t('attemptScore', { score: attempt.score, maxScore: attempt.maxScore })}</span>
                      <time dateTime={attempt.submittedAt}>{formatMoment(attempt.submittedAt, language)}</time>
                    </div>
                  </div>
                  <span className="academy-lms-chip" data-status={attempt.pass ? 'passed' : 'failed'}>
                    {attempt.pass ? t('resultPassed') : t('resultNotPassed')}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ))}
    </section>
  );
}

export type QuizViewProps = {
  assessment: AssessmentData;
  answers: Readonly<Record<string, string>>;
  onAnswer: (questionId: string, choiceId: string) => void;
  sending: boolean;
  result: Result | null;
  problem: Problem | null;
  history: History;
  block: SubmitBlock | null;
  onSubmit: () => void;
  onAnswerAgain: () => void;
  onCheckHistory: () => void;
  onRetryHistory: () => void;
  onReloadQuestions: () => void;
};

/** The questions, the submit control with its reason, the result, and the attempts. Pure: every state arrives as a prop. */
export function QuizView(props: QuizViewProps) {
  const { t } = copy.useCopy();
  const id = useId();
  const { assessment, answers, result, problem, block } = props;
  const total = assessment.questions.length;
  const answered = assessment.questions.filter((q) => answers[q.id] !== undefined).length;
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);
  const locked = props.sending || result !== null;
  const invalidAnswers = problem?.kind === 'failure' && academyCodeOf(problem.failure) === 'academy.assessment_invalid';
  const reasonText = block
    ? block.key === 'submitNeedsAnswers'
      ? t('submitNeedsAnswers', { remaining: block.remaining })
      : t(block.key)
    : null;
  return (
    <div className="academy-lms-stack">
      <div className="academy-lms-meta">
        <span>{t('assessmentPassMark', { passMark: assessment.passMark, maxScore: maxScoreOf(assessment) })}</span>
        <span role="status">{t('answeredCount', { answered, total })}</span>
      </div>
      <form
        className="academy-lms-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!block && !result) props.onSubmit();
        }}
        aria-busy={props.sending}
      >
        <div className="academy-lms-stack">
          {assessment.questions.map((question, index) => (
            <fieldset key={question.id} disabled={locked}>
              <legend>
                <small className="muted">
                  {t('questionLegend', { position: index + 1, total })} ·{' '}
                  {question.points === 1 ? t('questionPointsOne') : t('questionPoints', { points: question.points })}
                </small>
                <span lang="und" style={{ display: 'block' }}>
                  {question.prompt}
                </span>
              </legend>
              {question.choices.map((choice) => (
                <label key={choice.id} className="academy-lms-choice">
                  <input
                    type="radio"
                    name={`${id}-${question.id}`}
                    value={choice.id}
                    checked={answers[question.id] === choice.id}
                    onChange={() => props.onAnswer(question.id, choice.id)}
                  />
                  <span lang="und">{choice.text}</span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        {!result && (
          <GuardedButton type="submit" reasonId={`${id}-reason`} reason={reasonText} variant="primary">
            {props.sending ? t('submitting') : t('submitAnswers')}
          </GuardedButton>
        )}
      </form>
      {props.sending && <Loading label={t('submitting')} />}
      {problem?.kind === 'failure' && <AcademyRefusal failure={problem.failure} />}
      {problem?.kind === 'not-recorded' && (
        <div className="failure" role="alert">
          <p>{t('submitNotRecorded')}</p>
        </div>
      )}
      {problem?.kind === 'unconfirmed' && (
        <div className="failure" role="alert">
          <p>{t('submitUnconfirmed')}</p>
          <Button variant="secondary" onClick={props.onCheckHistory}>
            {t('checkAttempts')}
          </Button>
        </div>
      )}
      {invalidAnswers && (
        <div>
          <Button variant="secondary" onClick={props.onReloadQuestions}>
            {t('reloadQuestions')}
          </Button>
        </div>
      )}
      {result && (
        <div className="academy-lms-result" role="status" tabIndex={-1} ref={resultRef}>
          <h4>{t('resultTitle')}</h4>
          <p>{t('resultScore', { score: result.attempt.score, maxScore: result.attempt.maxScore })}</p>
          <div className="academy-lms-meta">
            <span className="academy-lms-chip" data-status={result.attempt.pass ? 'passed' : 'failed'}>
              {result.attempt.pass ? t('resultPassed') : t('resultNotPassed')}
            </span>
            <span>{t('assessmentPassMark', { passMark: assessment.passMark, maxScore: result.attempt.maxScore })}</span>
          </div>
          {result.recovered && <p className="muted">{t('resultRecovered')}</p>}
          <div>
            <Button variant="secondary" onClick={props.onAnswerAgain}>
              {t('answerAgain')}
            </Button>
          </div>
        </div>
      )}
      <AttemptHistory history={props.history} onRetry={props.onRetryHistory} />
    </div>
  );
}

/**
 * Answering state for one assessment. A submit is sent once per attempt reference; when its reply is lost the attempt
 * history is read, and nothing is sent again until that history has been checked.
 */
function Quiz({ assessment, onReload }: { assessment: AssessmentData; onReload: () => void }) {
  const api = useApi();
  const { history, refreshing, refresh } = useAttemptHistory(assessment.slug);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const attemptId = useRef(newAttemptId());
  const lostReplyBase = useRef<number | null>(null);
  const inFlight = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const remaining = assessment.questions.filter((q) => answers[q.id] === undefined).length;
  const block = submitBlock({
    sending,
    unconfirmed: problem?.kind === 'unconfirmed',
    historyReady: history.status === 'ready',
    refreshing,
    remaining,
  });

  async function submit() {
    if (inFlight.current || block !== null || history.status !== 'ready' || result) return;
    inFlight.current = true;
    setSending(true);
    setProblem(null);
    const before = history.data.length;
    const outcome = await submitAssessment(api, {
      slug: assessment.slug,
      clientAttemptId: attemptId.current,
      answers: assessment.questions.map((q) => ({ questionId: q.id, choiceId: answers[q.id]! })),
      attemptsBefore: before,
    });
    inFlight.current = false;
    if (!live.current) return;
    setSending(false);
    if (outcome.kind === 'scored') setResult({ attempt: outcome.attempt, recovered: false });
    else if (outcome.kind === 'recovered') setResult({ attempt: outcome.attempt, recovered: true });
    else if (outcome.kind === 'not-recorded') setProblem({ kind: 'not-recorded' });
    else if (outcome.kind === 'unconfirmed') {
      lostReplyBase.current = before;
      setProblem({ kind: 'unconfirmed', failure: outcome.failure });
    } else setProblem({ kind: 'failure', failure: outcome.failure });
    // Every outcome re-reads the history, so the list and the next submit's baseline are Academy's own.
    if (outcome.kind !== 'unconfirmed') void refresh();
  }

  async function checkHistory() {
    const base = lostReplyBase.current ?? (history.status === 'ready' ? history.data.length : 0);
    const read = await refresh();
    if (!read.ok || !live.current) return;
    lostReplyBase.current = null;
    const newest = read.data[0];
    if (newest && read.data.length > base) {
      setResult({ attempt: newest, recovered: true });
      setProblem(null);
    } else setProblem({ kind: 'not-recorded' });
  }

  function answerAgain() {
    attemptId.current = newAttemptId();
    lostReplyBase.current = null;
    setAnswers({});
    setResult(null);
    setProblem(null);
  }

  return (
    <QuizView
      assessment={assessment}
      answers={answers}
      onAnswer={(questionId, choiceId) => setAnswers((old) => ({ ...old, [questionId]: choiceId }))}
      sending={sending}
      result={result}
      problem={problem}
      history={history}
      block={block}
      onSubmit={() => void submit()}
      onAnswerAgain={answerAgain}
      onCheckHistory={() => void checkHistory()}
      onRetryHistory={() => void refresh()}
      onReloadQuestions={onReload}
    />
  );
}

/**
 * Lesson-end assessment. The questions and scoring belong to Academy: this reads the published questions, sends the
 * chosen answers once, and shows the score and attempts Academy returns. A lesson with no published assessment says so
 * in the service's own words and keeps its study questions.
 */
export function Assessment({ slug, prompts }: { slug: string; prompts: readonly string[] }) {
  const { t } = copy.useCopy();
  const api = useApi();
  const { userId } = useSession();
  const quiz = useResource((signal) => readAssessment(api, slug, signal), `assessment:${userId}:${slug}`);
  const { resource } = quiz;
  return (
    <section className="academy-lms-assessment" aria-label={t('assessmentTitle')}>
      <h3>{t('assessmentTitle')}</h3>
      {resource.status === 'loading' && <Loading />}
      {resource.status === 'failed' && (
        <>
          <AcademyRefusal failure={resource.failure} retry={quiz.reload} />
          <StudyQuestions prompts={prompts} />
        </>
      )}
      {resource.status === 'ready' && (
        <>
          <p className="muted">{t('assessmentIntro')}</p>
          <Quiz assessment={resource.data} onReload={quiz.reload} />
        </>
      )}
    </section>
  );
}
