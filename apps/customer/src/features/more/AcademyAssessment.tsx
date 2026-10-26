import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  academyQuizAttemptSchema,
  academyQuizReviewSchema,
  type AcademyQuiz,
  type AcademyQuizAttempt,
  type AcademyQuizReview,
} from '@intafaced/contracts/academy-catalogue';
import type { ApiResult } from '../../shared/api';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { Button, Loading } from '../../shared/ui';
import { useApi, useSession } from '../session/session';
import { academyCodeOf, academyRefusalKey, readAttempts, readQuiz, type Attempt } from './academy-flows';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { formatMoment } from './academy-lms';
import { AcademyRefusal } from './AcademyLmsParts';
import './academy-lms.css';

type Failure = Extract<ApiResult<never>, { ok: false }>;
export type History = { status: 'loading' } | { status: 'ready'; data: Attempt[] } | { status: 'failed'; failure: Failure };

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
                    <div data-testid="academy-lms-meta" className="academy-lms-meta">
                      <span>
                        {attempt.hiddenUntil === null
                          ? t('attemptScore', { score: attempt.score, maxScore: attempt.maxScore })
                          : t('attemptHidden', { date: formatMoment(attempt.hiddenUntil, language) })}
                      </span>
                      <time dateTime={attempt.submittedAt}>{formatMoment(attempt.submittedAt, language)}</time>
                    </div>
                  </div>
                  {attempt.hiddenUntil === null && (
                    <span className="academy-lms-chip" data-status={attempt.pass ? 'passed' : 'failed'}>
                      {attempt.pass ? t('resultPassed') : t('resultNotPassed')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </>
        ))}
    </section>
  );
}

/** Seconds as m:ss, the way a quiz clock reads. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export type TimedQuizViewProps = {
  quiz: AcademyQuiz;
  attempt: AcademyQuizAttempt | null;
  /** The open attempt's time left, counted down on screen from the server's figure; null with no time limit. */
  secondsLeft: number | null;
  /** The open attempt was found already running when the page opened (a refresh, another device). */
  resumed: boolean;
  timeUp: boolean;
  position: number;
  saving: 'idle' | 'saving' | 'saved';
  sending: boolean;
  review: AcademyQuizReview | null;
  problem: Failure | null;
  history: History;
  onStart: () => void;
  onAnswer: (questionId: string, choiceId: string) => void;
  onMove: (position: number) => void;
  onFinish: () => void;
  onRetryHistory: () => void;
};

/**
 * A timed quiz (AC-quizzes-03), one question at a time. Pure: every state arrives as a prop. The rules come first (time
 * limit, attempts, what the review shows); an open attempt shows its number, the clock and the saved answer; a finished
 * one shows the score and the review the quiz allows.
 */
