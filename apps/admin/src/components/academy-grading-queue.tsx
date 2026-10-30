'use client';

import { useCallback, useState } from 'react';
import { Chip } from '@/components/chip';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchGradingQueue, postGradingChange } from '@/lib/academy/grading-browser';
import type {
  AcademyBulkGradeResult,
  AcademyGradingQueue,
  AcademyGradingRow,
  GradingDeskReply,
  GradingView,
} from '@/lib/academy/grading-model';
import { Failed, Outcome } from '@/components/academy-courses-desk';

/**
 * GRADING QUEUE (AC-assignments-02).
 *
 * Each learner's newest hand-in under an alias ("Learner 2"), never their name, with the peer reviews it received and its
 * grade. Grade takes this founder's hold on the hand-in for the owner's hold time; another founder's live hold shows
 * here and refuses by name. Save grade writes the next grade event; changing a saved grade is an override and keeps a
 * reason. Every answer re-reads the queue, and nothing is retried on its own.
 *
 * Bulk grade takes a CSV file by alias (learner,score,comment,reason): the good rows are graded, every bad row is listed
 * with its line and why, and the same file again changes nothing.
 */

const BULK_MAX_CHARS = 262_144;

function BulkGrade({ busy, onUpload }: { busy: boolean; onUpload: (fileName: string, csv: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  return (
    <form
      className="dk-stack"
      data-testid="bulk-grade"
      onSubmit={(e) => {
        e.preventDefault();
        if (!file) return setWhy('Choose a grade file first.');
        void file.text().then((csv) => {
          if (csv.length > BULK_MAX_CHARS) return setWhy(`A grade file runs to ${BULK_MAX_CHARS} characters. Nothing was sent.`);
          setWhy(null);
          onUpload(file.name, csv);
        });
      }}
    >
      <h2>Bulk grade</h2>
      <p className="dk-muted">
        A CSV file whose first line is learner,score,comment,reason, one row per learner by alias (Learner 3). A row that
        changes a grade needs a reason. The same file again changes nothing.
      </p>
      <div className="adm-field">
        <label htmlFor="bulk-grade-file">Grade file (CSV)</label>
        <input id="bulk-grade-file" type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      {why && <p className="dk-why">{why}</p>}
      <button type="submit" className="adm-btn" disabled={busy}>
        Upload grades
      </button>
    </form>
  );
}

function BulkResult({ result }: { result: AcademyBulkGradeResult }) {
  return (
    <section className="dk-stack" data-testid="bulk-grade-result" data-sha256={result.sha256} data-repeated={String(result.repeated)}>
      <h3>
        {result.fileName}: {result.applied.length} graded, {result.rejected.length} not applied
      </h3>
      <span className="dk-muted">
        {result.repeated ? 'Uploaded before, at ' : 'Read at '}
        {formatWhen(result.at)} · sha256 {result.sha256}
      </span>
      <div className="dk-table-wrap" role="region" aria-label="Grade file rows" tabIndex={0}>
      <table className="adm-table">
        <thead>
          <tr>
            <th scope="col">Line</th>
            <th scope="col">Learner</th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {[
            ...result.applied.map((row) => ({ line: row.line, alias: row.alias, ok: true, text: `Graded ${row.score}` })),
            ...result.rejected.map((row) => ({ line: row.line, alias: row.alias, ok: false, text: row.message })),
          ]
            .sort((a, b) => a.line - b.line)
            .map((row) => (
              <tr key={row.line} data-line={row.line} data-outcome={row.ok ? 'applied' : 'rejected'}>
                <td>{row.line}</td>
                <td>{row.alias === null ? '—' : `Learner ${row.alias}`}</td>
                <td>{row.ok ? row.text : `Not applied: ${row.text}`}</td>
              </tr>
            ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}

type Filter = 'all' | 'ungraded' | 'graded' | 'late';
const FILTERS: Record<Filter, string> = { all: 'All', ungraded: 'Ungraded', graded: 'Graded', late: 'Late' };
const shown = (row: AcademyGradingRow, filter: Filter) =>
  filter === 'all' || (filter === 'ungraded' ? !row.grade : filter === 'graded' ? row.grade !== null : row.late);

function GradeForm({
  row,
  points,
  busy,
  onSave,
}: {
  row: AcademyGradingRow;
  points: string;
  busy: boolean;
  onSave: (fields: Record<string, unknown>) => void;
}) {
  const [score, setScore] = useState(row.grade?.score ?? '');
  const [comment, setComment] = useState(row.grade?.comment ?? '');
  const [reason, setReason] = useState('');
  const override = row.grade !== null;
  return (
    <form
      className="dk-stack"
      data-testid="grade-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          submissionId: row.submissionId,
          n: row.nextN,
          score: score.trim(),
          comment: comment.trim() || null,
          reason: override ? reason.trim() || null : null,
        });
      }}
    >
      <h3>Grade Learner {row.alias}</h3>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="grade-score">Score</label>
          <input id="grade-score" inputMode="decimal" value={score} onChange={(e) => setScore(e.target.value)} />
        </div>
        <span className="dk-muted">of {points} points</span>
      </div>
      <div className="adm-field">
        <label htmlFor="grade-comment">Comment</label>
        <textarea id="grade-comment" rows={4} maxLength={5000} value={comment} onChange={(e) => setComment(e.target.value)} />
      </div>
      {override && (
        <div className="adm-field">
          <label htmlFor="grade-reason">Reason for changing the grade</label>
          <input id="grade-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
      <p className="dk-muted">The learner sees the score and comment once saved, never who graded.</p>
      <button type="submit" className="adm-btn" disabled={busy}>
        Save grade
      </button>
    </form>
  );
}

function Row({ row, busy, onGrade }: { row: AcademyGradingRow; busy: boolean; onGrade: () => void }) {
  return (
    <li className="dk-stack" data-grading-row={row.submissionId}>
      <strong>
        Learner {row.alias} · version {row.version}
      </strong>
      <span className="dk-muted">
        Handed in {formatWhen(row.submittedAt)} {row.late && <Chip tone="warn">Late</Chip>}
      </span>
      {row.text && <p style={{ whiteSpace: 'pre-wrap' }}>{row.text}</p>}
      {row.file && (
        <p>
          File: {row.file.fileName} ({row.file.contentType}, {row.file.bytes} bytes)
        </p>
      )}
      <p className="dk-muted">
        Peer reviews received: {row.peerReviews.received}
        {row.peerReviews.meanTotal !== null && `, mean rubric total ${row.peerReviews.meanTotal}`}
      </p>
      <p>
        {row.grade
          ? `Graded ${row.grade.score} on ${formatWhen(row.grade.gradedAt)}${row.grade.overrides ? ` (changed ${row.grade.overrides} time${row.grade.overrides === 1 ? '' : 's'})` : ''}`
          : 'Not graded'}
        {row.grade?.comment && ` · ${row.grade.comment}`}
      </p>
      {row.lease && !row.lease.mine && <Chip tone="warn">Another grader holds it until {formatWhen(row.lease.expiresAt)}</Chip>}
      <button type="button" className="adm-btn" disabled={busy || (row.lease !== null && !row.lease.mine)} onClick={onGrade}>
        {row.grade ? 'Change grade' : 'Grade'}
      </button>
    </li>
  );
}

export function AcademyGradingQueue({ itemId, initial }: { itemId: string; initial: GradingView | null }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<GradingDeskReply | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [bulk, setBulk] = useState<AcademyBulkGradeResult | null>(null);

  const reload = useCallback(async () => {
    const next = await fetchGradingQueue(itemId);
    if (next) setView(next);
  }, [itemId]);

  const send = async (body: Record<string, unknown>): Promise<GradingDeskReply> => {
    setBusy(true);
    const answer = await postGradingChange({ itemId, ...body });
    setReply(answer);
    setBusy(false);
    // Whatever the answer, the queue shows the hand-ins as svc-academy holds them now.
    if (answer.ok) setView({ queue: { kind: 'ok', data: answer.queue }, asOf: new Date().toISOString() });
    if (answer.ok && answer.bulk) setBulk(answer.bulk);
    else await reload();
    return answer;
  };

  const part = view?.queue;
  const queue: AcademyGradingQueue | null = part?.kind === 'ok' ? part.data : null;
  const selected = queue?.rows.find((row) => row.submissionId === open) ?? null;
  return (
    <section className="dk-stack" aria-labelledby="h-grading" data-testid="grading-queue">
      <h1 id="h-grading">{queue ? `Grade: ${queue.title}` : 'Grade hand-ins'}</h1>
      <span className="dk-asof">{view ? `Read ${formatAsOf(view.asOf)}` : 'No read yet'}</span>
      <Outcome reply={reply && (reply.ok ? { ok: true, what: reply.what } : reply)} />
      {!part && <p className="dk-why">The console could not reach its own server for this queue. Nothing is shown rather than a guess.</p>}
      {part?.kind === 'failed' && <Failed title="Could not read the grading queue" message={part.message} code={part.code} />}
      {queue && (
        <>
          <dl className="dk-kv">
            <dt>Points</dt>
            <dd>{queue.points}</dd>
            <dt>Grader hold</dt>
            <dd>
              {queue.leaseSeconds === null
                ? 'Not set: the owner sets it, and nothing is graded until then'
                : `${queue.leaseSeconds} seconds`}
            </dd>
            <dt>Learners</dt>
            <dd>Shown by alias, in the order they first handed in. Names stay hidden while grading.</dd>
          </dl>
          <div className="dk-row" role="group" aria-label="Show">
            {(Object.keys(FILTERS) as Filter[]).map((f) => (
              <button key={f} type="button" className="adm-btn" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {FILTERS[f]}
              </button>
            ))}
          </div>
          {queue.rows.length === 0 ? (
            <p className="dk-muted">Nobody has handed in yet, so there is nothing to grade.</p>
          ) : (
            <ol className="dk-stack">
              {queue.rows
                .filter((row) => shown(row, filter))
                .map((row) => (
                  <Row
                    key={row.submissionId}
                    row={row}
                    busy={busy}
                    onGrade={() =>
                      void send({ op: 'open', submissionId: row.submissionId }).then((answer) =>
                        setOpen(answer.ok ? row.submissionId : null),
                      )
                    }
                  />
                ))}
            </ol>
          )}
          {selected && (
            <GradeForm
              key={`${selected.submissionId}:${selected.nextN}`}
              row={selected}
              points={queue.points}
              busy={busy}
              onSave={(fields) => void send({ op: 'grade', ...fields }).then((answer) => answer.ok && setOpen(null))}
            />
          )}
          {queue.rows.length > 0 && <BulkGrade busy={busy} onUpload={(fileName, csv) => void send({ op: 'bulk', fileName, csv })} />}
          {bulk && <BulkResult result={bulk} />}
        </>
      )}
    </section>
  );
}
