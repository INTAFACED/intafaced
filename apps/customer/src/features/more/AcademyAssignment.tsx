import { useEffect, useRef, useState } from 'react';
import {
  academyAssignmentViewSchema,
  academySubmissionFileSchema,
  type AcademyAnswerMode,
  type AcademyAssignmentView,
  type AcademySubmissionState,
} from '@intafaced/contracts/academy-courses';
import type { ApiResult } from '../../shared/api';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { Button, Loading, Panel } from '../../shared/ui';
import { useApi } from '../session/session';
import { academyCodeOf, academyRefusalText } from './academy-flows';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyCourseHref } from './academy-lms';
import { AcademyRefusal } from './AcademyLmsParts';
import { AcademyPeerReview } from './AcademyPeerReview';

type Failure = Extract<ApiResult<never>, { ok: false }>;
type T = (typeof copy)['t'];

const MODE_KEYS = { required: 'asgModeRequired', optional: 'asgModeOptional', off: 'asgModeOff' } as const satisfies Record<
  AcademyAnswerMode,
  string
>;
const STATE_KEYS = {
  draft: 'asgStateDraft',
  submitted: 'asgStateSubmitted',
  pending_review: 'asgStatePendingReview',
  graded: 'asgStateGraded',
  returned: 'asgStateReturned',
  withdrawn: 'asgStateWithdrawn',
} as const satisfies Record<AcademySubmissionState, string>;