export function TimedQuizView(props: TimedQuizViewProps) {
  const { t } = copy.useCopy();
  const { language } = usePreferences();
  const id = useId();
  const { quiz, attempt, review, problem } = props;
  const total = quiz.questions.length;
  const maxScore = quiz.questions.reduce((sum, q) => sum + q.points, 0);
  const open = attempt !== null && attempt.result === null;
  const question = open ? quiz.questions[Math.min(Math.max(props.position, 0), total - 1)] : undefined;
  const answered = open ? quiz.questions.filter((q) => attempt.answers[q.id] !== undefined).length : 0;
  const choiceText = (questionId: string, choiceId: string | null) =>
    review?.questions?.find((q) => q.id === questionId)?.choices.find((c) => c.id === choiceId)?.text ?? choiceId ?? '';
  return (
    <div className="academy-lms-stack" data-quiz={quiz.slug} data-quiz-state={open ? 'open' : attempt?.result ? 'finished' : 'ready'}>
      <div data-testid="academy-lms-meta" className="academy-lms-meta">
        <span>{t('assessmentPassMark', { passMark: quiz.passMark, maxScore })}</span>
        <span>
          {quiz.timeLimitSeconds === null ? t('quizNoTimeLimit') : t('quizTimeLimit', { minutes: Math.ceil(quiz.timeLimitSeconds / 60) })}
        </span>
        <span>{quiz.attemptLimit === null ? t('quizNoAttemptLimit') : t('quizAttemptLimit', { limit: quiz.attemptLimit })}</span>
      </div>
      <p className="muted">{quiz.reviewMode === 'answers' ? t('quizReviewAnswers') : t('quizReviewScoreOnly')}</p>
      {open && question ? (
        <form
          className="academy-lms-form"
          aria-busy={props.sending}
          onSubmit={(event) => {
            event.preventDefault();
            props.onFinish();
          }}
        >
          <div data-testid="academy-lms-meta" className="academy-lms-meta">
            <strong>{t('quizAttemptNumber', { number: attempt.number })}</strong>
            {props.secondsLeft !== null && (
              <span role="timer" data-seconds-left={props.secondsLeft}>
                {t('quizTimeLeft', { time: clock(props.secondsLeft) })}
              </span>
            )}
            <span>{t('answeredCount', { answered, total })}</span>
          </div>
          {props.resumed && <p className="muted">{t('quizResumed')}</p>}
          <fieldset key={question.id} disabled={props.sending} data-quiz-question={question.id}>
            <legend>
              <small className="muted">
                {t('questionLegend', { position: props.position + 1, total })} ·{' '}
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
                  checked={attempt.answers[question.id] === choice.id}
                  onChange={() => props.onAnswer(question.id, choice.id)}
                />
                <span lang="und">{choice.text}</span>
              </label>
            ))}
          </fieldset>
          <p className="muted" role="status">
            {props.saving === 'saving' ? t('quizSaving') : props.saving === 'saved' ? t('quizSaved') : ''}
          </p>
          <div className="academy-outline-nav">
            <Button type="button" variant="secondary" disabled={props.position === 0} onClick={() => props.onMove(props.position - 1)}>
              {t('quizPrevious')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={props.position >= total - 1}
              onClick={() => props.onMove(props.position + 1)}
            >
              {t('quizNext')}
            </Button>
            <Button type="submit" disabled={props.sending}>
              {props.sending ? t('quizFinishing') : t('quizFinish')}
            </Button>
          </div>
        </form>
      ) : (
        <>
          {attempt?.result && (
            <div className="academy-lms-result" role="status" data-quiz-result={attempt.attemptId}>
              <h4>{t('resultTitle')}</h4>
              {props.timeUp && <p>{t('quizTimeUp')}</p>}
              {attempt.result.hidden ? (
                <p data-quiz-hidden={attempt.result.hiddenUntil}>
                  {t('quizResultHidden', { date: formatMoment(attempt.result.hiddenUntil, language) })}
                </p>
              ) : (
                <>
                  <p>{t('resultScore', { score: attempt.result.score, maxScore: attempt.result.maxScore })}</p>
                  <span className="academy-lms-chip" data-status={attempt.result.pass ? 'passed' : 'failed'}>
                    {attempt.result.pass ? t('resultPassed') : t('resultNotPassed')}
                  </span>
                </>
              )}
              {review &&
                (review.questions === null ? (
                  <p className="muted" data-quiz-review="score_only">
                    {t('quizScoreOnly')}
                  </p>
                ) : (
                  <section className="academy-lms-stack" data-quiz-review="answers" aria-label={t('quizReviewTitle')}>
                    <h4>{t('quizReviewTitle')}</h4>
                    <ol className="academy-lms-stack">
                      {review.questions.map((q) => (
                        <li key={q.id} data-review-question={q.id} data-review-correct={q.correct}>
                          <span lang="und">{q.prompt}</span>
                          <div data-testid="academy-lms-meta" className="academy-lms-meta">
                            <span>
                              {q.chosenChoiceId === null
                                ? t('quizNoAnswer')
                                : t('quizYourAnswer', { choice: choiceText(q.id, q.chosenChoiceId) })}
                            </span>
                            <span>{t('quizCorrectAnswer', { choice: choiceText(q.id, q.correctChoiceId) })}</span>
                            <span className="academy-lms-chip" data-status={q.correct ? 'passed' : 'failed'}>
                              {q.correct ? t('quizCorrect') : t('quizIncorrect')}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>
                ))}
            </div>
          )}
          <div>
            <Button disabled={props.sending} onClick={props.onStart}>
              {attempt?.result ? t('quizStartAnother') : t('quizStart')}
            </Button>
          </div>
        </>
      )}
      {problem && <AcademyRefusal failure={problem} />}
      <AttemptHistory history={props.history} onRetry={props.onRetryHistory} />
    </div>
  );
}

/**
 * The timed attempt's state. The server holds the attempt, its deadline and the saved answers, so a refresh reads the
 * same attempt back. Start, Finish and each answer are each safe to send twice: Academy returns the open attempt for a
 * second Start, scores a Finish once, and an answer is the latest choice. A lost reply is settled by reading again.
 */
function TimedQuiz({ quiz, onFinished }: { quiz: AcademyQuiz; onFinished?: () => void }) {
  const api = useApi();
  const { history, refresh } = useAttemptHistory(quiz.slug);
  const [attempt, setAttempt] = useState<AcademyQuizAttempt | null>(null);
  const [resumed, setResumed] = useState(false);
  const [timeUp, setTimeUp] = useState(false);
  const [position, setPosition] = useState(0);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [sending, setSending] = useState(false);
  const [review, setReview] = useState<AcademyQuizReview | null>(null);
  const [problem, setProblem] = useState<Failure | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const inFlight = useRef(false);
  const live = useRef(true);
  const clockEnd = useRef<number | null>(null);
  // Answers save one after another, in the order chosen, and Finish waits for them: the last choice is the one scored.
  const saves = useRef<Promise<void>>(Promise.resolve());
  const latestSave = useRef(0);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const show = useCallback(
    (next: AcademyQuizAttempt | null) => {
      setAttempt(next);
      // The clock runs from the server's figure; the browser's own time never sets the deadline.
      clockEnd.current = next && next.result === null && next.secondsLeft !== null ? performance.now() + next.secondsLeft * 1000 : null;
      setSecondsLeft(next && next.result === null ? next.secondsLeft : null);
      // A hidden result has no review to read until its date.
      if (next?.result && !next.result.hidden) {
        void api.query('academy', 'assessment.review', { attemptId: next.attemptId }, academyQuizReviewSchema).then((r) => {
          if (live.current && r.ok) setReview(r.data);
        });
        void refresh();
      } else setReview(null);
    },
    [api, refresh],
  );

  const firstOpen = (next: AcademyQuizAttempt) =>
    Math.max(
      0,
      quiz.questions.findIndex((q) => next.answers[q.id] === undefined),
    );

  // A refresh or another device: the open attempt comes back with the same deadline and the answers saved so far.
  useEffect(() => {
    void api.query('academy', 'assessment.current', { slug: quiz.slug }, academyQuizAttemptSchema.nullable()).then((r) => {
      if (!live.current) return;
      if (!r.ok) return setProblem(r);
      if (r.data) {
        setResumed(true);
        setPosition(firstOpen(r.data));
        show(r.data);
      }
    });
  }, [api, quiz.slug]);

  const run = async (request: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setProblem(null);
    try {
      await request();
    } finally {
      inFlight.current = false;
      if (live.current) setSending(false);
    }
  };

  const finish = (attemptId: string, byClock = false) =>
    run(async () => {
      await saves.current;
      let done = await api.mutate('academy', 'assessment.finish', { attemptId }, academyQuizAttemptSchema);
      // Finishing twice scores once, so a lost reply is settled by asking again.
      if (!done.ok && done.reason === 'uncertain')
        done = await api.mutate('academy', 'assessment.finish', { attemptId }, academyQuizAttemptSchema);
      if (!live.current) return;
      if (!done.ok) return setProblem(done);
      setTimeUp(byClock);
      show(done.data);
      onFinished?.();
    });

  useEffect(() => {
    if (clockEnd.current === null || !attempt || attempt.result) return;
    const tick = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((clockEnd.current! - performance.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) {
        window.clearInterval(tick);
        void finish(attempt.attemptId, true);
      }
    }, 1000);
    return () => window.clearInterval(tick);
  }, [attempt]);

  const start = () =>
    run(async () => {
      let started = await api.mutate('academy', 'assessment.start', { slug: quiz.slug }, academyQuizAttemptSchema);
      if (!started.ok && started.reason === 'uncertain') {
        // The reply was lost: Academy may have opened the attempt. Reading it back returns that same attempt.
        const open = await api.query('academy', 'assessment.current', { slug: quiz.slug }, academyQuizAttemptSchema.nullable());
        if (open.ok && open.data) started = { ok: true, data: open.data };
      }
      if (!live.current) return;
      if (!started.ok) return setProblem(started);
      setResumed(false);
      setTimeUp(false);
      setPosition(firstOpen(started.data));
      show(started.data);
    });

  const answer = (questionId: string, choiceId: string) => {
    if (!attempt || attempt.result) return;
    const { attemptId } = attempt;
    setAttempt({ ...attempt, answers: { ...attempt.answers, [questionId]: choiceId } });
    setSaving('saving');
    setProblem(null);
    const mine = ++latestSave.current;
    saves.current = saves.current.then(async () => {
      const saved = await api.mutate('academy', 'assessment.answer', { attemptId, questionId, choiceId }, academyQuizAttemptSchema);
      if (!live.current) return;
      if (saved.ok) {
        // Only the newest save's reply speaks for the screen; an earlier one would show answers from before it.
        if (mine === latestSave.current) {
          setSaving('saved');
          setAttempt((now) => (now && now.attemptId === saved.data.attemptId ? { ...now, answers: saved.data.answers } : now));
        }
        return;
      }
      setSaving('idle');
      setProblem(saved);
      // A closed attempt (its time ran out): read its result rather than leave the answers editable.
      if (academyCodeOf(saved) === 'academy.attempt_closed') void finish(attemptId, true);
    });
  };

  return (
    <TimedQuizView
      quiz={quiz}
      attempt={attempt}
      secondsLeft={secondsLeft}
      resumed={resumed}
      timeUp={timeUp}
      position={position}
      saving={saving}
      sending={sending}
      review={review}
      problem={problem}
      history={history}
      onStart={() => void start()}
      onAnswer={answer}
      onMove={setPosition}
      onFinish={() => attempt && void finish(attempt.attemptId)}
      onRetryHistory={() => void refresh()}
    />
  );
}

