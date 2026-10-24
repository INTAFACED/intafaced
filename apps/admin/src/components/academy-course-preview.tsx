'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Chip } from '@/components/chip';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchLinks, postLinksChange } from '@/lib/academy/links-browser';
import type { LinksDeskReply, LinksView, PreviewView } from '@/lib/academy/links-model';
import type { AcademyLearnerItemLock } from '@intafaced/contracts/academy-courses';
import { AcademyNav, Failed, Outcome } from '@/components/academy-courses-desk';

/**
 * PREVIEW AS NEW LEARNER AND PRIVATE LINKS (AC-catalogue-03).
 *
 * The preview is svc-academy's learner view of the stored course: the real syllabus with each item's lock, as a reader
 * who has not enrolled sees it. Opening it writes nothing. A private link opens the course's unlisted page on the
 * customer app before the course is listed; its key is shown once, when it is made, and a revoked link opens nothing.
 */

const LOCK: Record<AcademyLearnerItemLock, string> = {
  enrol: 'Locked until you enrol',
  enrolment_closed: 'Locked: enrolment is closed while the course is not published',
  not_released: 'Not released to learners yet',
};

export function AcademyCoursePreview({ courseId, initial }: { courseId: string; initial: PreviewView }) {
  const view = initial.view;
  return (
    <div className="dk" data-testid="academy-course-preview">
      <div className="adm-pagehead">
        <div>
          <h1>{view.kind === 'ok' ? view.data.title : 'Course'}: preview as a new learner</h1>
          <p>
            <Link href={`/academy-ops/catalogue/courses/${courseId}`}>Back to the course</Link>
          </p>
        </div>
      </div>
      <AcademyNav />
      <p className="dk-muted" data-testid="preview-note">
        This is the course as a learner who has not enrolled sees it, read {formatAsOf(initial.asOf)}. Opening it records nothing: no
        enrolment, no progress and no history entry.
      </p>
      {view.kind === 'failed' && <Failed title="Could not read the preview" message={view.message} code={view.code} />}
      {view.kind === 'ok' && (
        <>
          <section className="dk-stack" aria-labelledby="h-preview-about">
            <h2 id="h-preview-about">About this course</h2>
            <p>{view.data.summary ?? 'No summary has been written.'}</p>
            <p>
              <Chip tone={view.data.state === 'published' ? 'live' : 'neutral'}>Course {view.data.state}</Chip>{' '}
              {view.data.pricing === 'free'
                ? 'Free'
                : view.data.price && view.data.priceAsset
                  ? `${view.data.price} ${view.data.priceAsset}`
                  : 'Paid, with no price set'}
            </p>
          </section>
          <section className="dk-stack" aria-labelledby="h-preview-syllabus">
            <h2 id="h-preview-syllabus">Syllabus</h2>
            {view.data.sections.length === 0 ? (
              <p className="dk-muted">The outline is empty.</p>
            ) : (
              <ol className="dk-stack" data-testid="preview-syllabus">
                {view.data.sections.map((s, si) => (
                  <li key={si}>
                    <strong>{s.title}</strong>
                    <ul className="dk-stack">
                      {s.items.map((item, ii) => (
                        <li key={ii} data-lock={item.lock ?? 'none'} style={{ marginLeft: `${item.indent * 1.5}rem` }}>
                          {item.kind === 'subheader' ? (
                            <em>{item.title}</em>
                          ) : (
                            <>
                              {item.title} <span className="dk-muted">({item.kind})</span>{' '}
                              {item.lock && <Chip tone="neutral">{LOCK[item.lock]}</Chip>}
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** The course's private links: make one with a reason (its address is shown once), and revoke one with a reason. */
export function CoursePrivateLinks({ courseId }: { courseId: string }) {
  const [view, setView] = useState<LinksView | null>(null);
  const [read, setRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<LinksDeskReply | null>(null);
  const [why, setWhy] = useState('');
  const [revokeWhy, setRevokeWhy] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    setView(await fetchLinks(courseId));
    setRead(true);
  }, [courseId]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    const answer = await postLinksChange(body);
    setReply(answer);
    setBusy(false);
    if (answer.ok && body.op === 'create') setWhy('');
    if (answer.ok && body.op === 'revoke') setRevokeWhy(({ [String(body.linkId)]: _done, ...rest }) => rest);
    await reload();
  };

  const links = view?.links;
  return (
    <section className="dk-stack" aria-labelledby="h-course-links">
      <h2 id="h-course-links">Learners’ view</h2>
      <p>
        <Link className="adm-btn" href={`/academy-ops/catalogue/courses/${courseId}/preview`}>
          Preview as new learner
        </Link>
      </p>
      <h3>Private links</h3>
      <p className="dk-muted">
        A private link opens this course’s page on the customer app before the course is listed. Its address is shown once, when it is made.
      </p>
      <Outcome reply={reply} />
      {reply?.ok && reply.path && (
        <p data-testid="link-made">
          The new link, on the customer app: <code>{reply.path}</code>
        </p>
      )}
      <form
        className="dk-row"
        onSubmit={(e) => {
          e.preventDefault();
          void send({ op: 'create', courseId, reason: why });
        }}
      >
        <div className="adm-field">
          <label htmlFor="link-reason">Why make a link</label>
          <input id="link-reason" value={why} maxLength={500} onChange={(e) => setWhy(e.target.value)} />
        </div>
        <button type="submit" className="adm-btn" disabled={busy}>
          Make a private link
        </button>
      </form>
      {read && !view && (
        <p className="dk-why">The console could not reach its own server for the links. Nothing is shown rather than a guess.</p>
      )}
      {links?.kind === 'failed' && <Failed title="Could not read the private links" message={links.message} code={links.code} />}
      {links?.kind === 'ok' &&
        (links.data.length === 0 ? (
          <p className="dk-muted" data-testid="course-links">
            No private links.
          </p>
        ) : (
          <ul className="dk-stack" data-testid="course-links">
            {links.data.map((l) => (
              <li key={l.id} data-state={l.revokedAt ? 'revoked' : 'open'}>
                <Chip tone={l.revokedAt ? 'neutral' : 'live'}>{l.revokedAt ? 'Revoked' : 'Opens the page'}</Chip> made{' '}
                {formatWhen(l.createdAt)} by <code>{l.createdBy}</code>: {l.reason}
                {l.revokedAt ? (
                  <span className="dk-muted">
                    {' '}
                    Revoked {formatWhen(l.revokedAt)} by <code>{l.revokedBy}</code>: {l.revokeReason}
                  </span>
                ) : (
                  <form
                    className="dk-row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void send({ op: 'revoke', linkId: l.id, reason: revokeWhy[l.id] ?? '' });
                    }}
                  >
                    <div className="adm-field">
                      <label htmlFor={`revoke-${l.id}`}>Why revoke it</label>
                      <input
                        id={`revoke-${l.id}`}
                        value={revokeWhy[l.id] ?? ''}
                        maxLength={500}
                        onChange={(e) => setRevokeWhy((w) => ({ ...w, [l.id]: e.target.value }))}
                      />
                    </div>
                    <button type="submit" className="adm-btn" disabled={busy}>
                      Revoke
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        ))}
      {view && <span className="dk-asof">Links read {formatAsOf(view.asOf)}</span>}
    </section>
  );
}
