'use client';

import { useCallback, useState } from 'react';
import { ACADEMY_ANSWER_MODES, type AcademyAnswerMode } from '@intafaced/contracts/academy-courses';
import { Chip } from '@/components/chip';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchAssignment, postAssignmentChange } from '@/lib/academy/assignments-browser';
import type { AcademyAdminAssignment, AssignmentDeskReply, AssignmentView } from '@/lib/academy/assignments-model';
import { Failed, Outcome } from '@/components/academy-courses-desk';
import { ReviewSteps } from '@/components/academy-review-steps';

/**
 * ASSIGNMENT EDITOR (AC-assignments-01).
 *
 * An assignment item's brief: instructions, points, an optional due date, and whether a learner hands in a text answer,
 * a file or both. Each save is the next revision over the one read; a saved brief releases the item to enrolled
 * learners. Withdraw stops new hand-ins and keeps the brief and every hand-in. svc-academy refuses a stale revision and a
 * withdrawn assignment by name; this section shows the refusal and reads again, never retrying on its own.
 */

const MODE_WORDS: Record<AcademyAnswerMode, string> = { off: 'Not taken', optional: 'Optional', required: 'Required' };

/** A stored instant as a datetime-local value in this browser's time zone. */
export function localInput(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A datetime-local value back to an instant, or null when the field is empty or not a date. */
export function instantOf(value: string): string | null {
  if (!value.trim()) return null;
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

function Facts({ assignment }: { assignment: AcademyAdminAssignment }) {
  return (
    <dl className="dk-kv" data-testid="assignment-facts">
      <dt>Brief</dt>
      <dd>{assignment.revision === 0 ? 'Not set up yet: learners see it as not released' : `Revision ${assignment.revision}`}</dd>
      {assignment.savedAt && (
        <>
          <dt>Saved</dt>
          <dd>{formatWhen(assignment.savedAt)}</dd>
        </>
      )}
      <dt>Learners who handed in</dt>
      <dd>{assignment.learnersHandedIn}</dd>
      {assignment.withdrawnAt && (
        <>
          <dt>Withdrawn</dt>
          <dd>
            <Chip tone="warn">Withdrawn {formatWhen(assignment.withdrawnAt)}</Chip> {assignment.withdrawReason}
          </dd>
        </>
      )}
    </dl>
  );
}

function BriefForm({
  assignment,
  busy,
  onSave,
}: {
  assignment: AcademyAdminAssignment;
  busy: boolean;
  onSave: (fields: Record<string, unknown>) => void;
}) {
  const brief = assignment.brief;
  const [instructions, setInstructions] = useState(brief?.instructions ?? '');
  const [points, setPoints] = useState(brief?.points ?? '');
  const [due, setDue] = useState(localInput(brief?.dueAt ?? null));
  const [text, setText] = useState<AcademyAnswerMode>(brief?.text ?? 'required');
  const [file, setFile] = useState<AcademyAnswerMode>(brief?.file ?? 'off');
  const closed = assignment.withdrawnAt !== null;
  return (
    <form
      className="dk-stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ revision: assignment.revision, instructions, points: points.trim(), dueAt: instantOf(due), text, file });
      }}
    >
      <div className="adm-field">
        <label htmlFor="assignment-instructions">Instructions</label>
        <textarea
          id="assignment-instructions"
          value={instructions}
          rows={6}
          maxLength={10_000}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </div>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="assignment-points">Points</label>
          <input id="assignment-points" inputMode="decimal" value={points} onChange={(e) => setPoints(e.target.value)} />
        </div>
        <div className="adm-field">
          <label htmlFor="assignment-due">Due</label>
          <input id="assignment-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
        <div className="adm-field">
          <label htmlFor="assignment-text">Text answer</label>
          <select id="assignment-text" value={text} onChange={(e) => setText(e.target.value as AcademyAnswerMode)}>
            {ACADEMY_ANSWER_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_WORDS[m]}
              </option>
            ))}
          </select>
        </div>
        <div className="adm-field">
          <label htmlFor="assignment-file">File answer</label>
          <select id="assignment-file" value={file} onChange={(e) => setFile(e.target.value as AcademyAnswerMode)}>
            {ACADEMY_ANSWER_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_WORDS[m]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="dk-muted">
        No due date means nothing is late. A file answer follows the owner’s upload limits; while they are blank, learners are told no file
        is taken.
      </p>
      <button type="submit" className="adm-btn" disabled={busy || closed}>
        Save assignment
      </button>
    </form>
  );
}

export function AcademyAssignmentEditor({ itemId, initial }: { itemId: string; initial: AssignmentView | null }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<AssignmentDeskReply | null>(null);
  const [reason, setReason] = useState('');

  const reload = useCallback(async () => {
    const next = await fetchAssignment(itemId);
    if (next) setView(next);
  }, [itemId]);

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    const answer = await postAssignmentChange({ itemId, ...body });
    setReply(answer);
    setBusy(false);
    // Whatever the answer, the section shows the assignment as svc-academy holds it now.
    await reload();
  };

  const part = view?.assignment;
  const assignment = part?.kind === 'ok' ? part.data : null;
  return (
    <section className="dk-stack" aria-labelledby="h-assignment" data-testid="assignment-editor">
      <h2 id="h-assignment">Assignment brief</h2>
      <span className="dk-asof">{view ? `Read ${formatAsOf(view.asOf)}` : 'No read yet'}</span>
      <Outcome reply={reply} />
      {!part && (
        <p className="dk-why">The console could not reach its own server for this assignment. Nothing is shown rather than a guess.</p>
      )}
      {part?.kind === 'failed' && <Failed title="Could not read this assignment" message={part.message} code={part.code} />}
      {assignment && (
        <>
          <Facts assignment={assignment} />
          <BriefForm
            key={assignment.revision}
            assignment={assignment}
            busy={busy}
            onSave={(fields) => void send({ op: 'save', ...fields })}
          />
          {assignment.brief && !assignment.withdrawnAt && (
            <form
              className="dk-row"
              onSubmit={(e) => {
                e.preventDefault();
                void send({ op: 'withdraw', reason });
              }}
            >
              <div className="adm-field">
                <label htmlFor="assignment-withdraw-reason">Reason to withdraw</label>
                <input id="assignment-withdraw-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
              </div>
              <button type="submit" className="adm-btn" disabled={busy}>
                Withdraw assignment
              </button>
            </form>
          )}
          {assignment.brief && (
            <ReviewSteps
              key={`review-${assignment.review?.revision ?? 0}`}
              assignment={assignment}
              busy={busy}
              onSave={(fields) => void send({ op: 'saveReview', ...fields })}
            />
          )}
        </>
      )}
    </section>
  );
}
