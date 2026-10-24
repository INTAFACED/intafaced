'use client';

import { useState } from 'react';
import type { AcademyAdminAssignment } from '@/lib/academy/assignments-model';

/**
 * REVIEW STEPS (AC-assignments-03).
 *
 * Peer review (how many classmates' work each learner reviews), a self review, and the rubric both are scored against:
 * criteria with their levels, typed as "0, 1, 2". Saved over the revision read; other criteria are a new rubric, so a
 * review already sent keeps the criteria it was scored against. svc-academy refuses a peer step with no count on a
 * published course, and a step with no rubric, by name. The waiting list shows who is short of reviews.
 */

type Row = { name: string; levels: string };

const rowsOf = (assignment: AcademyAdminAssignment): Row[] =>
  assignment.review?.rubric?.criteria.map((c) => ({ name: c.name, levels: c.levels.join(', ') })) ?? [{ name: '', levels: '' }];

/** "0, 1, 2" as levels; blanks dropped. svc-academy checks they rise and are decimals. */
export const levelsOf = (typed: string): string[] =>
  typed
    .split(',')
    .map((level) => level.trim())
    .filter(Boolean);

export function ReviewSteps({
  assignment,
  busy,
  onSave,
}: {
  assignment: AcademyAdminAssignment;
  busy: boolean;
  onSave: (fields: Record<string, unknown>) => void;
}) {
  const review = assignment.review;
  const [peer, setPeer] = useState(review?.peer ?? false);
  const [count, setCount] = useState(review?.peerCount?.toString() ?? '');
  const [self, setSelf] = useState(review?.self ?? false);
  const [rows, setRows] = useState<Row[]>(rowsOf(assignment));
  const change = (i: number, part: Partial<Row>) => setRows((all) => all.map((row, n) => (n === i ? { ...row, ...part } : row)));
  return (
    <section className="dk-stack" aria-labelledby="h-review-steps" data-testid="assignment-review-steps">
      <h2 id="h-review-steps">Review steps</h2>
      <dl className="dk-kv">
        <dt>Steps</dt>
        <dd>{review ? `Revision ${review.revision}` : 'None saved: learners hand in for staff grading only'}</dd>
        <dt>Hand-ins short of peer reviews</dt>
        <dd>{review?.authorsShortOfReviews ?? 0}</dd>
        <dt>Waiting list (learners with no work free to review)</dt>
        <dd>{review?.reviewersWaiting ?? 0}</dd>
        <dt>Pairing</dt>
        <dd>Across the whole course. Pairing inside one cohort comes with course cohorts (AC-enrolment-04).</dd>
      </dl>
      <form
        className="dk-stack"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = count.trim();
          onSave({
            revision: review?.revision ?? 0,
            peer,
            peerCount: trimmed === '' ? null : /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed,
            self,
            criteria: rows.filter((row) => row.name.trim() || row.levels.trim()).map((row) => ({ name: row.name.trim(), levels: levelsOf(row.levels) })),
          });
        }}
      >
        <div className="dk-row">
          <label className="adm-field">
            <span>
              <input type="checkbox" checked={peer} onChange={(e) => setPeer(e.target.checked)} /> Peer review
            </span>
          </label>
          <div className="adm-field">
            <label htmlFor="review-peer-count">Reviews each learner gives</label>
            <input id="review-peer-count" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
          </div>
          <label className="adm-field">
            <span>
              <input type="checkbox" checked={self} onChange={(e) => setSelf(e.target.checked)} /> Self review
            </span>
          </label>
        </div>
        <fieldset className="dk-stack">
          <legend>Rubric</legend>
          {rows.map((row, i) => (
            <div className="dk-row" key={i}>
              <div className="adm-field">
                <label htmlFor={`review-criterion-${i}`}>Criterion {i + 1}</label>
                <input id={`review-criterion-${i}`} value={row.name} maxLength={120} onChange={(e) => change(i, { name: e.target.value })} />
              </div>
              <div className="adm-field">
                <label htmlFor={`review-criterion-${i}-levels`}>Criterion {i + 1} levels</label>
                <input
                  id={`review-criterion-${i}-levels`}
                  value={row.levels}
                  placeholder="0, 1, 2"
                  onChange={(e) => change(i, { levels: e.target.value })}
                />
              </div>
              {rows.length > 1 && (
                <button type="button" className="adm-btn" onClick={() => setRows((all) => all.filter((_, n) => n !== i))}>
                  Remove criterion {i + 1}
                </button>
              )}
            </div>
          ))}
          <button type="button" className="adm-btn" disabled={rows.length >= 20} onClick={() => setRows((all) => [...all, { name: '', levels: '' }])}>
            Add criterion
          </button>
        </fieldset>
        <p className="dk-muted">
          Learners review after handing in, never their own work as a peer, and wait while no classmate&apos;s work is free. Changing
          the criteria makes a new rubric; reviews already sent keep the one they were scored against.
        </p>
        <button type="submit" className="adm-btn" disabled={busy}>
          Save review steps
        </button>
      </form>
    </section>
  );
}
