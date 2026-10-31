'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchGradebook, postGradebookChange } from '@/lib/academy/gradebook-browser';
import type { AcademyCourseGradebook, AcademyGradeReport, GradebookDeskReply, GradebookView } from '@/lib/academy/gradebook-model';
import { Failed, Outcome } from '@/components/academy-courses-desk';

/**
 * GRADEBOOK (AC-assignments-04, first part).
 *
 * The grading policy groups the course's assignments and quizzes into types, each with a decimal weight (all weights add
 * up to exactly 1, or svc-academy refuses and names the sum) and how many of its lowest scores to drop. The table shows
 * each enrolled learner's score per item as a fraction (0.65 is 65 percent), "not attempted" or "pending" where there is
 * none (never a zero), each type's average after the lowest are dropped, and the weighted total of the types they have a
 * score in. Every figure comes from svc-academy, cut at 18 places, never rounded here. A grade report is a stored
 * snapshot of the table with the time it was made and its SHA-256; downloading one serves that snapshot. The late policy
 * (ENGINE GR-5) is staff's own: grace hours, then a share of the points off for each started day late; a late cell shows
 * its score with the entered grade beside it. Blank values are refused, never filled in. Grading scales and periods are
 * later parts.
 */

type Item = AcademyCourseGradebook['items'][number];
type DraftType = { name: string; weight: string; dropLowest: string; itemIds: string[] };

/** The stored policy as the form holds it; an item no longer gradable (removed, or now a survey) has no box, so it is left out. */
const draftOf = (book: AcademyCourseGradebook): DraftType[] => {
  const gradable = new Set(book.items.map((i) => i.itemId));
  return book.policy
    ? book.policy.types.map((t) => ({
        name: t.name,
        weight: t.weight,
        dropLowest: String(t.dropLowest),
        itemIds: t.itemIds.filter((id) => gradable.has(id)),
      }))
    : [{ name: '', weight: '', dropLowest: '0', itemIds: [] }];
};

function PolicyForm({
  book,
  busy,
  onSave,
}: {
  book: AcademyCourseGradebook;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const [types, setTypes] = useState<DraftType[]>(draftOf(book));
  const [reason, setReason] = useState('');
  const set = (i: number, patch: Partial<DraftType>) => setTypes((now) => now.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <form
      className="dk-stack"
      data-testid="grading-policy"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          revision: book.policy?.revision ?? 0,
          // A blank drop count is never read as 0: it is sent blank and the console refuses the request as incomplete.
          types: types.map((t) => ({
            name: t.name,
            weight: t.weight.trim(),
            dropLowest: t.dropLowest.trim() === '' ? null : Number(t.dropLowest.trim()),
            itemIds: t.itemIds,
          })),
          reason,
        });
      }}
    >
      {types.map((t, i) => (
        <fieldset key={i} className="dk-stack" data-testid="grade-type">
          <legend>Type {i + 1}</legend>
          <div className="dk-row">
            <label>
              Name
              <input value={t.name} onChange={(e) => set(i, { name: e.target.value })} aria-label={`Type ${i + 1} name`} />
            </label>
            <label>
              Weight
              <input
                value={t.weight}
                onChange={(e) => set(i, { weight: e.target.value })}
                inputMode="decimal"
                placeholder="0.4"
                aria-label={`Type ${i + 1} weight`}
              />
            </label>
            <label>
              Drop lowest
              <input
                type="number"
                min={0}
                step={1}
                value={t.dropLowest}
                onChange={(e) => set(i, { dropLowest: e.target.value })}
                aria-label={`Type ${i + 1} drop lowest`}
              />
            </label>
            <button
              type="button"
              className="adm-btn"
              disabled={types.length === 1}
              onClick={() => setTypes((now) => now.filter((_, j) => j !== i))}
            >
              Remove type {i + 1}
            </button>
          </div>
          <div className="dk-row">
            {book.items.map((item: Item) => (
              <label key={item.itemId}>
                <input
                  type="checkbox"
                  checked={t.itemIds.includes(item.itemId)}
                  onChange={(e) =>
                    set(i, { itemIds: e.target.checked ? [...t.itemIds, item.itemId] : t.itemIds.filter((id) => id !== item.itemId) })
                  }
                  aria-label={`Type ${i + 1} holds ${item.title}`}
                />{' '}
                {item.title} <span className="dk-muted">({item.kind})</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="dk-row">
        <button
          type="button"
          className="adm-btn"
          onClick={() => setTypes((now) => [...now, { name: '', weight: '', dropLowest: '0', itemIds: [] }])}
        >
          Add type
        </button>
        <label>
          Reason
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} aria-label="Policy reason" />
        </label>
        <button type="submit" className="adm-btn" disabled={busy}>
          Save grading policy
        </button>
      </div>
    </form>
  );
}

/** The late policy as staff enter it. Blank values are sent blank, so the console refuses them rather than guessing. */
function LatePolicyForm({
  book,
  busy,
  onSave,
}: {
  book: AcademyCourseGradebook;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const now = book.latePolicy?.policy ?? null;
  const [grace, setGrace] = useState(now?.graceHours ?? '');
  const [deduction, setDeduction] = useState(now?.deductionPerDay ?? '');
  const [reason, setReason] = useState('');
  const revision = book.latePolicy?.revision ?? 0;
  return (
    <form
      className="dk-row"
      data-testid="late-policy"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ revision, policy: { graceHours: grace.trim(), deductionPerDay: deduction.trim() }, reason });
      }}
    >
      <label>
        Grace hours
        <input value={grace} onChange={(e) => setGrace(e.target.value)} inputMode="decimal" placeholder="24" aria-label="Grace hours" />
      </label>
      <label>
        Deduction per day
        <input
          value={deduction}
          onChange={(e) => setDeduction(e.target.value)}
          inputMode="decimal"
          placeholder="0.1"
          aria-label="Deduction per day"
        />
      </label>
      <label>
        Reason
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} aria-label="Late policy reason" />
      </label>
      <button type="submit" className="adm-btn" disabled={busy}>
        Save late policy
      </button>
      <button type="button" className="adm-btn" disabled={busy || now === null} onClick={() => onSave({ revision, policy: null, reason })}>
        Clear late policy
      </button>
    </form>
  );
}

