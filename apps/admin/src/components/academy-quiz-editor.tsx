'use client';

import { useCallback, useState } from 'react';
import {
  ACADEMY_QUIZ_SCORING_POLICIES,
  type AcademyCourseQuizBlocker,
  type AcademyCourseQuizQuestion,
  type AcademyQuizScoringPolicy,
} from '@intafaced/contracts/academy-course-quizzes';
import { Chip } from '@/components/chip';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchQuiz, postQuizChange } from '@/lib/academy/quizzes-browser';
import type { AcademyAdminCourseQuiz, QuizDeskReply, QuizView } from '@/lib/academy/quizzes-model';
import { Failed, Outcome } from '@/components/academy-courses-desk';

/**
 * QUIZ EDITOR (AC-quizzes-01).
 *
 * A quiz item's questions and attempt rules, saved as a draft over the revision read, then published. The publish
 * button lists what stops it (no questions, no pass mark, more than one attempt with no scoring policy) and svc-academy
 * refuses the same by name. Once a learner has an attempt the questions stay and the quiz stays published; its rules
 * still change. The access code is never shown back: the editor says whether one is set. This section shows every
 * refusal and reads again, never retrying on its own.
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

/** `answer` is the chosen choice's text, so editing or reordering the lines never moves the key to another choice. */
type DraftQuestion = { id: string; prompt: string; points: string; choices: string; answer: string };

const draftOf = (q: AcademyCourseQuizQuestion): DraftQuestion => ({
  id: q.id,
  prompt: q.prompt,
  points: String(q.points),
  choices: q.choices.map((c) => c.text).join('\n'),
  answer: q.choices.find((c) => c.id === q.correctChoiceId)?.text ?? '',
});

/** The question as svc-academy takes it: choices one per line, ids by position. */
const questionOf = (q: DraftQuestion): AcademyCourseQuizQuestion => {
  const lines = q.choices
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    id: q.id,
    prompt: q.prompt.trim(),
    points: Number(q.points),
    choices: lines.map((text, i) => ({ id: `c${i + 1}`, text })),
    // A key whose text is no longer a choice names none, and svc-academy's check refuses the save.
    correctChoiceId: `c${lines.indexOf(q.answer.trim()) + 1}`,
  };
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
      <dt>Attempts by learners</dt>
      <dd>{quiz.attempts}</dd>
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
  const locked = quiz.attempts > 0;
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
          passMark: wholeOrNull(passMark),
          attemptLimit: wholeOrNull(attemptLimit),
          scoringPolicy: policy === '' ? null : policy,
          timeLimitSeconds: wholeOrNull(timeLimit),
          reviewMode,
          ipAllow: ipLines.length === 0 ? null : ipLines,
          ...(clearCode ? { accessCode: null } : code.trim() ? { accessCode: code.trim() } : {}),
          questions: questions.map(questionOf),
        });
      }}
    >
      <h3>Questions</h3>
      {locked && <p className="dk-why">Learners have attempts on this quiz, so its questions stay as they are. Its rules still change.</p>}
      {questions.length === 0 && <p className="dk-muted">No questions yet. A quiz with no questions is not published.</p>}
      <ol className="dk-stack" data-testid="quiz-questions">
        {questions.map((q, i) => {
          const lines = q.choices
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
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
                  <label htmlFor={`quiz-q${i}-points`}>{`Question ${i + 1} points`}</label>
                  <input
                    id={`quiz-q${i}-points`}
                    inputMode="numeric"
                    value={q.points}
                    disabled={locked}
                    onChange={(e) => set(i, { points: e.target.value })}
                  />
                </div>
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
        <button
          type="button"
          className="adm-btn"
          disabled={locked}
          onClick={() => setQuestions((qs) => [...qs, { id: freshId(), prompt: '', points: '1', choices: '', answer: '' }])}
        >
          Add question
        </button>
      </p>

      <h3>Attempt rules</h3>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="quiz-pass-mark">Pass mark (points)</label>
          <input id="quiz-pass-mark" inputMode="numeric" value={passMark} onChange={(e) => setPassMark(e.target.value)} />
        </div>
        <div className="adm-field">
          <label htmlFor="quiz-attempts">Attempts allowed</label>
          <input id="quiz-attempts" inputMode="numeric" value={attemptLimit} onChange={(e) => setAttemptLimit(e.target.value)} />
        </div>
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
      <button type="submit" className="adm-btn" disabled={busy}>
        Save quiz draft
      </button>
    </form>
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
