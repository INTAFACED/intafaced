'use client';

import { useCallback, useState } from 'react';
import {
  ACADEMY_QUESTION_KINDS,
  ACADEMY_QUIZ_SCORING_POLICIES,
  ACADEMY_RESULTS_VISIBILITY,
  type AcademyCourseQuizBlocker,
  type AcademyCourseQuizKind,
  type AcademyCourseQuizQuestion,
  type AcademyCourseQuizReview,
  type AcademyQuestionKind,
  type AcademyQuizScoringPolicy,
  type AcademyResultsVisibility,
} from '@intafaced/contracts/academy-course-quizzes';
import { Chip } from '@/components/chip';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchQuiz, postQuizChange } from '@/lib/academy/quizzes-browser';
import type { AcademyAdminCourseQuiz, QuizDeskReply, QuizView } from '@/lib/academy/quizzes-model';
import { Failed, Outcome } from '@/components/academy-courses-desk';

/**
 * QUIZ EDITOR (AC-quizzes-01, AC-quizzes-02).
 *
 * A quiz item's questions and attempt rules, saved as a draft over the revision read, then published. The publish
 * button lists what stops it (no questions, no pass mark, more than one attempt with no scoring policy) and svc-academy
 * refuses the same by name. Once a learner has an attempt the questions stay and the quiz stays published; its rules
 * still change. The access code is never shown back: the editor says whether one is set. A question is single choice,
 * multi-select (with or without partial credit), numeric (an exact decimal answer within a tolerance) or essay; attempts
 * with an essay wait in the queue below, under per-quiz aliases, until staff score them. A survey has no key and no pass
 * mark, and an anonymous survey keeps no account with its answers. This section shows every refusal and reads again,
 * never retrying on its own.
 */

const BLOCKER_WORDS: Record<AcademyCourseQuizBlocker, string> = {
  'academy.quiz_no_questions': 'No questions yet',
  'academy.pass_mark_unset': 'The pass mark is not set',
  'academy.scoring_policy_unset': 'More than one attempt and no scoring policy',
};
const POLICY_WORDS: Record<AcademyQuizScoringPolicy, string> = {
  highest: 'Highest attempt counts',
  latest: 'Latest attempt counts',
  first: 'First attempt counts',
  average: 'Average of attempts',
};

const KIND_WORDS: Record<AcademyQuestionKind, string> = {
  single: 'Single choice',
  multi: 'Multi-select',
  numeric: 'Numeric',
  essay: 'Essay (scored by staff)',
};
const VISIBILITY_WORDS: Record<AcademyResultsVisibility, string> = {
  always: 'As soon as the attempt is finished',
  after_last_attempt: 'Only after the last attempt allowed',
  never: 'Never',
};

/**
 * One question as the form holds it. The keys are choice texts, so editing or reordering the lines never moves a key to
 * another choice. Numbers stay strings until the save, and a decimal answer is never a JavaScript number.
 */
type DraftQuestion = {
  id: string;
  kind: AcademyQuestionKind;
  prompt: string;
  points: string;
  choices: string;
  answer: string;
  answers: string[];
  partialCredit: boolean;
  numericAnswer: string;
  tolerance: string;
};

const blankQuestion = (id: string): DraftQuestion => ({
  id,
  kind: 'single',
  prompt: '',
  points: '1',
  choices: '',
  answer: '',
  answers: [],
  partialCredit: false,
  numericAnswer: '',
  tolerance: '0',
});

const textOf = (choices: readonly { id: string; text: string }[], id: string) => choices.find((c) => c.id === id)?.text ?? '';

const draftOf = (q: AcademyCourseQuizQuestion): DraftQuestion => ({
  ...blankQuestion(q.id),
  kind: q.kind,
  prompt: q.prompt,
  points: String(q.points),
  ...('choices' in q ? { choices: q.choices.map((c) => c.text).join('\n') } : {}),
  ...(q.kind === 'single' && q.correctChoiceId ? { answer: textOf(q.choices, q.correctChoiceId) } : {}),
  ...(q.kind === 'multi' ? { answers: (q.correctChoiceIds ?? []).map((id) => textOf(q.choices, id)), partialCredit: q.partialCredit } : {}),
  ...(q.kind === 'numeric' ? { numericAnswer: q.answer ?? '', tolerance: q.tolerance } : {}),
});

