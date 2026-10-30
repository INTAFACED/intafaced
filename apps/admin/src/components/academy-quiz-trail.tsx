'use client';

import { useCallback, useState } from 'react';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchQuizTrail, postQuizTrailChange } from '@/lib/academy/quiz-trail-browser';
import type {
  AcademyAdminCourseQuiz,
  AcademyCourseQuizAttempts,
  AcademyCourseQuizQuestion,
  QuizTrailReply,
  QuizTrailView,
} from '@/lib/academy/quiz-trail-model';
import { Failed, Outcome } from '@/components/academy-courses-desk';

/**
 * QUIZ SCORE CHANGES (AC-quizzes-04).
 *
 * Every finished attempt under its alias ("Learner 2"), never a name, with the points each question earned, the score as
 * finished and as it stands. A change is never an edit: an override sets one question's points with a reason and keeps
 * the old total in the trail; a key fix is a new revision of the quiz that changes only keys; a rescore applies the
 * current keys to each graded attempt they change. Every answer re-reads the page, and nothing is retried on its own.
 */

type Attempt = AcademyCourseQuizAttempts['attempts'][number];
type Keyed = Exclude<AcademyCourseQuizQuestion, { kind: 'essay' }>;
const keyed = (q: AcademyCourseQuizQuestion): q is Keyed => q.kind !== 'essay';

function KeyFix({ quiz, busy, onSave }: { quiz: AcademyAdminCourseQuiz; busy: boolean; onSave: (body: Record<string, unknown>) => void }) {
  const questions = quiz.questions.filter(keyed);
  const [id, setId] = useState(questions[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const question = questions.find((q) => q.id === id) ?? null;
  const [draft, setDraft] = useState<Keyed | null>(question);
  const pick = (next: string) => {
    setId(next);
    setDraft(questions.find((q) => q.id === next) ?? null);
  };
  if (quiz.kind !== 'quiz' || questions.length === 0)
    return <p className="dk-muted">This quiz has no question with a key, so there is no key to fix.</p>;
  return (
    <form
      className="dk-stack"
      data-testid="key-fix"
      onSubmit={(e) => {
        e.preventDefault();
        if (!draft) return;
        onSave({
          op: 'fixKey',
          revision: quiz.revision,
          questions: quiz.questions.map((q) => (q.id === draft.id ? draft : q)),
          reason: reason.trim(),
        });
      }}
    >
      <h2>Fix a key</h2>
      <p className="dk-muted">
        A key fix is revision {quiz.revision + 1} of this quiz. It changes only the key; every attempt keeps its score until you rescore.
      </p>
      <div className="adm-field">
        <label htmlFor="key-question">Question</label>
        <select id="key-question" value={id} onChange={(e) => pick(e.target.value)}>
          {questions.map((q, i) => (
            <option key={q.id} value={q.id}>
              {i + 1}. {q.prompt}
            </option>
          ))}
        </select>
      </div>
      {draft?.kind === 'single' && (
        <div className="adm-field">
          <label htmlFor="key-single">Correct choice</label>
          <select
            id="key-single"
            value={draft.correctChoiceId ?? ''}
            onChange={(e) => setDraft({ ...draft, correctChoiceId: e.target.value || null })}
          >
            {draft.choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.text}
              </option>
            ))}
          </select>
        </div>
      )}
      {draft?.kind === 'multi' && (
        <fieldset className="dk-stack">
          <legend>Correct choices</legend>
          {draft.choices.map((c) => {
            const on = draft.correctChoiceIds?.includes(c.id) ?? false;
            return (
              <label key={c.id}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    const next = on ? (draft.correctChoiceIds ?? []).filter((x) => x !== c.id) : [...(draft.correctChoiceIds ?? []), c.id];
                    setDraft({ ...draft, correctChoiceIds: next.length ? next : null });
                  }}
                />{' '}
                {c.text}
              </label>
            );
          })}
        </fieldset>
      )}
      {draft?.kind === 'numeric' && (
        <div className="dk-row">
          <div className="adm-field">
            <label htmlFor="key-answer">Answer</label>
            <input
              id="key-answer"
              inputMode="decimal"
              value={draft.answer ?? ''}
              onChange={(e) => setDraft({ ...draft, answer: e.target.value.trim() || null })}
            />
          </div>
          <div className="adm-field">
            <label htmlFor="key-tolerance">Tolerance</label>
            <input
              id="key-tolerance"
              inputMode="decimal"
              value={draft.tolerance}
              onChange={(e) => setDraft({ ...draft, tolerance: e.target.value.trim() })}
            />
          </div>
        </div>
      )}
      <div className="adm-field">
        <label htmlFor="key-reason">Reason for the key fix</label>
        <input id="key-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <button type="submit" className="adm-btn" disabled={busy}>
        Save key fix
      </button>
    </form>
  );
}