function Table({ book }: { book: AcademyCourseGradebook }) {
  const titleOf = (id: string) => book.items.find((i) => i.itemId === id)?.title ?? id;
  if (book.learners.length === 0)
    return (
      <p className="dk-muted" data-testid="gradebook-empty">
        No learner is enrolled yet, so there is no row to show.
      </p>
    );
  return (
    <div className="dk-table-wrap">
      <table className="adm-table" data-testid="gradebook">
        <thead>
          <tr>
            <th>Learner</th>
            {book.items.map((i) => (
              <th key={i.itemId}>{i.title}</th>
            ))}
            {book.policy?.types.map((t) => (
              <th key={t.name}>
                {t.name} ({t.weight})
              </th>
            ))}
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {book.learners.map((l) => (
            <tr key={l.userId} data-learner={l.userId}>
              <td>
                <code>{l.userId}</code>
              </td>
              {l.items.map((c) => (
                <td key={c.itemId} data-state={c.state}>
                  {c.state === 'graded' ? c.score : c.state === 'pending' ? 'pending' : 'not attempted'}
                  {c.entered !== null && <span className="dk-muted"> (late; entered {c.entered})</span>}
                </td>
              ))}
              {l.types.map((t) => (
                <td key={t.name} data-type={t.name}>
                  {t.average ?? 'not attempted'}
                  {t.dropped.length > 0 && <span className="dk-muted"> (dropped {t.dropped.map(titleOf).join(', ')})</span>}
                </td>
              ))}
              <td data-testid="gradebook-total">{l.total ?? (book.policy ? 'not attempted' : 'no policy yet')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The stored reports. A new one takes the next number, so a retried click answers the report it made. */
function Reports({
  courseId,
  reports,
  busy,
  onMake,
}: {
  courseId: string;
  reports: readonly AcademyGradeReport[];
  busy: boolean;
  onMake: (n: number) => void;
}) {
  const next = (reports[0]?.n ?? 0) + 1;
  return (
    <div className="dk-stack" data-testid="grade-reports">
      <div className="dk-row">
        <button type="button" className="adm-btn" disabled={busy} onClick={() => onMake(next)}>
          Make grade report {next}
        </button>
      </div>
      {reports.length === 0 ? (
        <p className="dk-muted" data-testid="grade-reports-empty">
          No report yet. A report stores the gradebook as it reads when you make it.
        </p>
      ) : (
        <table className="adm-table">
          <thead>
            <tr>
              <th>Report</th>
              <th>Made</th>
              <th>Learners</th>
              <th>SHA-256</th>
              <th>File</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => (
              <tr key={r.n} data-report={r.n}>
                <td>{r.n}</td>
                <td data-testid="report-made-at" data-at={r.madeAt}>
                  {formatWhen(r.madeAt)}
                </td>
                <td>{r.rows}</td>
                <td>
                  <code data-testid="report-sha256">{r.sha256}</code>
                </td>
                <td>
                  <a href={`/api/academy-gradebook?courseId=${encodeURIComponent(courseId)}&report=${r.n}`} download>
                    Download report {r.n}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function AcademyGradebook({ courseId, initial }: { courseId: string; initial: GradebookView | null }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<GradebookDeskReply | null>(null);

  const reload = useCallback(async () => {
    const next = await fetchGradebook(courseId);
    if (next) setView(next);
  }, [courseId]);

  const send = async (op: 'savePolicy' | 'saveLatePolicy' | 'makeReport', body: Record<string, unknown>) => {
    setBusy(true);
    const answer = await postGradebookChange({ op, courseId, ...body });
    setReply(answer);
    setBusy(false);
    // Whatever the answer, the page shows the gradebook as svc-academy holds it now; a refused form keeps what was typed.
    await reload();
  };

  const part = view?.gradebook;
  const book = part?.kind === 'ok' ? part.data : null;
  return (
    <div className="dk" data-testid="academy-gradebook">
      <div className="adm-pagehead">
        <div>
          <h1>Gradebook</h1>
          <p>
            <Link href={`/academy-ops/catalogue/courses/${courseId}`}>Back to the course</Link>
          </p>
        </div>
        <span className="dk-asof">{view ? `Read ${formatAsOf(view.asOf)}` : 'No read yet'}</span>
      </div>
      <Outcome reply={reply} />
      {!part && <p className="dk-why">The console could not reach its own server for this course. Nothing is shown rather than a guess.</p>}
      {part?.kind === 'failed' && <Failed title="Could not read the gradebook" message={part.message} code={part.code} />}
      {book && (
        <>
          <section className="dk-stack" aria-labelledby="h-policy">
            <h2 id="h-policy">Grading policy</h2>
            <p className="dk-muted" data-testid="policy-now">
              {book.policy
                ? `Revision ${book.policy.revision}, set ${formatWhen(book.policy.setAt)}: ${book.policy.reason}`
                : 'No policy yet: the weights add up to exactly 1 once saved.'}
            </p>
            {book.items.length === 0 ? (
              <p className="dk-muted">The course has no assignment with a brief or graded quiz yet.</p>
            ) : (
              <PolicyForm key={book.policy?.revision ?? 0} book={book} busy={busy} onSave={(b) => void send('savePolicy', b)} />
            )}
          </section>
          <section className="dk-stack" aria-labelledby="h-late">
            <h2 id="h-late">Late policy</h2>
            <p className="dk-muted" data-testid="late-policy-now">
              {book.latePolicy?.policy
                ? `Revision ${book.latePolicy.revision}: ${book.latePolicy.policy.graceHours} hours of grace after the due date, then ${book.latePolicy.policy.deductionPerDay} of the points off for each started day late. Set ${formatWhen(book.latePolicy.setAt)}: ${book.latePolicy.reason}`
                : 'Not set: nothing is taken off a late hand-in.'}
            </p>
            <LatePolicyForm key={book.latePolicy?.revision ?? 0} book={book} busy={busy} onSave={(b) => void send('saveLatePolicy', b)} />
          </section>
          <section className="dk-stack" aria-labelledby="h-gradebook">
            <h2 id="h-gradebook">Learners</h2>
            <Table book={book} />
          </section>
          <section className="dk-stack" aria-labelledby="h-reports">
            <h2 id="h-reports">Grade reports</h2>
            {view?.reports.kind === 'ok' ? (
              <Reports courseId={courseId} reports={view.reports.data.reports} busy={busy} onMake={(n) => void send('makeReport', { n })} />
            ) : (
              <Failed title="Could not read the grade reports" message={view?.reports.message ?? ''} code={view?.reports.code ?? null} />
            )}
          </section>
        </>
      )}
    </div>
  );
}
