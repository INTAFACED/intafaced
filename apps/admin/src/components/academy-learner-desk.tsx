'use client';

import { useCallback, useState, type ReactNode } from 'react';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchLearner, postLearnerChange } from '@/lib/academy/learners-browser';
import type { AcademyLearnerPage, AcademyLearnerProgress, LearnerDeskReply, LearnerView } from '@/lib/academy/learners-model';
import { Failed, Outcome } from '@/components/academy-courses-desk';

/**
 * THE LEARNER PAGE (J-academy-14): helping a learner who is stuck.
 *
 * Identity's profile and sign-in statistics; svc-academy's access records with their events, enrolments, internal notes
 * (never shown to the learner), tags, every item's progress with its history and quiz attempts, due dates with the
 * learner's own moved date, and the audit of every staff change with who and why. Every change asks for a reason and
 * svc-academy refuses one without it. A session that may only read sees the same page with no change control, and
 * svc-academy refuses a direct change from it. The page shows every refusal and reads again, never retrying on its own.
 */

type Item = AcademyLearnerProgress['courses'][number]['items'][number];
type Grant = AcademyLearnerPage['access'][number];
type Send = (body: Record<string, unknown>) => Promise<void>;

const PATH: Record<string, string> = { foundations: 'Foundations', markets: 'Markets', builder: 'Builder', sovereign: 'Sovereign' };
const STATUS: Record<Item['status'], string> = { completed: 'Completed', not_started: 'Not started', undone: 'Undone' };
const GRANT_STATE: Record<Grant['state'], string> = { granted: 'Granted', expired: 'Ended', revoked: 'Revoked' };

/** An instant typed in the operator's own time, as an ISO string; an unreadable one is sent as typed so svc-academy names it. */
const instant = (local: string) => {
  const at = new Date(local);
  return Number.isNaN(at.getTime()) ? local : at.toISOString();
};

function ReasonForm({
  label,
  button,
  busy,
  onSubmit,
  children,
}: {
  label: string;
  button: string;
  busy: boolean;
  onSubmit: (reason: string) => void;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  return (
    <form
      className="dk-row"
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(reason);
      }}
    >
      {children}
      <label>
        Reason
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} aria-label={`Reason: ${label}`} />
      </label>
      <button type="submit" className="adm-btn" disabled={busy}>
        {button}
      </button>
    </form>
  );
}

function Profile({ view }: { view: LearnerView }) {
  const part = view.card;
  if (part.kind === 'failed') return <Failed title="Could not read the profile" message={part.message} code={part.code} />;
  const card = part.data;
  if (!card) return <p className="dk-muted">Identity has no account with this id.</p>;
  return (
    <dl className="dk-stack" data-testid="learner-profile">
      <div>
        <dt>Handle</dt>
        <dd data-testid="learner-handle">{card.handle}</dd>
      </div>
      <div>
        <dt>Email</dt>
        <dd>{card.emailMasked}</dd>
      </div>
      <div>
        <dt>Account</dt>
        <dd>
          {card.status} · signed up {formatWhen(card.created)} · id {card.id}
        </dd>
      </div>
      <div data-testid="learner-login-stats">
        <dt>Sign-ins</dt>
        <dd>
          {card.signIns.total} in all, {card.signIns.last30Days} in the last 30 days
          {card.signIns.lastAt ? `, last ${formatWhen(card.signIns.lastAt)}` : ', none yet'}
        </dd>
      </div>
    </dl>
  );
}