function Override({ attempt, busy, onSave }: { attempt: Attempt; busy: boolean; onSave: (body: Record<string, unknown>) => void }) {
  const [questionId, setQuestionId] = useState(attempt.questions[0]?.questionId ?? '');
  const [points, setPoints] = useState('');
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState('');
  const max = attempt.questions.find((q) => q.questionId === questionId)?.points ?? 0;
  return (
    <form
      className="dk-stack"
      data-testid="score-override"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          op: 'override',
          attemptId: attempt.attemptId,
          questionId,
          points: /^\d+$/.test(points.trim()) ? Number(points.trim()) : -1,
          n: attempt.nextN,
          comment: comment.trim() || null,
          reason: reason.trim(),
        });
      }}
    >
      <h3>
        Change a score: Learner {attempt.alias}, attempt {attempt.number}
      </h3>
      <div className="adm-field">
        <label htmlFor="override-question">Question</label>
        <select id="override-question" value={questionId} onChange={(e) => setQuestionId(e.target.value)}>
          {attempt.questions.map((q, i) => (
            <option key={q.questionId} value={q.questionId}>
              {i + 1}. {q.prompt}
            </option>
          ))}
        </select>
      </div>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="override-points">Points</label>
          <input id="override-points" inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value)} />
        </div>
        <span className="dk-muted">of {max}</span>
      </div>
      <div className="adm-field">
        <label htmlFor="override-comment">Comment</label>
        <textarea id="override-comment" rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
      </div>
      <div className="adm-field">
        <label htmlFor="override-reason">Reason for the change</label>
        <input id="override-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <button type="submit" className="adm-btn" disabled={busy}>
        Save score change
      </button>
    </form>
  );
}

function AttemptRow({ attempt, busy, onChange }: { attempt: Attempt; busy: boolean; onChange: () => void }) {
  const changed = attempt.events.length > 0;
  return (
    <li className="dk-stack" data-attempt={attempt.attemptId} data-alias={attempt.alias}>
      <strong>
        Learner {attempt.alias} · attempt {attempt.number}
      </strong>
      <span className="dk-muted">Finished {formatWhen(attempt.finishedAt)}</span>
      <p data-testid="attempt-score">
        {attempt.score === null
          ? 'Waiting for an essay score'
          : `Score ${attempt.score} of ${attempt.maxScore}, ${attempt.passed ? 'passed' : 'not passed'}`}
        {changed && attempt.originalScore !== null && ` · ${attempt.originalScore} as finished`}
      </p>
      <ul className="dk-stack">
        {attempt.questions.map((q, i) => (
          <li key={q.questionId} data-question={q.questionId}>
            {i + 1}. {q.prompt}: {q.earned === null ? 'waiting for a score' : `${q.earned} of ${q.points}`}
          </li>
        ))}
      </ul>
      {changed && (
        <ol className="dk-stack" data-testid="score-trail">
          {attempt.events.map((e) => (
            <li key={e.n} data-event={e.n} data-kind={e.kind}>
              {e.kind === 'override'
                ? `Change ${e.n}: question ${e.questionId} overridden`
                : `Change ${e.n}: rescored on revision ${e.revision}`}
              , {e.previousScore} → {e.score} on {formatWhen(e.at)} · {e.reason}
              {e.comment && ` · ${e.comment}`}
            </li>
          ))}
        </ol>
      )}
      <button type="button" className="adm-btn" disabled={busy || attempt.state !== 'graded'} onClick={onChange}>
        Change a score
      </button>
    </li>
  );
}

