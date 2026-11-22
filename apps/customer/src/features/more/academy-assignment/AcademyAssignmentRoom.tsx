import { useEffect, useRef, useState } from 'react';
import { Button, Field, TextArea } from '@intafaced/ui/lit';
import { FlowTemplate, Tabs, type RoomState } from '@intafaced/ui/lit/templates';
import type { AcademyAnswerMode, AcademyAssignmentView, AcademySubmissionState } from '@intafaced/contracts/academy-courses';
import type { ApiResult } from '../../../shared/api';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { useApi } from '../../session';
import { copy as moreCopy } from '../copy';
import { academyCodeOf, academyRefusalText } from '../academy-flows';
import { academyLmsCopy as copy } from '../academy-lms-copy';
import { academyAssignmentCalls } from '../academy-tracking';
import { academyCourseHref, academyTabHref, academyTabs, type AcademyTab } from '../academy-lms';
import { ACADEMY_UPLOAD_ASSIGNMENT_FILE } from '@intafaced/contracts/academy-upload-assignment-file-procedures';
import { AcademyFailure } from './AcademyFailure';
import { AcademyPeerReview } from './PeerReview';
import { byteSize, percentOf } from './byte-size';

export { byteSize, percentOf };

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
const TAB_KEYS = {
  Learning: 'academy.learning',
  Certificates: 'academy.certificates',
  Rooms: 'academy.rooms',
  Videos: 'academy.videos',
  Programmes: 'academy.programmes',
} as const satisfies Record<AcademyTab, string>;

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
      <p role="status" data-testid="assignment-outcome">
        {t('asgUncertain')}
      </p>
    );
  // Here the store that would hold the file is what is missing, not a recording.
  const words =
    academyCodeOf(outcome.failure) === 'academy.video_storage_unconfigured' ? t('asgStorageUnset') : academyRefusalText(outcome.failure, t);
  return (
    <div role="status" data-testid="assignment-outcome" data-code={academyCodeOf(outcome.failure) ?? undefined}>
      {words === null ? <AcademyFailure failure={outcome.failure} retry={retry} /> : <p>{words}</p>}
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
      <p className="lt-hint" data-testid="assignment-submissions">
        {t('asgNothingYet')}
      </p>
    );
  return (
    <ol data-testid="assignment-submissions">
      {data.submissions.map((s) => (
        <li key={s.version}>
          <strong>{t('asgVersion', { version: s.version })}</strong>{' '}
          <span data-testid="academy-lms-meta" className="lt-hint">
            <span>{t(STATE_KEYS[s.state])}</span> <span>{s.late ? t('asgLate') : data.dueAt ? t('asgOnTime') : null}</span>{' '}
            <span>{t('asgSubmittedAt', { date: when(s.submittedAt, language) })}</span>
          </span>
          {s.text && (
            <p className="lt-hint" lang="und">
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
      <p className="lt-hint" data-testid="assignment-grade">
        {t('grdNone')}
      </p>
    );
  return (
    <section data-testid="assignment-grade" aria-label={t('grdTitle')}>
      <h3>{t('grdTitle')}</h3>
      <strong>{t('grdScore', { score: grade.score, points: grade.points })}</strong>
      {grade.entered !== null && <p data-testid="assignment-grade-late">{t('grdLate', { entered: grade.entered })}</p>}
      <p data-testid="academy-lms-meta" className="lt-hint">
        {t('grdForVersion', { version: grade.version, date: when(grade.gradedAt, language) })}
      </p>
      <p lang="und">{grade.comment ?? t('grdNoComment')}</p>
      {grade.readAt ? (
        <p role="status">{t('grdRead')}</p>
      ) : (
        <Button type="button" disabled={marking} onClick={() => onMarkRead(grade.version, grade.n)}>
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
    <div>
      <nav aria-label={t('breadcrumb')}>
        <a className="lt-link" href={academyCourseHref(data.courseSlug)} lang="und">
          {t('asgBack')}
        </a>
      </nav>
      <p data-testid="academy-lms-meta" className="lt-hint">
        <span data-testid="assignment-due">{data.dueAt ? t('asgDue', { date: when(data.dueAt, language) }) : t('asgNoDue')}</span>{' '}
        <span data-testid="assignment-points">{t('asgPoints', { points: data.points })}</span>
      </p>
      {data.extension && (
        <p className="lt-hint" data-testid="assignment-extension">
          <span lang="und">{t('asgExtended', { date: when(data.extension.dueAt, language), reason: data.extension.reason })}</span>
        </p>
      )}
      <section aria-label={t('asgBrief')}>
        <h3>{t('asgBrief')}</h3>
        <p lang="und">{data.instructions}</p>
      </section>
      <Asks data={data} t={t} />
      <p data-testid="assignment-late-rule">
        {data.latePolicy
          ? t('asgLateRule', { grace: data.latePolicy.graceHours, percent: percentOf(data.latePolicy.deductionPerDay) })
          : t('asgLateRuleNone')}
      </p>
    </div>
  );
}

/** The Academy's own sections, each its own address; an assignment sits in Learning. */
function AcademyTabs() {
  const more = moreCopy.useCopy();
  return (
    <Tabs
      items={academyTabs.map(([name]) => ({ label: more.t(TAB_KEYS[name]), href: academyTabHref(name) }))}
      current={academyTabHref('Learning')}
      label={more.t('academy.academy.sections')}
    />
  );
}

/**
 * An assignment's page in a course staff made (AC-assignments-01), signed in, on the flow template. The brief and the
 * learner's own hand-ins come from one read. Hand in sends the file first (when there is one), then version n of the
 * hand-in, where n is the version this page read: a lost reply re-reads the stored hand-ins and never sends again under
 * a new version, so a retry is the same hand-in. A refusal names its reason and leaves the answer on the page.
 *
 * `/academy/learning/course/:slug/assignment/:itemId`. Signed-out visitors never reach it (the router sends them to the
 * public Academy).
 */
export function AcademyAssignmentRoom({ slug, itemId }: { slug: string; itemId: string }) {
  const api = useApi();
  const { t } = copy.useCopy();
  const more = moreCopy.useCopy();
  const view = useResource((signal) => academyAssignmentCalls.read(api, itemId, signal), `assignment:${itemId}`);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // A new key gives a fresh file field, which is how the chosen file is cleared after a hand-in.
  const [fileKey, setFileKey] = useState(0);
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

  const frame = { title: more.t('moreroutes.academy'), description: more.t('moreroutes.learn.practise.and.join.hosted.sessions') };
  const wrongAddress = !GUID.test(itemId) || (ready !== null && ready.courseSlug !== slug);
  if (view.resource.status === 'failed' || wrongAddress) {
    const failure = wrongAddress ? refusalOf('academy.assignment_not_found') : (view.resource as { failure: Failure }).failure;
    const notEnrolled = academyCodeOf(failure) === 'academy.enrolment_required';
    return (
      <FlowTemplate
        {...frame}
        state={{ kind: 'ready' }}
        step={
          <>
            <AcademyTabs />
            <div data-academy-assignment={itemId}>
              <h2>{t('asgBrief')}</h2>
              <OutcomeLine outcome={{ kind: 'refused', failure }} retry={notEnrolled ? undefined : view.reload} />
              {notEnrolled && (
                <a className="lt-button lt-button-primary" href={academyCourseHref(slug)}>
                  {t('linkedOpenPublic')}
                </a>
              )}
            </div>
          </>
        }
      />
    );
  }
  const data = ready ?? last;
  const state: RoomState = data ? { kind: 'ready' } : { kind: 'loading' };
  if (!data) return <FlowTemplate {...frame} state={state} step={null} />;

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
        const uploaded = await api.call(ACADEMY_UPLOAD_ASSIGNMENT_FILE, {
          itemId,
          fileName: file.name,
          contentType: file.type || 'application/octet-stream',
          contentBase64: await base64Of(file),
        });
        // The same file again is the same stored row, so a lost upload reply is safe to send again from here.
        if (!uploaded.ok)
          return setOutcome(uploaded.reason === 'uncertain' ? { kind: 'uncertain' } : { kind: 'refused', failure: uploaded });
        fileId = uploaded.data.id;
      }
      const sent = await academyAssignmentCalls.submit(api, { itemId, version, text: text.trim() ? text : null, fileId });
      setRetryVersion(!sent.ok && sent.reason === 'uncertain' ? version : null);
      if (sent.ok) {
        setOutcome({ kind: 'done', version });
        setText('');
        setFile(null);
        setFileKey((n) => n + 1);
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
    const marked = await academyAssignmentCalls.markRead(api, { itemId, version, n });
    setMarking(false);
    if (marked.ok) setLast(marked.data);
    else if (marked.reason !== 'uncertain') setReadRefused(marked);
    view.reload();
  };

  const closed = data.withdrawnAt !== null;
  return (
    <FlowTemplate
      {...frame}
      state={state}
      step={
        <>
          <AcademyTabs />
          <div data-academy-assignment={data.itemId}>
            <section aria-label={data.title}>
              <h2 lang="und">{data.title}</h2>
              <AssignmentBrief data={data} />
            </section>
            <section aria-label={t('asgSubmissions')}>
              <h2>{t('asgSubmissions')}</h2>
              {closed ? (
                <p className="lt-hint">{t('asgWithdrawn')}</p>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handIn();
                  }}
                >
                  {data.text !== 'off' && (
                    <TextArea
                      label={t('asgYourAnswer')}
                      value={text}
                      rows={6}
                      maxLength={20_000}
                      onChange={(event) => setText(event.target.value)}
                    />
                  )}
                  {data.file !== 'off' && (
                    <Field
                      key={fileKey}
                      label={t('asgFileField')}
                      type="file"
                      accept={data.fileLimits.types?.join(',')}
                      onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                    />
                  )}
                  {file && <p data-testid="assignment-file">{t('asgFileChosen', { name: file.name, size: byteSize(file.size) })}</p>}
                  <Button type="submit" tone="primary" disabled={sending}>
                    {sending ? t('asgSending') : t('asgHandIn')}
                  </Button>
                </form>
              )}
              {outcome && <OutcomeLine outcome={outcome} />}
              <AssignmentSubmissions data={data} />
              <AcademyPeerReview itemId={data.itemId} handedIn={data.submissions.length} />
              <AssignmentGrade grade={data.grade} marking={marking} onMarkRead={(version, n) => void markRead(version, n)} />
              {readRefused && <AcademyFailure failure={readRefused} />}
            </section>
          </div>
        </>
      }
    />
  );
}