function Access({ page, busy, send }: { page: AcademyLearnerPage; busy: boolean; send: Send }) {
  const [path, setPath] = useState('foundations');
  const [ends, setEnds] = useState('');
  return (
    <section className="dk-stack" aria-labelledby="h-learner-access" data-testid="learner-access">
      <h3 id="h-learner-access">Access</h3>
      {page.access.length === 0 ? (
        <p className="dk-muted">No access record: the learner is enrolled in no course and holds no grant.</p>
      ) : (
        <ul className="dk-stack">
          {page.access.map((g) => (
            <li key={g.id ?? `free-${g.pathSlug}`} className="dk-stack" data-grant={g.pathSlug} data-grant-state={g.state}>
              <strong>
                {PATH[g.pathSlug]}: {GRANT_STATE[g.state]}
              </strong>
              <span className="dk-muted">
                {g.source === 'free' ? 'Free enrolment' : `Source ${g.source}`} · from {formatWhen(g.startsAt)} ·{' '}
                {g.expiresAt ? `${g.state === 'granted' ? 'ends' : 'ended'} ${formatWhen(g.expiresAt)}` : 'no end'}
                {g.reason ? ` · ${g.reason}` : ''}
              </span>
              {g.events.length > 0 && (
                <ol className="dk-stack" aria-label={`Events of ${PATH[g.pathSlug]} access`} data-testid="grant-events">
                  {g.events.map((e) => (
                    <li key={e.n} data-grant-event={e.kind}>
                      {e.n}. {e.kind} {formatWhen(e.at)}
                      {e.actorId ? ` by ${e.actorId}` : ' (end date reached)'}
                      {e.reason ? `: ${e.reason}` : ''}
                    </li>
                  ))}
                </ol>
              )}
              {page.canChange && g.id && g.state !== 'granted' && (
                <ReasonForm
                  label={`Reinstate ${PATH[g.pathSlug]} access`}
                  button="Reinstate access"
                  busy={busy}
                  onSubmit={(reason) => void send({ op: 'reinstate', grantId: g.id, reason, expiresAt: null, n: g.events.length + 1 })}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {page.canChange && (
        <ReasonForm
          label="Grant access"
          button="Grant access"
          busy={busy}
          onSubmit={(reason) => void send({ op: 'grantAccess', pathSlug: path, reason, expiresAt: ends ? instant(ends) : null })}
        >
          <label>
            Course
            <select value={path} onChange={(e) => setPath(e.target.value)} aria-label="Access course">
              {Object.entries(PATH).map(([slug, title]) => (
                <option key={slug} value={slug}>
                  {title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Ends (your time, optional)
            <input type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} aria-label="Access ends" />
          </label>
        </ReasonForm>
      )}
    </section>
  );
}

function Notes({ page, busy, send }: { page: AcademyLearnerPage; busy: boolean; send: Send }) {
  const [body, setBody] = useState('');
  return (
    <section className="dk-stack" aria-labelledby="h-learner-notes" data-testid="learner-notes">
      <h3 id="h-learner-notes">Internal notes</h3>
      <p className="dk-muted">Staff only: the learner never sees these.</p>
      {page.notes.length === 0 ? (
        <p className="dk-muted">No internal note yet.</p>
      ) : (
        <ol className="dk-stack">
          {page.notes.map((n) => (
            <li key={n.n} data-note={n.n}>
              <span>{n.body}</span>{' '}
              <span className="dk-muted">
                · {formatWhen(n.at)} by {n.authorId}
              </span>
            </li>
          ))}
        </ol>
      )}
      {page.canChange && (
        <form
          className="dk-row"
          aria-label="Add an internal note"
          onSubmit={(e) => {
            e.preventDefault();
            void send({ op: 'addNote', body, key: `note:${page.userId}:${page.notes.length + 1}` });
          }}
        >
          <label>
            Note
            <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} aria-label="Internal note" />
          </label>
          <button type="submit" className="adm-btn" disabled={busy}>
            Save note
          </button>
        </form>
      )}
    </section>
  );
}

function Tags({ page, busy, send }: { page: AcademyLearnerPage; busy: boolean; send: Send }) {
  const [tag, setTag] = useState('');
  return (
    <section className="dk-stack" aria-labelledby="h-learner-tags" data-testid="learner-tags">
      <h3 id="h-learner-tags">Tags</h3>
      {page.tags.length === 0 ? (
        <p className="dk-muted">No tag.</p>
      ) : (
        <ul className="dk-stack">
          {page.tags.map((t) => (
            <li key={t.tag} data-tag={t.tag}>
              <a href={`/academy-ops/programmes/learners?tag=${encodeURIComponent(t.tag)}`}>{t.tag}</a>{' '}
              <span className="dk-muted">
                · added {formatWhen(t.addedAt)} by {t.addedBy}
              </span>
              {page.canChange && (
                <ReasonForm
                  label={`Remove tag ${t.tag}`}
                  button="Remove tag"
                  busy={busy}
                  onSubmit={(reason) => void send({ op: 'untag', tag: t.tag, reason })}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {page.canChange && (
        <ReasonForm label="Add a tag" button="Add tag" busy={busy} onSubmit={(reason) => void send({ op: 'tag', tag, reason })}>
          <label>
            Tag
            <input value={tag} onChange={(e) => setTag(e.target.value.trim().toLowerCase())} maxLength={40} aria-label="Tag" />
          </label>
        </ReasonForm>
      )}
    </section>
  );
}

function ItemRow({ userId, item, canChange, busy, send }: { userId: string; item: Item; canChange: boolean; busy: boolean; send: Send }) {
  const [until, setUntil] = useState('');
  return (
    <li className="dk-stack" data-item={item.slug} data-item-status={item.status}>
      <strong>
        {item.title} <span className="dk-muted">({item.kind})</span>: <span data-testid="item-status">{STATUS[item.status]}</span>
      </strong>
      {item.completedAt && <span className="dk-muted">Completed {formatWhen(item.completedAt)}</span>}
      {item.history.length > 0 && (
        <ol className="dk-row" aria-label={`History of ${item.title}`} data-testid="item-history">
          {item.history.map((h, i) => (
            <li key={i} data-history={h.event}>
              {h.event === 'undone' ? 'Undone' : 'Completed'} {formatWhen(h.at)}
            </li>
          ))}
        </ol>
      )}
      <span data-testid="item-due">
        {item.dueAt ? `Due for everyone ${formatWhen(item.dueAt)}` : 'No due date set'}
        {item.extension &&
          ` · due for this learner ${formatWhen(item.extension.until)}, moved by ${item.extension.grantedBy} on ${formatWhen(item.extension.grantedAt)}: ${item.extension.reason}`}
      </span>
      {item.quiz && (
        <div className="dk-stack" data-testid="item-quiz">
          <span className="dk-muted" data-testid="quiz-counted">
            {item.quiz.attemptLimit === null
              ? `${item.quiz.counted} attempts count; no attempt limit`
              : `${item.quiz.counted} of ${item.quiz.attemptLimit} attempts used`}
          </span>
          {item.quiz.attempts.length === 0 ? (
            <span className="dk-muted">No attempt yet.</span>
          ) : (
            <ol className="dk-stack" aria-label={`Attempts on ${item.title}`}>
              {item.quiz.attempts.map((a) => (
                <li key={a.attemptId} data-attempt={a.attemptId} data-attempt-state={a.voided ? 'voided' : 'counted'}>
                  {a.score} of {a.maxScore}, {a.passed ? 'passed' : 'not passed'}, {formatWhen(a.submittedAt)}
                  {a.voided && ` · Voided ${formatWhen(a.voided.at)} by ${a.voided.by}: ${a.voided.reason}`}
                  {canChange && !a.voided && (
                    <ReasonForm
                      label={`Reset quiz attempt ${a.attemptId}`}
                      button="Reset this attempt"
                      busy={busy}
                      onSubmit={(reason) => void send({ op: 'voidAttempt', attemptId: a.attemptId, reason })}
                    />
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {canChange && item.status !== 'completed' && (
        <ReasonForm
          label={`Mark ${item.title} complete`}
          button="Mark complete"
          busy={busy}
          onSubmit={(reason) =>
            void send({
              op: 'markComplete',
              itemSlug: item.slug,
              reason,
              key: `override:${userId}:${item.slug}:${item.history.length + 1}`,
            })
          }
        />
      )}
      {canChange && item.dueAt && (
        <ReasonForm
          label={`Extend ${item.title} for this learner`}
          button="Grant extension"
          busy={busy}
          onSubmit={(reason) =>
            void send({
              op: 'extension',
              itemSlug: item.slug,
              until: instant(until),
              reason,
              key: `extend:${item.slug}:${userId}:${(item.extension?.revision ?? 0) + 1}`,
            })
          }
        >
          <label>
            New due date (your time)
            <input
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              aria-label={`New due date: ${item.title}`}
            />
          </label>
        </ReasonForm>
      )}
    </li>
  );
}

function Progress({ view, busy, send }: { view: LearnerView; busy: boolean; send: Send }) {
  const part = view.progress;
  return (
    <section className="dk-stack" aria-labelledby="h-learner-progress" data-testid="learner-progress">
      <h3 id="h-learner-progress">Progress</h3>
      {part.kind === 'failed' ? (
        <Failed title="Could not read progress" message={part.message} code={part.code} />
      ) : part.data.courses.length === 0 ? (
        <p className="dk-muted">The learner has no course yet, so there is no progress to show.</p>
      ) : (
        part.data.courses.map((course) => (
          <div key={course.pathSlug} className="dk-stack" data-course={course.pathSlug}>
            <h4>{PATH[course.pathSlug]}</h4>
            <ol className="dk-stack">
              {course.items.map((item) => (
                <ItemRow
                  key={`${item.slug}-${view.asOf}`}
                  userId={view.userId}
                  item={item}
                  canChange={part.data.canChange}
                  busy={busy}
                  send={send}
                />
              ))}
            </ol>
          </div>
        ))
      )}
    </section>
  );
}

export function AcademyLearnerDesk({ userId, initial }: { userId: string; initial: LearnerView | null }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<LearnerDeskReply | null>(null);

  const reload = useCallback(async () => {
    const next = await fetchLearner(userId);
    if (next) setView(next);
  }, [userId]);

  const send: Send = async (body) => {
    setBusy(true);
    setReply(await postLearnerChange({ userId, ...body }));
    setBusy(false);
    // Whatever the answer, the page shows the learner as the services hold them now.
    await reload();
  };

  const page = view?.page;
  return (
    <section className="dk-stack" aria-labelledby="h-learner" data-testid="learner-desk">
      <h2 id="h-learner">Learner</h2>
      <p>
        <a href="/academy-ops/programmes/learners">All learners</a>
      </p>
      <span className="dk-asof">{view ? `Read ${formatAsOf(view.asOf)}` : 'No read yet'}</span>
      <Outcome reply={reply} />
      {!view && (
        <p className="dk-why">The console could not reach its own server for this learner. Nothing is shown rather than a guess.</p>
      )}
      {view && <Profile view={view} />}
      {page?.kind === 'failed' && <Failed title="Could not read the learner" message={page.message} code={page.code} />}
      {view && page?.kind === 'ok' && (
        <>
          {!page.data.canChange && (
            <p className="adm-callout" data-tone="neutral" data-testid="learner-read-only">
              Read only: your role can read this learner but not change anything.
            </p>
          )}
          <Access page={page.data} busy={busy} send={send} />
          <section className="dk-stack" aria-labelledby="h-learner-enrolments" data-testid="learner-enrolments">
            <h3 id="h-learner-enrolments">Enrolments</h3>
            {page.data.enrolments.length === 0 ? (
              <p className="dk-muted">Not enrolled in any course.</p>
            ) : (
              <ul className="dk-stack">
                {page.data.enrolments.map((e) => (
                  <li key={`${e.pathSlug}-${e.enrolledAt}`} data-enrolment={e.pathSlug}>
                    {PATH[e.pathSlug]}: enrolled {formatWhen(e.enrolledAt)}
                    {e.leftAt ? `, left ${formatWhen(e.leftAt)}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <Notes key={`notes-${view.asOf}`} page={page.data} busy={busy} send={send} />
          <Tags key={`tags-${view.asOf}`} page={page.data} busy={busy} send={send} />
          <Progress view={view} busy={busy} send={send} />
          <section className="dk-stack" aria-labelledby="h-learner-audit" data-testid="learner-audit">
            <h3 id="h-learner-audit">Audit</h3>
            {page.data.audit.length === 0 ? (
              <p className="dk-muted">No staff change yet.</p>
            ) : (
              <ol className="dk-stack">
                {page.data.audit.map((a, i) => (
                  <li key={i} data-audit={a.kind}>
                    {formatWhen(a.at)} · {a.detail}
                    {a.actorId ? ` · by ${a.actorId}` : ''}
                    {a.reason ? ` · ${a.reason}` : ''}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </section>
  );
}