export function AcademyQuizTrail({ itemId, initial }: { itemId: string; initial: QuizTrailView | null }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<QuizTrailReply | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const reload = useCallback(async () => {
    const next = await fetchQuizTrail(itemId);
    if (next) setView(next);
  }, [itemId]);

  const send = async (body: Record<string, unknown>): Promise<QuizTrailReply> => {
    setBusy(true);
    const answer = await postQuizTrailChange({ itemId, ...body });
    setReply(answer);
    setBusy(false);
    // Whatever the answer, the page shows the quiz and its attempts as svc-academy holds them now.
    if (answer.ok) setView(answer.view);
    else await reload();
    return answer;
  };

  const quiz = view?.quiz.kind === 'ok' ? view.quiz.data : null;
  const attempts = view?.attempts.kind === 'ok' ? view.attempts.data : null;
  const selected = attempts?.attempts.find((a) => a.attemptId === open) ?? null;
  return (
    <section className="dk-stack" aria-labelledby="h-quiz-trail" data-testid="quiz-trail">
      <h1 id="h-quiz-trail">{quiz ? `Score changes: ${quiz.title}` : 'Quiz score changes'}</h1>
      <span className="dk-asof">{view ? `Read ${formatAsOf(view.asOf)}` : 'No read yet'}</span>
      <Outcome reply={reply && (reply.ok ? { ok: true, what: reply.what } : reply)} />
      {!view && <p className="dk-why">The console could not reach its own server for this quiz. Nothing is shown rather than a guess.</p>}
      {view?.quiz.kind === 'failed' && <Failed title="Could not read the quiz" message={view.quiz.message} code={view.quiz.code} />}
      {view?.attempts.kind === 'failed' && (
        <Failed title="Could not read the attempts" message={view.attempts.message} code={view.attempts.code} />
      )}
      {quiz && (
        <dl className="dk-kv">
          <dt>Revision</dt>
          <dd data-testid="quiz-revision">{quiz.revision}</dd>
          <dt>Pass mark</dt>
          <dd>{quiz.passMark ?? 'Not set'}</dd>
          <dt>Learners</dt>
          <dd>Shown by alias, in the order they first started. Names stay hidden.</dd>
        </dl>
      )}
      {quiz && <KeyFix key={quiz.revision} quiz={quiz} busy={busy} onSave={(body) => void send(body)} />}
      {quiz && quiz.kind === 'quiz' && (
        <form
          className="dk-stack"
          data-testid="rescore"
          onSubmit={(e) => {
            e.preventDefault();
            void send({ op: 'rescore', reason: reason.trim() });
          }}
        >
          <h2>Rescore</h2>
          <p className="dk-muted">
            Applies revision {quiz.revision}’s keys to every graded attempt whose answers they change, once per attempt. Each change is a
            new event; the old score stays in the trail.
          </p>
          <div className="adm-field">
            <label htmlFor="rescore-reason">Reason for the rescore</label>
            <input id="rescore-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <button type="submit" className="adm-btn" disabled={busy}>
            Rescore attempts
          </button>
          {reply?.ok && reply.rescored && reply.rescored.length > 0 && (
            <ul className="dk-stack" data-testid="rescored">
              {reply.rescored.map((r) => (
                <li key={`${r.alias}:${r.number}`}>
                  Learner {r.alias}, attempt {r.number}: {r.from} → {r.to}
                </li>
              ))}
            </ul>
          )}
        </form>
      )}
      {attempts && (
        <>
          <h2>Attempts</h2>
          {attempts.attempts.length === 0 ? (
            <p className="dk-muted">Nobody has finished this quiz, so there is no score to change.</p>
          ) : (
            <ol className="dk-stack" data-testid="quiz-attempts">
              {attempts.attempts.map((a) => (
                <AttemptRow key={a.attemptId} attempt={a} busy={busy} onChange={() => setOpen(a.attemptId)} />
              ))}
            </ol>
          )}
          {selected && (
            <Override
              key={`${selected.attemptId}:${selected.nextN}`}
              attempt={selected}
              busy={busy}
              onSave={(body) => void send(body).then((answer) => answer.ok && setOpen(null))}
            />
          )}
        </>
      )}
    </section>
  );
}
