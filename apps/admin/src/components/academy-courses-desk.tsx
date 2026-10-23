'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState, type FormEvent } from 'react';
import { Chip, type ChipTone } from '@/components/chip';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchCourses, postCourseChange } from '@/lib/academy/courses-browser';
import {
  priceLabel,
  type AcademyCourse,
  type CourseDeskReply,
  type CourseDetailView,
  type CourseListView,
} from '@/lib/academy/courses-model';
import { ACADEMY_PAGES } from '@/lib/ops-desk/catalog';
import { OutlineEditor } from '@/components/academy-outline-editor';

/**
 * ACADEMY COURSE DESK (AC-course-structure-01).
 *
 * Create a course as a draft (title, address, summary, thumbnail, free or paid), edit its details while it is a draft,
 * and publish it with a reason. svc-academy refuses a reserved or taken address, a paid course with no price and a
 * course with an empty outline, each by name; this page shows the refusal and re-reads the course, never retrying a
 * change on its own. No money moves: a price is a catalogue figure.
 */

const STATE: Record<AcademyCourse['state'], { label: string; tone: ChipTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  published: { label: 'Published', tone: 'live' },
  concluded: { label: 'Concluded', tone: 'info' },
  archived: { label: 'Archived', tone: 'warn' },
  deleted: { label: 'Deleted', tone: 'danger' },
};

/** The answer to the last change, as the desk and the lesson editor show it. */
export function Outcome({
  reply,
}: {
  reply: Pick<CourseDeskReply & { ok: true }, 'ok' | 'what'> | (CourseDeskReply & { ok: false }) | null;
}) {
  if (!reply) return null;
  if (reply.ok)
    return (
      <div className="adm-callout" role="status" data-tone="ok" data-testid="course-desk-outcome">
        <strong>Done: {reply.what}</strong>
      </div>
    );
  return (
    <div
      className="adm-callout"
      role="alert"
      data-tone={reply.changed === 'unknown' ? 'warn' : 'danger'}
      data-testid="course-desk-outcome"
      data-code={reply.code ?? ''}
    >
      <strong>{reply.title}</strong>
      <p>{reply.body}</p>
      <p className="dk-muted">{reply.next}</p>
      {reply.code && <p className="dk-muted">Code: {reply.code}</p>}
    </div>
  );
}

export function Failed({ title, message, code }: { title: string; message: string; code: string | null }) {
  return (
    <div className="adm-callout" data-tone="danger" role="status" data-code={code ?? ''}>
      <strong>{title}</strong>
      <p>{message}</p>
      {code && <p className="dk-muted">Code: {code}</p>}
    </div>
  );
}

export function AcademyNav() {
  return (
    <nav aria-label="Sections" className="dk-row">
      {ACADEMY_PAGES.map((p) => (
        <Link key={p.id} href={p.href}>
          {p.title}
        </Link>
      ))}
    </nav>
  );
}

type Fields = { title: string; summary: string; thumbnailUrl: string; pricing: 'free' | 'paid'; price: string; priceAsset: string };

const fieldsOf = (c: AcademyCourse | null): Fields => ({
  title: c?.title ?? '',
  summary: c?.summary ?? '',
  thumbnailUrl: c?.thumbnailUrl ?? '',
  pricing: c?.pricing ?? 'free',
  price: c?.price ?? '',
  priceAsset: c?.priceAsset ?? '',
});

/** Title, summary, thumbnail and the pricing choice: the same fields for a new course and a draft's edit. */
function DetailFields({ id, value, onChange }: { id: string; value: Fields; onChange: (next: Fields) => void }) {
  const set = (patch: Partial<Fields>) => onChange({ ...value, ...patch });
  return (
    <>
      <div className="adm-field">
        <label htmlFor={`${id}-title`}>Title</label>
        <input id={`${id}-title`} value={value.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} />
      </div>
      <div className="adm-field">
        <label htmlFor={`${id}-summary`}>Summary</label>
        <textarea id={`${id}-summary`} value={value.summary} maxLength={1000} rows={3} onChange={(e) => set({ summary: e.target.value })} />
      </div>
      <div className="adm-field">
        <label htmlFor={`${id}-thumbnail`}>Thumbnail address</label>
        <input
          id={`${id}-thumbnail`}
          value={value.thumbnailUrl}
          placeholder="https://"
          onChange={(e) => set({ thumbnailUrl: e.target.value })}
        />
        <p className="dk-muted">An https image address, or blank for none.</p>
      </div>
      <fieldset className="adm-field">
        <legend>Pricing</legend>
        <label>
          <input type="radio" name={`${id}-pricing`} checked={value.pricing === 'free'} onChange={() => set({ pricing: 'free' })} /> Free
        </label>
        <label>
          <input type="radio" name={`${id}-pricing`} checked={value.pricing === 'paid'} onChange={() => set({ pricing: 'paid' })} /> Paid
        </label>
      </fieldset>
      {value.pricing === 'paid' && (
        <div className="dk-row">
          <div className="adm-field">
            <label htmlFor={`${id}-price`}>Price</label>
            <input id={`${id}-price`} inputMode="decimal" value={value.price} onChange={(e) => set({ price: e.target.value })} />
          </div>
          <div className="adm-field">
            <label htmlFor={`${id}-asset`}>Asset</label>
            <input id={`${id}-asset`} value={value.priceAsset} maxLength={12} onChange={(e) => set({ priceAsset: e.target.value })} />
          </div>
          <p className="dk-muted">A paid course can be saved without a price. It is not published until it has one.</p>
        </div>
      )}
    </>
  );
}