const linesOf = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** The question as svc-academy takes it: choices one per line, ids by position. A survey's questions carry no key. */
const questionOf = (q: DraftQuestion, survey: boolean): AcademyCourseQuizQuestion => {
  const base = { id: q.id, prompt: q.prompt.trim(), points: Number(q.points) };
  const lines = linesOf(q.choices);
  const choices = lines.map((text, i) => ({ id: `c${i + 1}`, text }));
  // A key whose text is no longer a choice names none, and svc-academy's check refuses the save.
  const idOf = (text: string) => `c${lines.indexOf(text.trim()) + 1}`;
  switch (q.kind) {
    case 'single':
      return { kind: 'single', ...base, choices, correctChoiceId: survey ? null : idOf(q.answer) };
    case 'multi':
      return {
        kind: 'multi',
        ...base,
        choices,
        correctChoiceIds: survey ? null : q.answers.filter((t) => lines.includes(t)).map(idOf),
        partialCredit: q.partialCredit,
      };
    case 'numeric':
      return { kind: 'numeric', ...base, answer: survey ? null : q.numericAnswer.trim(), tolerance: q.tolerance.trim() || '0' };
    case 'essay':
      return { kind: 'essay', ...base };
  }
};

/** A whole number from a field, or null when it is blank. */
const wholeOrNull = (value: string): number | null => (value.trim() === '' ? null : Number(value.trim()));

function Facts({ quiz }: { quiz: AcademyAdminCourseQuiz }) {
  return (
    <dl className="dk-kv" data-testid="quiz-facts">
      <dt>State</dt>
      <dd>
        <Chip tone={quiz.state === 'published' ? 'live' : 'warn'}>{quiz.state === 'published' ? 'Published' : 'Draft'}</Chip>
        {quiz.revision === 0 ? ' Nothing saved yet: learners see it as not released' : ` Revision ${quiz.revision}`}
      </dd>
      {quiz.savedAt && (
        <>
          <dt>Saved</dt>
          <dd>{formatWhen(quiz.savedAt)}</dd>
        </>
      )}
      <dt>Kind</dt>
      <dd>{quiz.kind === 'survey' ? (quiz.anonymous ? 'Anonymous survey' : 'Survey') : 'Graded quiz'}</dd>
      <dt>Attempts by learners</dt>
      <dd>
        {quiz.attempts}{' '}
        {quiz.kind === 'quiz' && (
          <a className="adm-btn" href={`/academy-ops/catalogue/quizzes/${quiz.itemId}`}>
            Attempts and score changes
          </a>
        )}
      </dd>
      <dt>Waiting for an essay score</dt>
      <dd>{quiz.pendingReview}</dd>
      <dt>Survey responses</dt>
      <dd>{quiz.responses}</dd>
      <dt>Access code</dt>
      <dd>{quiz.accessCodeSet ? 'Set (never shown again)' : 'Not set'}</dd>
      <dt>IP filter</dt>
      <dd>{quiz.ipAllow ? quiz.ipAllow.join(', ') : 'Not set'}</dd>
    </dl>
  );
}