/**
 * Lesson-end quiz. The questions, the clock and the scoring belong to Academy: this reads the published quiz, keeps one
 * attempt open on the server, and shows the score and the review Academy returns. A lesson with no published quiz says
 * so in the service's own words and keeps its study questions.
 */
export function Assessment({ slug, prompts, onFinished }: { slug: string; prompts: readonly string[]; onFinished?: () => void }) {
  const { t } = copy.useCopy();
  const api = useApi();
  const { userId } = useSession();
  const quiz = useResource((signal) => readQuiz(api, slug, signal), `assessment:${userId}:${slug}`);
  const { resource } = quiz;
  return (
    <section className="academy-lms-assessment" aria-label={t('assessmentTitle')}>
      <h3>{t('assessmentTitle')}</h3>
      {resource.status === 'loading' && <Loading />}
      {resource.status === 'failed' && (
        <>
          {academyRefusalKey(resource.failure) === 'refAssessmentUnpublished' ? (
            // A lesson with no assessment is an ordinary state, not an error: a quiet note, not a failure box.
            <p className="muted">{t('refAssessmentUnpublished')}</p>
          ) : (
            <AcademyRefusal failure={resource.failure} retry={quiz.reload} />
          )}
          <StudyQuestions prompts={prompts} />
        </>
      )}
      {resource.status === 'ready' && <TimedQuiz quiz={resource.data} onFinished={onFinished} />}
    </section>
  );
}
