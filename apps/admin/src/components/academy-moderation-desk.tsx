'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchModeration, postTeamChange } from '@/lib/academy/team-browser';
import type { ModerationView, TeamDeskReply } from '@/lib/academy/team-model';
import { AcademyNav, Failed, Outcome } from '@/components/academy-courses-desk';

/** A time the desk read: an ISO string on the wire (the contract types it as a Date once parsed). */
const when = (d: Date | string) => formatWhen(typeof d === 'string' ? d : d.toISOString());

const ACTION_WORDS = { delete: 'Deleted a post', bulk_delete: "Deleted an author's posts in the course" } as const;

/**
 * MODERATION DESK (AC-rooms-02, J-academy-18).
 *
 * The discussion posts learners reported that still show, oldest report first, with how many reported each and why (who
 * reported is not shown). A moderator deletes a post with a reason, or every post of its author in this course; the post
 * leaves the thread, the action is listed below with who and why, and the author is told in their notification tray. A
 * session that may only read sees the same queue with no delete; svc-academy refuses a change from it either way.
 * Reporting does not promise a takedown.
 */
export function AcademyModerationDesk({ initial }: { initial: ModerationView | null }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<TeamDeskReply | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const courseId = view?.courseId ?? null;

  const reload = useCallback(async () => {
    const next = await fetchModeration(courseId);
    if (next) setView(next);
  }, [courseId]);

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    const answer = await postTeamChange('/api/academy-moderation', body);
    setReply(answer);
    setBusy(false);
    // Whatever the answer, the desk shows what svc-academy holds now.
    await reload();
  };

  const queue = view?.queue;
  const courses = view?.courses.kind === 'ok' ? view.courses.data.courses : [];
  const courseTitle = (id: string) => courses.find((c) => c.id === id)?.title ?? id;
  const reasonOf = (key: string) => reasons[key] ?? '';
  const setReason = (key: string, value: string) => setReasons((r) => ({ ...r, [key]: value }));
  return (
    <div className="dk" data-testid="academy-moderation">
      <div className="adm-pagehead">
        <div>
          <h1>Academy: moderation</h1>
          <p>
            <Link href="/academy-ops/catalogue">Back to the catalogue</Link>
          </p>
        </div>
      </div>
      <AcademyNav />
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="moderation-course">Course</label>
          <select
            id="moderation-course"
            value={courseId ?? ''}
            onChange={(e) => router.push(`/academy-ops/catalogue/moderation${e.target.value ? `?courseId=${e.target.value}` : ''}`)}
          >
            <option value="">All courses</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="adm-btn" onClick={() => void reload()}>
          Refresh
        </button>
        <span className="dk-asof">{view ? `Read ${formatAsOf(view.asOf)}` : 'No read yet'}</span>
      </div>
      <Outcome reply={reply} />
      {!view && <p className="dk-why">The console could not reach its own server for this desk. Nothing is shown rather than a guess.</p>}
      {queue?.kind === 'failed' && <Failed title="Could not read the moderation queue" message={queue.message} code={queue.code} />}
      {queue?.kind === 'ok' && (
        <>
          {!queue.data.mayWrite && (
            <p className="adm-callout" data-tone="info" data-testid="moderation-read-only">
              Read only: your role can read the queue but not delete anything.
            </p>
          )}
          <section className="dk-stack" aria-labelledby="h-moderation-reports">
            <h2 id="h-moderation-reports">Reported posts</h2>
            <p className="dk-muted">
              Reporting a post does not promise it is taken down. Who reported a post is never shown to its author.
            </p>
            {queue.data.reports.length === 0 ? (
              <p className="dk-muted" data-testid="moderation-empty">
                No reports.
              </p>
            ) : (
              <ul className="dk-stack" data-testid="moderation-reports">
                {queue.data.reports.map((r) => (
                  <li key={r.postId} className="dk-stack" data-report={r.postId} data-author={r.authorId}>
                    <p>
                      <strong>{r.isReply ? 'A reply' : r.title}</strong> in {r.courseTitle}, posted {when(r.postedAt)} by{' '}
                      <code>{r.authorId}</code>
                      {r.anonymous ? ' (anonymous to classmates)' : ''}
                    </p>
                    <blockquote>{r.body}</blockquote>
                    <p data-testid="report-count">
                      Reported {r.reports === 1 ? 'once' : `${r.reports} times`}, first {when(r.firstReportedAt)}. Why:{' '}
                      {r.reasons.join('; ')}
                    </p>
                    {queue.data.mayWrite && r.mayModerate && (
                      <div className="dk-row">
                        <div className="adm-field">
                          <label htmlFor={`why-${r.postId}`}>Why delete it</label>
                          <input
                            id={`why-${r.postId}`}
                            value={reasonOf(r.postId)}
                            maxLength={500}
                            onChange={(e) => setReason(r.postId, e.target.value)}
                          />
                        </div>
                        <button
                          type="button"
                          className="adm-btn"
                          disabled={busy}
                          onClick={() => void send({ op: 'deletePost', postId: r.postId, reason: reasonOf(r.postId) })}
                        >
                          Delete post
                        </button>
                        <button
                          type="button"
                          className="adm-btn"
                          disabled={busy}
                          onClick={() =>
                            void send({ op: 'bulkDelete', courseId: r.courseId, authorId: r.authorId, reason: reasonOf(r.postId) })
                          }
                        >
                          Delete all their posts in this course
                        </button>
                      </div>
                    )}
                    {queue.data.mayWrite && !r.mayModerate && (
                      <p className="dk-muted">Your roles on this course do not include moderation, so no delete is offered.</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="dk-stack" aria-labelledby="h-moderation-events">
            <h2 id="h-moderation-events">Moderation actions</h2>
            {queue.data.events.length === 0 ? (
              <p className="dk-muted" data-testid="moderation-events">
                No moderation action yet.
              </p>
            ) : (
              <ul className="dk-stack" data-testid="moderation-events">
                {queue.data.events.map((e) => (
                  <li key={e.id} data-event={e.id} data-action={e.action} data-post={e.postId ?? ''} data-author={e.authorId}>
                    {when(e.recordedAt)}: {ACTION_WORDS[e.action]} ({e.posts === 1 ? '1 post' : `${e.posts} posts`}) in{' '}
                    {courseTitle(e.courseId)}, by <code>{e.actorId}</code>. Reason: {e.reason}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