/** A byte count in the largest binary unit it fills: 1048576 is "1 MiB". */
export function byteSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${+(bytes / 1_048_576).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${+(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

const when = (iso: string, language: string) => {
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return iso;
  }
};

async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A refusal this page words itself, with the code the service would have sent. */
const refusalOf = (code: string): Failure => ({ ok: false, reason: 'error', message: code, code });
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Outcome = { kind: 'refused'; failure: Failure } | { kind: 'uncertain' } | { kind: 'done'; version: number };

/** The outcome line under the form: a typed refusal with its code, a lost reply, or the version handed in. */
function OutcomeLine({ outcome, retry }: { outcome: Outcome; retry?: () => void }) {
  const { t } = copy.useCopy();
  if (outcome.kind === 'done')
    return (
      <p role="status" data-testid="assignment-outcome">
        {t('asgHandedIn', { version: outcome.version })}
      </p>
    );
  if (outcome.kind === 'uncertain')
    return (
      <p role="status" className="failure" data-testid="assignment-outcome">
        {t('asgUncertain')}
      </p>
    );
  // Here the store that would hold the file is what is missing, not a recording.
  const words =
    academyCodeOf(outcome.failure) === 'academy.video_storage_unconfigured' ? t('asgStorageUnset') : academyRefusalText(outcome.failure, t);
  return (
    <div role="status" className="failure" data-testid="assignment-outcome" data-code={academyCodeOf(outcome.failure) ?? undefined}>
      {words === null ? <AcademyRefusal failure={outcome.failure} retry={retry} /> : <p>{words}</p>}
    </div>
  );
}

/** What the brief asks for, line by line, with the owner's file limits or that they are not set. */
function Asks({ data, t }: { data: AcademyAssignmentView; t: T }) {
  const fileMode = t(MODE_KEYS[data.file]);
  const { maxBytes, types } = data.fileLimits;
  return (
    <section aria-label={t('asgAsks')}>
      <h3>{t('asgAsks')}</h3>
      <ul data-testid="assignment-asks">
        <li>{t('asgText', { mode: t(MODE_KEYS[data.text]) })}</li>
        <li>
          {data.file === 'off'
            ? t('asgFileOff', { mode: fileMode })
            : maxBytes === null || !types || types.length === 0
              ? t('asgFileLimitsUnset', { mode: fileMode })
              : t('asgFile', { mode: fileMode, types: types.join(', '), size: byteSize(maxBytes) })}
        </li>
      </ul>
    </section>
  );
}

/** The learner's own hand-ins, newest first. Pure: the view arrives as props. */
export function AssignmentSubmissions({ data }: { data: AcademyAssignmentView }) {
  const { t } = copy.useCopy();
  const { language } = usePreferences();
  if (data.submissions.length === 0)
    return (
      <p className="muted" data-testid="assignment-submissions">
        {t('asgNothingYet')}
      </p>
    );
  return (
    <ol className="academy-lms-stack" data-testid="assignment-submissions">
      {data.submissions.map((s) => (
        <li key={s.version} className="academy-lms-card">
          <strong>{t('asgVersion', { version: s.version })}</strong>
          <span data-testid="academy-lms-meta" className="academy-lms-meta">
            <span>{t(STATE_KEYS[s.state])}</span>
            <span>{s.late ? t('asgLate') : data.dueAt ? t('asgOnTime') : null}</span>
            <span>{t('asgSubmittedAt', { date: when(s.submittedAt, language) })}</span>
          </span>
          {s.text && (
            <p className="muted" lang="und">
              {s.text}
            </p>
          )}
          {s.file && (
            <p lang="und">
              {s.file.fileName} ({byteSize(s.file.bytes)})
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * The learner's grade on their newest graded hand-in (AC-assignments-02): score of points and the comment, never who
 * graded it. Mark as read is sent once per grade; the same version again is answered as stored.
 */
export function AssignmentGrade({
  grade,
  marking,
  onMarkRead,
}: {
  grade: AcademyAssignmentView['grade'];
  marking: boolean;
  onMarkRead: (version: number, n: number) => void;
}) {
  const { t } = copy.useCopy();
  const { language } = usePreferences();
  if (!grade)
    return (
      <p className="muted" data-testid="assignment-grade">
        {t('grdNone')}
      </p>
    );
  return (
    <section className="academy-lms-stack" data-testid="assignment-grade" aria-label={t('grdTitle')}>
      <h3>{t('grdTitle')}</h3>
      <strong>{t('grdScore', { score: grade.score, points: grade.points })}</strong>
      <span data-testid="academy-lms-meta" className="academy-lms-meta">
        {t('grdForVersion', { version: grade.version, date: when(grade.gradedAt, language) })}
      </span>
      <p lang="und" style={{ whiteSpace: 'pre-wrap' }}>
        {grade.comment ?? t('grdNoComment')}
      </p>
      {grade.readAt ? (
        <p role="status">{t('grdRead')}</p>
      ) : (
        <Button type="button" variant="secondary" disabled={marking} onClick={() => onMarkRead(grade.version, grade.n)}>
          {marking ? t('grdMarking') : t('grdMarkRead')}
        </Button>
      )}
    </section>
  );
}

/** The brief, its due date and points, what to hand in and the course's late rule. Pure. */
export function AssignmentBrief({ data }: { data: AcademyAssignmentView }) {
  const { t } = copy.useCopy();
  const { language } = usePreferences();
  return (
    <div className="academy-lms-stack">
      <nav className="academy-lms-crumbs" aria-label={t('breadcrumb')}>
        <a className="text-link" href={academyCourseHref(data.courseSlug)} lang="und">
          {t('asgBack')}
        </a>
      </nav>
      <p data-testid="academy-lms-meta" className="academy-lms-meta">
        <span data-testid="assignment-due">{data.dueAt ? t('asgDue', { date: when(data.dueAt, language) }) : t('asgNoDue')}</span>
        <span data-testid="assignment-points">{t('asgPoints', { points: data.points })}</span>
      </p>
      {data.extension && (
        <p className="academy-lms-meta" data-testid="assignment-extension">
          <span lang="und">{t('asgExtended', { date: when(data.extension.dueAt, language), reason: data.extension.reason })}</span>
        </p>
      )}
      <section aria-label={t('asgBrief')}>
        <h3>{t('asgBrief')}</h3>
        <p lang="und" style={{ whiteSpace: 'pre-wrap' }}>
          {data.instructions}
        </p>
      </section>
      <Asks data={data} t={t} />
      <p data-testid="assignment-late-rule">{data.lateRule ? t('asgLateRule', { rule: data.lateRule }) : t('asgLateRuleNone')}</p>
    </div>
  );
}

/**
 * An assignment's page in a course staff made (AC-assignments-01), signed in. The brief and the learner's own hand-ins
 * come from one read. Hand in sends the file first (when there is one), then version n of the hand-in, where n is the
 * version this page read: a lost reply re-reads the stored hand-ins and never sends again under a new version, so a
 * retry is the same hand-in. A refusal names its reason and leaves the answer on the page.
 */
export function AcademyAssignment({ slug, itemId }: { slug: string; itemId: string }) {
  const api = useApi();
  const { t } = copy.useCopy();
  const view = useResource(
    (signal) => api.query('academy', 'assignment', { itemId }, academyAssignmentViewSchema, { signal }),
    `assignment:${itemId}`,
  );
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  // After a lost reply the next press resends the same version, so a hand-in that did land is answered, not repeated.
  const [retryVersion, setRetryVersion] = useState<number | null>(null);
  // A re-read after a hand-in keeps the page (and what is typed in it) on screen until the new read lands.
  const [last, setLast] = useState<AcademyAssignmentView | null>(null);
  const [marking, setMarking] = useState(false);
  const [readRefused, setReadRefused] = useState<Failure | null>(null);
  const ready = view.resource.status === 'ready' ? view.resource.data : null;
  useEffect(() => {
    if (ready) setLast(ready);
  }, [ready]);

  const wrongAddress = !GUID.test(itemId) || (ready !== null && ready.courseSlug !== slug);
  if (view.resource.status === 'failed' || wrongAddress) {
    const failure = wrongAddress ? refusalOf('academy.assignment_not_found') : (view.resource as { failure: Failure }).failure;
    const notEnrolled = academyCodeOf(failure) === 'academy.enrolment_required';
    return (
      <Panel title={t('asgBrief')}>
        <div className="academy-lms-stack" data-academy-assignment={itemId}>
          <OutcomeLine outcome={{ kind: 'refused', failure }} retry={notEnrolled ? undefined : view.reload} />
          {notEnrolled && (
            <a className="button button--primary" href={academyCourseHref(slug)}>
              {t('linkedOpenPublic')}
            </a>
          )}
        </div>
      </Panel>
    );
  }
  const data = ready ?? last;
  if (!data) return <Loading />;

  const handIn = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setOutcome(null);
    const version = retryVersion ?? data.nextVersion;
    try {
      let fileId: string | null = null;
      if (file && data.fileLimits.maxBytes !== null && file.size > data.fileLimits.maxBytes)
        return setOutcome({ kind: 'refused', failure: refusalOf('academy.upload_too_large') });
      if (file) {
        const uploaded = await api.mutate(
          'academy',
          'uploadAssignmentFile',
          { itemId, fileName: file.name, contentType: file.type || 'application/octet-stream', contentBase64: await base64Of(file) },
          academySubmissionFileSchema,
        );
        // The same file again is the same stored row, so a lost upload reply is safe to send again from here.
        if (!uploaded.ok)
          return setOutcome(uploaded.reason === 'uncertain' ? { kind: 'uncertain' } : { kind: 'refused', failure: uploaded });
        fileId = uploaded.data.id;
      }
      const sent = await api.mutate(
        'academy',
        'submitAssignment',
        { itemId, version, text: text.trim() ? text : null, fileId },
        academyAssignmentViewSchema,
      );
      setRetryVersion(!sent.ok && sent.reason === 'uncertain' ? version : null);
      if (sent.ok) {
        setOutcome({ kind: 'done', version });
        setText('');
        setFile(null);
        if (fileInput.current) fileInput.current.value = '';
      } else setOutcome(sent.reason === 'uncertain' ? { kind: 'uncertain' } : { kind: 'refused', failure: sent });
    } finally {
      inFlight.current = false;
      setSending(false);
      // What Academy stored is what the page shows, whatever the reply said.
      view.reload();
    }
  };

  const markRead = async (version: number, n: number) => {
    setMarking(true);
    setReadRefused(null);
    const marked = await api.mutate('academy', 'markFeedbackRead', { itemId, version, n }, academyAssignmentViewSchema);
    setMarking(false);
    if (marked.ok) setLast(marked.data);
    else if (marked.reason !== 'uncertain') setReadRefused(marked);
    view.reload();
  };

  const closed = data.withdrawnAt !== null;
  return (
    <div className="more-columns" data-academy-assignment={data.itemId}>
      <Panel title={data.title}>
        <AssignmentBrief data={data} />
      </Panel>
      <Panel title={t('asgSubmissions')}>
        <div className="academy-lms-stack">
          {closed ? (
            <p className="muted">{t('asgWithdrawn')}</p>
          ) : (
            <form
              className="academy-lms-stack"
              onSubmit={(event) => {
                event.preventDefault();
                void handIn();
              }}
            >
              {data.text !== 'off' && (
                <label>
                  {t('asgYourAnswer')}
                  <textarea value={text} rows={6} maxLength={20_000} onChange={(event) => setText(event.target.value)} />
                </label>
              )}
              {data.file !== 'off' && (
                <label>
                  {t('asgFileField')}
                  <input
                    ref={fileInput}
                    type="file"
                    accept={data.fileLimits.types?.join(',')}
                    onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  />
                </label>
              )}
              {file && <p data-testid="assignment-file">{t('asgFileChosen', { name: file.name, size: byteSize(file.size) })}</p>}
              <Button type="submit" variant="primary" disabled={sending}>
                {sending ? t('asgSending') : t('asgHandIn')}
              </Button>
            </form>
          )}
          {outcome && <OutcomeLine outcome={outcome} />}
          <AssignmentSubmissions data={data} />
          <AcademyPeerReview itemId={data.itemId} handedIn={data.submissions.length} />
          <AssignmentGrade grade={data.grade} marking={marking} onMarkRead={(version, n) => void markRead(version, n)} />
          {readRefused && <AcademyRefusal failure={readRefused} />}
        </div>
      </Panel>
    </div>
  );
}
