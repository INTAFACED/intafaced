'use client';

import { useCallback, useState } from 'react';
import { ACADEMY_RELEASE_MAX_DAYS, type AcademyCoursePacing } from '@intafaced/contracts/academy-course-release';
import { Chip } from '@/components/chip';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchRelease, postReleaseChange } from '@/lib/academy/release-browser';
import type { AcademyCourseRelease, ReleaseDeskReply, ReleaseView } from '@/lib/academy/release-model';
import { Failed, Outcome } from '@/components/academy-courses-desk';

/**
 * RELEASE AND PACING (AC-release-access-01).
 *
 * Each section opens with the course, at a date and time (entered in this browser's time zone, stored as an instant, and
 * shown to each learner in theirs), or some whole days after each learner enrols. Until then its items are closed to
 * the learner, who sees a clock with the time it opens. The course is self-paced or instructor-paced; once a learner has
 * enrolled the pacing stays and svc-academy refuses a change by name. Every change carries a reason and the founder's
 * name. This section shows every refusal and reads again, never retrying on its own.
 */

const PACING_WORDS: Record<AcademyCoursePacing, string> = {
  self_paced: 'Self-paced',
  instructor_paced: 'Instructor-paced',
};

type Section = AcademyCourseRelease['sections'][number];
type Mode = 'none' | 'at' | 'after_enrolment';

/** A stored instant as a datetime-local value in this browser's time zone. */
const localInput = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const ruleWords = (s: Section) =>
  s.rule === null
    ? 'Opens with the course'
    : s.rule.kind === 'at'
      ? `Opens ${formatWhen(s.rule.at)}`
      : `Opens ${s.rule.days} days after each learner enrols`;

function SectionForm({ section, busy, onSave }: { section: Section; busy: boolean; onSave: (body: Record<string, unknown>) => void }) {
  const [mode, setMode] = useState<Mode>(section.rule?.kind ?? 'none');
  const [at, setAt] = useState(section.rule?.kind === 'at' ? localInput(section.rule.at) : '');
  const [days, setDays] = useState(section.rule?.kind === 'after_enrolment' ? String(section.rule.days) : '');
  const [reason, setReason] = useState('');
  const id = section.sectionId;
  return (
    <li className="dk-stack" data-testid="release-section" data-section={section.title}>
      <strong>{section.title}</strong>
      <span className="dk-muted" data-testid="release-rule">
        {ruleWords(section)}
        {section.setAt && ` · set ${formatWhen(section.setAt)}${section.reason ? `: ${section.reason}` : ''}`}
      </span>
      <form
        className="dk-row"
        onSubmit={(e) => {
          e.preventDefault();
          // A blank or unreadable date is sent as it is, so the form names the mistake rather than guessing an instant.
          const instant = at === '' ? '' : new Date(at);
          const rule =
            mode === 'none'
              ? null
              : mode === 'at'
                ? { kind: 'at', at: instant instanceof Date && !Number.isNaN(instant.getTime()) ? instant.toISOString() : at }
                : { kind: 'after_enrolment', days: days.trim() === '' ? null : Number(days.trim()) };
          onSave({ sectionId: id, rule, reason });
        }}
      >
        <label>
          Release
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} aria-label={`Release of ${section.title}`}>
            <option value="none">With the course</option>
            <option value="at">At a date and time</option>
            <option value="after_enrolment">Days after enrolment</option>
          </select>
        </label>
        {mode === 'at' && (
          <label>
            Opens (your time)
            <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-label={`Opens at, ${section.title}`} />
          </label>
        )}
        {mode === 'after_enrolment' && (
          <label>
            Days after enrolment
            <input
              type="number"
              min={1}
              max={ACADEMY_RELEASE_MAX_DAYS}
              step={1}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              aria-label={`Days after enrolment, ${section.title}`}
            />
          </label>
        )}
        <label>
          Reason
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            aria-label={`Release reason, ${section.title}`}
          />
        </label>
        <button type="submit" className="adm-btn" disabled={busy}>
          Save release
        </button>
      </form>
    </li>
  );
}

function PacingForm({
  release,
  busy,
  onSave,
}: {
  release: AcademyCourseRelease;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const [pacing, setPacing] = useState<AcademyCoursePacing | ''>(release.pacing ?? '');
  const [reason, setReason] = useState('');
  return (
    <div className="dk-stack" data-testid="release-pacing">
      <span>
        Pacing: <Chip tone={release.pacing ? 'live' : 'warn'}>{release.pacing ? PACING_WORDS[release.pacing] : 'Not set'}</Chip>
        {release.pacingSetAt && <span className="dk-muted"> set {formatWhen(release.pacingSetAt)}</span>}
      </span>
      {release.pacingLocked && (
        <p className="dk-muted" data-testid="pacing-locked">
          Learners have enrolled, so svc-academy keeps the pacing as it is.
        </p>
      )}
      <form
        className="dk-row"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ op: 'setPacing', pacing, reason });
        }}
      >
        <label>
          Pacing
          <select value={pacing} onChange={(e) => setPacing(e.target.value as AcademyCoursePacing | '')} aria-label="Pacing">
            <option value="">Choose</option>
            <option value="self_paced">{PACING_WORDS.self_paced}</option>
            <option value="instructor_paced">{PACING_WORDS.instructor_paced}</option>
          </select>
        </label>
        <label>
          Reason
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} aria-label="Pacing reason" />
        </label>
        <button type="submit" className="adm-btn" disabled={busy}>
          Save pacing
        </button>
      </form>
    </div>
  );
}

export function AcademyCourseRelease({ courseId, initial }: { courseId: string; initial: ReleaseView | null }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<ReleaseDeskReply | null>(null);

  const reload = useCallback(async () => {
    const next = await fetchRelease(courseId);
    if (next) setView(next);
  }, [courseId]);

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    const answer = await postReleaseChange({ courseId, ...body });
    setReply(answer);
    setBusy(false);
    // Whatever the answer, the section shows the course as svc-academy holds it now.
    await reload();
  };

  const part = view?.release;
  const release = part?.kind === 'ok' ? part.data : null;
  return (
    <section className="dk-stack" aria-labelledby="h-release" data-testid="course-release">
      <h2 id="h-release">Release and pacing</h2>
      <span className="dk-asof">{view ? `Read ${formatAsOf(view.asOf)}` : 'No read yet'}</span>
      <Outcome reply={reply} />
      {!part && <p className="dk-why">The console could not reach its own server for this course. Nothing is shown rather than a guess.</p>}
      {part?.kind === 'failed' && <Failed title="Could not read release and pacing" message={part.message} code={part.code} />}
      {release && (
        <>
          <PacingForm key={`${release.pacing}-${release.pacingSetAt}`} release={release} busy={busy} onSave={(b) => void send(b)} />
          {release.sections.length === 0 ? (
            <p className="dk-muted">The outline has no sections yet.</p>
          ) : (
            <ol className="dk-stack" aria-label="Section release">
              {release.sections.map((s) => (
                <SectionForm
                  key={`${s.sectionId}-${s.setAt}`}
                  section={s}
                  busy={busy}
                  onSave={(b) => void send({ op: 'setSectionRelease', ...b })}
                />
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