function QuizForm({
  quiz,
  busy,
  onSave,
}: {
  quiz: AcademyAdminCourseQuiz;
  busy: boolean;
  onSave: (fields: Record<string, unknown>) => void;
}) {
  const locked = quiz.attempts > 0 || quiz.responses > 0;
  const [kind, setKind] = useState<AcademyCourseQuizKind>(quiz.kind);
  const [anonymous, setAnonymous] = useState(quiz.anonymous);
  const [visibility, setVisibility] = useState<AcademyResultsVisibility>(quiz.resultsVisibility);
  const survey = kind === 'survey';
  const [questions, setQuestions] = useState<DraftQuestion[]>(quiz.questions.map(draftOf));
  const [passMark, setPassMark] = useState(quiz.passMark === null ? '' : String(quiz.passMark));
  const [attemptLimit, setAttemptLimit] = useState(quiz.attemptLimit === null ? '' : String(quiz.attemptLimit));
  const [policy, setPolicy] = useState<AcademyQuizScoringPolicy | ''>(quiz.scoringPolicy ?? '');
  const [timeLimit, setTimeLimit] = useState(quiz.timeLimitSeconds === null ? '' : String(quiz.timeLimitSeconds));
  const [reviewMode, setReviewMode] = useState(quiz.reviewMode);
  const [code, setCode] = useState('');
  const [clearCode, setClearCode] = useState(false);
  const [ipAllow, setIpAllow] = useState((quiz.ipAllow ?? []).join('\n'));

  const set = (i: number, patch: Partial<DraftQuestion>) => setQuestions((qs) => qs.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const move = (i: number, by: number) =>
    setQuestions((qs) => {
      const next = [...qs];
      const [q] = next.splice(i, 1);
      next.splice(i + by, 0, q!);
      return next;
    });
  const freshId = () => {
    const used = new Set(questions.map((q) => q.id));
    let n = questions.length + 1;
    while (used.has(`q${n}`)) n += 1;
    return `q${n}`;
  };
  const ipLines = ipAllow
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  return (
    <form
      className="dk-stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          revision: quiz.revision,
          kind,
          anonymous: survey && anonymous,
          // A survey shows no score, so it carries no visibility rule that could refuse its save.
          resultsVisibility: survey ? 'always' : visibility,
          passMark: survey ? null : wholeOrNull(passMark),
          attemptLimit: wholeOrNull(attemptLimit),
          scoringPolicy: survey || policy === '' ? null : policy,
          timeLimitSeconds: wholeOrNull(timeLimit),
          reviewMode,
          // A survey takes no access code or IP filter; svc-academy refuses one.
          ipAllow: survey || ipLines.length === 0 ? null : ipLines,
          ...(survey
            ? quiz.accessCodeSet
              ? { accessCode: null }
              : {}
            : clearCode
              ? { accessCode: null }
              : code.trim()
                ? { accessCode: code.trim() }
                : {}),
          questions: questions.map((q) => questionOf(q, survey)),
        });
      }}
    >
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="quiz-kind">Quiz kind</label>
          <select id="quiz-kind" value={kind} disabled={locked} onChange={(e) => setKind(e.target.value as AcademyCourseQuizKind)}>
            <option value="quiz">Graded quiz</option>
            <option value="survey">Survey (no key, no score)</option>
          </select>
        </div>
        {survey && (
          <label>
            <input type="checkbox" checked={anonymous} disabled={locked} onChange={(e) => setAnonymous(e.target.checked)} /> Anonymous
            survey: no account is kept with an answer
          </label>
        )}
      </div>
      <h3>Questions</h3>
      {locked && <p className="dk-why">Learners have attempts on this quiz, so its questions stay as they are. Its rules still change.</p>}
      {questions.length === 0 && <p className="dk-muted">No questions yet. A quiz with no questions is not published.</p>}
      <ol className="dk-stack" data-testid="quiz-questions">
        {questions.map((q, i) => {
          const lines = linesOf(q.choices);
          return (
            <li key={q.id} className="dk-stack" data-question={q.id}>
              <div className="adm-field">
                <label htmlFor={`quiz-q${i}-prompt`}>{`Question ${i + 1}`}</label>
                <textarea
                  id={`quiz-q${i}-prompt`}
                  value={q.prompt}
                  rows={2}
                  disabled={locked}
                  onChange={(e) => set(i, { prompt: e.target.value })}
                />
              </div>
              <div className="dk-row">
                <div className="adm-field">
                  <label htmlFor={`quiz-q${i}-kind`}>{`Question ${i + 1} kind`}</label>
                  <select
                    id={`quiz-q${i}-kind`}
                    value={q.kind}
                    disabled={locked}
                    onChange={(e) => set(i, { kind: e.target.value as AcademyQuestionKind })}
                  >
                    {ACADEMY_QUESTION_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {KIND_WORDS[k]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="adm-field">
                  <label htmlFor={`quiz-q${i}-points`}>{`Question ${i + 1} points`}</label>
                  <input
                    id={`quiz-q${i}-points`}
                    inputMode="numeric"
                    value={q.points}
                    disabled={locked}
                    onChange={(e) => set(i, { points: e.target.value })}
                  />
                </div>
                {(q.kind === 'single' || q.kind === 'multi') && (
                  <div className="adm-field">
                    <label htmlFor={`quiz-q${i}-choices`}>{`Question ${i + 1} choices, one per line`}</label>
                    <textarea
                      id={`quiz-q${i}-choices`}
                      value={q.choices}
                      rows={4}
                      disabled={locked}
                      onChange={(e) => set(i, { choices: e.target.value })}
                    />
                  </div>
                )}
                {q.kind === 'single' && !survey && (
                  <div className="adm-field">
                    <label htmlFor={`quiz-q${i}-answer`}>{`Question ${i + 1} answer`}</label>
                    <select
                      id={`quiz-q${i}-answer`}
                      value={lines.includes(q.answer.trim()) ? q.answer.trim() : ''}
                      disabled={locked}
                      onChange={(e) => set(i, { answer: e.target.value })}
                    >
                      <option value="">Choose the answer</option>
                      {lines.map((text, j) => (
                        <option key={j} value={text}>
                          {text}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {q.kind === 'multi' && !survey && (
                  <fieldset className="dk-stack">
                    <legend>{`Question ${i + 1} correct choices`}</legend>
                    {lines.length === 0 && <span className="dk-muted">Write the choices first.</span>}
                    {lines.map((text, j) => (
                      <label key={j}>
                        <input
                          type="checkbox"
                          aria-label={`Question ${i + 1} correct: ${text}`}
                          checked={q.answers.includes(text)}
                          disabled={locked}
                          onChange={(e) =>
                            set(i, { answers: e.target.checked ? [...q.answers, text] : q.answers.filter((t) => t !== text) })
                          }
                        />{' '}
                        {text}
                      </label>
                    ))}
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`Question ${i + 1} partial credit`}
                        checked={q.partialCredit}
                        disabled={locked}
                        onChange={(e) => set(i, { partialCredit: e.target.checked })}
                      />{' '}
                      Partial credit: each correct choice earns an equal share, any wrong one earns nothing
                    </label>
                  </fieldset>
                )}
                {q.kind === 'numeric' && (
                  <>
                    {!survey && (
                      <div className="adm-field">
                        <label htmlFor={`quiz-q${i}-numeric`}>{`Question ${i + 1} numeric answer`}</label>
                        <input
                          id={`quiz-q${i}-numeric`}
                          inputMode="decimal"
                          value={q.numericAnswer}
                          disabled={locked}
                          onChange={(e) => set(i, { numericAnswer: e.target.value })}
                        />
                      </div>
                    )}
                    <div className="adm-field">
                      <label htmlFor={`quiz-q${i}-tolerance`}>{`Question ${i + 1} tolerance`}</label>
                      <input
                        id={`quiz-q${i}-tolerance`}
                        inputMode="decimal"
                        value={q.tolerance}
                        disabled={locked}
                        onChange={(e) => set(i, { tolerance: e.target.value })}
                      />
                    </div>
                  </>
                )}
                {q.kind === 'essay' && (
                  <p className="dk-muted">
                    {survey ? 'A written answer.' : 'Staff score it after the attempt; until then the attempt is pending review.'}
                  </p>
                )}
              </div>
              <div className="dk-row">
                <button type="button" className="adm-btn" disabled={locked || i === 0} onClick={() => move(i, -1)}>
                  {`Move question ${i + 1} up`}
                </button>
                <button type="button" className="adm-btn" disabled={locked || i === questions.length - 1} onClick={() => move(i, 1)}>
                  {`Move question ${i + 1} down`}
                </button>
                <button
                  type="button"
                  className="adm-btn"
                  disabled={locked}
                  onClick={() => setQuestions((qs) => qs.filter((_, j) => j !== i))}
                >
                  {`Remove question ${i + 1}`}
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <p>
        <button type="button" className="adm-btn" disabled={locked} onClick={() => setQuestions((qs) => [...qs, blankQuestion(freshId())])}>
          Add question
        </button>
      </p>

      <h3>Attempt rules</h3>
      <div className="dk-row">
        {!survey && (
          <div className="adm-field">
            <label htmlFor="quiz-pass-mark">Pass mark (points)</label>
            <input id="quiz-pass-mark" inputMode="numeric" value={passMark} onChange={(e) => setPassMark(e.target.value)} />
          </div>
        )}
        <div className="adm-field">
          <label htmlFor="quiz-attempts">Attempts allowed</label>
          <input id="quiz-attempts" inputMode="numeric" value={attemptLimit} onChange={(e) => setAttemptLimit(e.target.value)} />
        </div>
        {!survey && (
          <div className="adm-field">
            <label htmlFor="quiz-policy">Scoring policy</label>
            <select id="quiz-policy" value={policy} onChange={(e) => setPolicy(e.target.value as AcademyQuizScoringPolicy | '')}>
              <option value="">Not set</option>
              {ACADEMY_QUIZ_SCORING_POLICIES.map((p) => (
                <option key={p} value={p}>
                  {POLICY_WORDS[p]}
                </option>
              ))}
            </select>
          </div>
        )}
        {!survey && (
          <div className="adm-field">
            <label htmlFor="quiz-visibility">Results shown to learners</label>
            <select id="quiz-visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as AcademyResultsVisibility)}>
              {ACADEMY_RESULTS_VISIBILITY.map((v) => (
                <option key={v} value={v}>
                  {VISIBILITY_WORDS[v]}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="adm-field">
          <label htmlFor="quiz-time-limit">Time limit (seconds)</label>
          <input id="quiz-time-limit" inputMode="numeric" value={timeLimit} onChange={(e) => setTimeLimit(e.target.value)} />
        </div>
        <div className="adm-field">
          <label htmlFor="quiz-review">After an attempt, learners see</label>
          <select id="quiz-review" value={reviewMode} onChange={(e) => setReviewMode(e.target.value as typeof reviewMode)}>
            <option value="score_only">Their score only</option>
            <option value="answers">Each answer against the key</option>
          </select>
        </div>
      </div>
      <p className="dk-muted">
        A blank pass mark is not set and the quiz is not published. A pass mark of 0 means taking it completes it. Blank attempts or time
        limit means none applies.
      </p>
      {survey ? (
        <p className="dk-muted">A survey has no pass mark, no access code and no IP filter. Learners answer it once.</p>
      ) : (
        <>
          <div className="dk-row">
            <div className="adm-field">
              <label htmlFor="quiz-access-code">New access code</label>
              <input
                id="quiz-access-code"
                value={code}
                autoComplete="off"
                maxLength={64}
                disabled={clearCode}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            {quiz.accessCodeSet && (
              <label>
                <input type="checkbox" checked={clearCode} onChange={(e) => setClearCode(e.target.checked)} /> Remove the access code
              </label>
            )}
            <div className="adm-field">
              <label htmlFor="quiz-ip-allow">IP filter, one address or range per line</label>
              <textarea id="quiz-ip-allow" value={ipAllow} rows={3} onChange={(e) => setIpAllow(e.target.value)} />
            </div>
          </div>
          <p className="dk-muted">
            A blank access code keeps the one set. With an IP filter, a learner whose address cannot be read is refused rather than let in.
          </p>
        </>
      )}
      <button type="submit" className="adm-btn" disabled={busy}>
        Save quiz draft
      </button>
    </form>
  );
}

/** Attempts waiting for an essay score, under per-quiz aliases: score each essay from 0 to its points, then the attempt is graded. */
function EssayReviews({
  reviews,
  busy,
  onScore,
}: {
  reviews: readonly AcademyCourseQuizReview[];
  busy: boolean;
  onScore: (attemptId: string, points: Record<string, number>) => void;
}) {
  const [points, setPoints] = useState<Record<string, string>>({});
  return (
    <div className="dk-stack" data-testid="quiz-reviews">
      <h3>Essays waiting for a score</h3>
      {reviews.length === 0 && <p className="dk-muted">No attempt is waiting for an essay score.</p>}
      {reviews.map((r) => (
        <form
          key={r.attemptId}
          className="dk-stack"
          data-review={r.attemptId}
          onSubmit={(e) => {
            e.preventDefault();
            // A blank score is left out, so svc-academy refuses the save rather than reading it as 0.
            const typed = r.essays.flatMap((q) => {
              const value = (points[`${r.attemptId}:${q.questionId}`] ?? '').trim();
              return value === '' ? [] : [[q.questionId, Number(value)] as const];
            });
            onScore(r.attemptId, Object.fromEntries(typed));
          }}
        >
          <p>
            {`Learner ${r.alias}, attempt ${r.number}`}, finished {formatWhen(r.finishedAt)}. Scored automatically: {r.autoScore}.
          </p>
          {r.essays.map((q, j) => (
            <div key={q.questionId} className="dk-stack">
              <p>
                <strong>{q.prompt}</strong>
              </p>
              <blockquote>{q.text ?? 'No answer was saved.'}</blockquote>
              <div className="adm-field">
                <label htmlFor={`essay-${r.attemptId}-${j}`}>{`Learner ${r.alias} essay ${j + 1} points (0 to ${q.points})`}</label>
                <input
                  id={`essay-${r.attemptId}-${j}`}
                  inputMode="numeric"
                  value={points[`${r.attemptId}:${q.questionId}`] ?? ''}
                  onChange={(e) => setPoints((p) => ({ ...p, [`${r.attemptId}:${q.questionId}`]: e.target.value }))}
                />
              </div>
            </div>
          ))}
          <button type="submit" className="adm-btn" disabled={busy}>
            {`Save scores for learner ${r.alias}`}
          </button>
        </form>
      ))}
    </div>
  );
}

export function AcademyQuizEditor({ itemId, initial }: { itemId: string; initial: QuizView | null }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<QuizDeskReply | null>(null);
  const [reason, setReason] = useState('');

  const reload = useCallback(async () => {
    const next = await fetchQuiz(itemId);
    if (next) setView(next);
  }, [itemId]);

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    const answer = await postQuizChange({ itemId, ...body });
    setReply(answer);
    setBusy(false);
    // Whatever the answer, the section shows the quiz as svc-academy holds it now.
    await reload();
  };

  const part = view?.quiz;
  const quiz = part?.kind === 'ok' ? part.data : null;
  return (
    <section className="dk-stack" aria-labelledby="h-quiz" data-testid="quiz-editor">
      <h2 id="h-quiz">Quiz</h2>
      <span className="dk-asof">{view ? `Read ${formatAsOf(view.asOf)}` : 'No read yet'}</span>
      <Outcome reply={reply} />
      {!part && <p className="dk-why">The console could not reach its own server for this quiz. Nothing is shown rather than a guess.</p>}
      {part?.kind === 'failed' && <Failed title="Could not read this quiz" message={part.message} code={part.code} />}
      {quiz && (
        <>
          <Facts quiz={quiz} />
          <QuizForm key={quiz.revision} quiz={quiz} busy={busy} onSave={(fields) => void send({ op: 'save', ...fields })} />
          {view?.reviews?.kind === 'ok' && (quiz.kind === 'quiz' || view.reviews.data.length > 0) && (
            <EssayReviews
              reviews={view.reviews.data}
              busy={busy}
              onScore={(attemptId, points) => void send({ op: 'scoreEssays', attemptId, points })}
            />
          )}
          {view?.reviews?.kind === 'failed' && (
            <Failed title="Could not read the essays waiting for a score" message={view.reviews.message} code={view.reviews.code} />
          )}
          <div className="dk-stack" data-testid="quiz-publish">
            {quiz.blockers.length > 0 ? (
              <ul className="dk-stack" data-testid="quiz-blockers" aria-label="What stops Publish">
                {quiz.blockers.map((b) => (
                  <li key={b} data-blocker={b}>
                    {BLOCKER_WORDS[b]}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="dk-muted">Nothing stops Publish.</p>
            )}
            <form
              className="dk-row"
              onSubmit={(e) => {
                e.preventDefault();
                void send({ op: 'setState', state: quiz.state === 'published' ? 'draft' : 'published', reason });
              }}
            >
              <div className="adm-field">
                <label htmlFor="quiz-state-reason">Reason</label>
                <input id="quiz-state-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
              </div>
              <button type="submit" className="adm-btn" disabled={busy || quiz.revision === 0}>
                {quiz.state === 'published' ? 'Take back to draft' : 'Publish quiz'}
              </button>
            </form>
          </div>
        </>
      )}
    </section>
  );
}