function CourseRow({ course }: { course: AcademyCourse }) {
  return (
    <tr data-testid={`course-${course.slug}`}>
      <td>
        <Link href={`/academy-ops/catalogue/courses/${course.id}`}>{course.title}</Link>
      </td>
      <td>{course.slug}</td>
      <td>
        <Chip tone={STATE[course.state].tone}>{STATE[course.state].label}</Chip>
      </td>
      <td>{priceLabel(course)}</td>
      <td>{course.items}</td>
      <td>{formatWhen(course.createdAt)}</td>
    </tr>
  );
}

export function AcademyCoursesDesk({ initial }: { initial: CourseListView | null }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<CourseDeskReply | null>(null);
  const [slug, setSlug] = useState('');
  const [fields, setFields] = useState<Fields>(fieldsOf(null));

  const reload = useCallback(async () => {
    const next = await fetchCourses();
    if (next && 'list' in next) setView(next);
  }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const answer = await postCourseChange({ op: 'create', slug, ...fields });
    setReply(answer);
    setBusy(false);
    if (answer.ok) router.push(`/academy-ops/catalogue/courses/${answer.course.id}`);
    else await reload();
  };

  const list = view?.list;
  return (
    <div className="dk" data-testid="academy-courses">
      <div className="adm-pagehead">
        <div>
          <h1>Courses</h1>
          <p>Every course staff created, newest first. A new course is saved as a draft; learners see it only once it is published.</p>
        </div>
      </div>
      <AcademyNav />
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={() => void reload()}>
          Refresh
        </button>
        <span className="dk-asof">{view ? `Read ${formatAsOf(view.asOf)}` : 'No read yet'}</span>
      </div>
      {!list && <p className="dk-why">The console could not reach its own server for this desk. Nothing is shown rather than a guess.</p>}
      {list?.kind === 'failed' && <Failed title="Could not read the courses" message={list.message} code={list.code} />}
      {list?.kind === 'ok' && (
        <section className="dk-stack" aria-labelledby="h-courses">
          <h2 id="h-courses">All courses</h2>
          <p className="dk-row" data-testid="course-counts">
            {(Object.keys(STATE) as AcademyCourse['state'][]).map((s) => (
              <Chip key={s} tone={STATE[s].tone}>
                {STATE[s].label}: {list.data.counts[s]}
              </Chip>
            ))}
          </p>
          {list.data.courses.length === 0 ? (
            <p className="dk-muted" data-testid="courses-empty">
              No course has been created on this desk yet. The four shipped courses (the curriculum paths) are counted in the catalogue’s
              curriculum inventory.
            </p>
          ) : (
            <div className="dk-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Address</th>
                    <th>State</th>
                    <th>Price</th>
                    <th>Items</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.courses.map((c) => (
                    <CourseRow key={c.id} course={c} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      <section className="dk-stack" aria-labelledby="h-new-course">
        <h2 id="h-new-course">New course</h2>
        <form className="dk-stack" onSubmit={(e) => void create(e)}>
          <DetailFields id="new-course" value={fields} onChange={setFields} />
          <div className="adm-field">
            <label htmlFor="new-course-slug">Address</label>
            <input id="new-course-slug" value={slug} maxLength={64} onChange={(e) => setSlug(e.target.value)} />
            <p className="dk-muted">Lower-case words joined by hyphens. It is fixed once the course is created.</p>
          </div>
          <Outcome reply={reply} />
          <button type="submit" className="adm-btn" disabled={busy}>
            {busy ? 'Saving…' : 'Create draft'}
          </button>
        </form>
      </section>
    </div>
  );
}

export function AcademyCourseDesk({ courseId, initial }: { courseId: string; initial: CourseDetailView | null }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<CourseDeskReply | null>(null);
  const loaded = view?.detail.kind === 'ok' ? view.detail.data.course : null;
  const [fields, setFields] = useState<Fields>(fieldsOf(loaded));
  const [reason, setReason] = useState('');

  /** `resetForm` only after a saved change: a refused edit keeps what the founder typed, so they can correct it. */
  const reload = useCallback(
    async (resetForm: boolean) => {
      const next = await fetchCourses(courseId);
      if (next && 'detail' in next) {
        setView(next);
        if (resetForm && next.detail.kind === 'ok') setFields(fieldsOf(next.detail.data.course));
      }
    },
    [courseId],
  );

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    const answer = await postCourseChange(body);
    setReply(answer);
    setBusy(false);
    // Whatever the answer, the page shows the course as svc-academy holds it now.
    await reload(answer.ok);
  };

  const detail = view?.detail;
  return (
    <div className="dk" data-testid="academy-course">
      <div className="adm-pagehead">
        <div>
          <h1>{loaded?.title ?? 'Course'}</h1>
          <p>
            <Link href="/academy-ops/catalogue/courses">All courses</Link>
          </p>
        </div>
      </div>
      <AcademyNav />
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={() => void reload(true)}>
          Refresh
        </button>
        <span className="dk-asof">{view ? `Read ${formatAsOf(view.asOf)}` : 'No read yet'}</span>
      </div>
      <Outcome reply={reply} />
      {!detail && <p className="dk-why">The console could not reach its own server for this desk. Nothing is shown rather than a guess.</p>}
      {detail?.kind === 'failed' && <Failed title="Could not read this course" message={detail.message} code={detail.code} />}
      {detail?.kind === 'ok' && (
        <>
          <section className="dk-stack" aria-labelledby="h-course-facts">
            <h2 id="h-course-facts">Details</h2>
            <dl className="dk-kv" data-testid="course-facts">
              <dt>State</dt>
              <dd>
                <Chip tone={STATE[detail.data.course.state].tone}>{STATE[detail.data.course.state].label}</Chip>
              </dd>
              <dt>Address</dt>
              <dd>{detail.data.course.slug}</dd>
              <dt>Price</dt>
              <dd data-testid="course-price">{priceLabel(detail.data.course)}</dd>
              <dt>Revision</dt>
              <dd>{detail.data.course.revision}</dd>
              <dt>Items in the outline</dt>
              <dd>{detail.data.course.items}</dd>
              <dt>Thumbnail</dt>
              <dd>
                {detail.data.course.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- an address staff typed, shown as it is; nothing is fetched server-side
                  <img src={detail.data.course.thumbnailUrl} alt="Course thumbnail" width={160} referrerPolicy="no-referrer" />
                ) : (
                  'None'
                )}
              </dd>
            </dl>
          </section>
          {/* Remounts only when the stored outline changes (a save writes new ids), so a details save keeps unsaved outline edits. */}
          <OutlineEditor
            key={detail.data.outline.map((s) => s.id).join() || 'empty'}
            detail={detail.data}
            busy={busy}
            onSave={(sections) => void send({ op: 'outline', courseId, revision: detail.data.course.revision, sections })}
          />
          {detail.data.course.state === 'draft' && (
            <section className="dk-stack" aria-labelledby="h-course-edit">
              <h2 id="h-course-edit">Edit the draft</h2>
              <form
                className="dk-stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send({ op: 'update', courseId, revision: detail.data.course.revision, ...fields });
                }}
              >
                <DetailFields id="edit-course" value={fields} onChange={setFields} />
                <button type="submit" className="adm-btn" disabled={busy}>
                  {busy ? 'Saving…' : 'Save draft'}
                </button>
              </form>
            </section>
          )}
          <section className="dk-stack" aria-labelledby="h-course-publish">
            <h2 id="h-course-publish">Publish</h2>
            <p className="dk-muted">
              svc-academy refuses to publish a paid course with no price and a course whose outline has nothing to open, and says which.
            </p>
            <form
              className="dk-stack"
              onSubmit={(e) => {
                e.preventDefault();
                void send({ op: 'move', courseId, to: 'published', revision: detail.data.course.revision, reason });
              }}
            >
              <div className="adm-field">
                <label htmlFor="course-publish-reason">Reason</label>
                <input id="course-publish-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
              </div>
              <button type="submit" className="adm-btn" disabled={busy || detail.data.course.state !== 'draft'}>
                Publish
              </button>
            </form>
          </section>
          <section className="dk-stack" aria-labelledby="h-course-history">
            <h2 id="h-course-history">History</h2>
            <ol className="dk-stack" data-testid="course-history">
              {detail.data.events.map((e) => (
                <li key={e.revision}>
                  {formatWhen(e.at)}:{' '}
                  {e.kind === 'created'
                    ? 'created as a draft'
                    : e.kind === 'updated'
                      ? 'details saved'
                      : e.kind === 'outline'
                        ? 'outline saved'
                        : e.kind === 'lesson'
                          ? 'a lesson published to learners'
                          : `moved to ${e.toState}`}{' '}
                  (revision {e.revision}) by <code>{e.actor}</code>
                  {e.reason ? `: ${e.reason}` : ''}
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </div>
  );
}
