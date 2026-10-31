import Link from 'next/link';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { DISAGREE_WORDS, RESTORE_SERVICES, SERVICE_LABEL, STEP_LABEL, refusalWords, runHref, type RunDetail } from '@/lib/restore/model';
import type { RestoreRoom as Room } from '@/lib/restore/read';
import type { Part } from '@/lib/desk/part';
import type { RefusalView } from '@/lib/desk/refusal-copy';
import { FinalizeDesk, RecordStamp, StartRun, StepButton } from './actions';
import '../desk.css';

/**
 * The joint restore desk. Every part is svc-ops's own answer; a part that failed says why and shows no rows, so a down service never
 * reads as an empty list. svc-ops probes the archive; when it cannot be read or does not answer with a backup list, no backup is
 * listed and the reason is shown instead of a guess.
 */

function Failed({ part, testId }: { part: Extract<Part<unknown>, { kind: 'failed' }>; testId: string }) {
  return (
    <div className="adm-callout" data-tone={part.forbidden || part.notBuilt ? 'warn' : 'danger'} role="status" data-testid={testId}>
      <strong>{part.forbidden ? 'Access refused' : 'This part could not be read'}</strong>
      <p>{(part.code && refusalWords(part.code)) || part.message}</p>
      {part.code && <p className="dk-muted">Code: {part.code}</p>}
      <p className="dk-muted">Nothing is shown here rather than a guess.</p>
    </div>
  );
}

function Verdicts({ detail }: { detail: RunDetail }) {
  const { joint, reads, halt } = detail.live;
  return (
    <section className="dk-stack" aria-label="Joint watermark" data-testid="joint-watermark">
      <h3>Joint watermark at {formatWhen(joint.cutOff)}</h3>
      <p data-testid="joint-halt">
        {halt.halted
          ? 'The ledger posting freeze is on, so the services cannot write and their counts can be compared.'
          : (refusalWords(halt.code) ?? halt.message)}
      </p>
      <p data-testid="joint-verdict">
        {!halt.halted
          ? 'Not compared: the counts prove nothing while the services can still write.'
          : joint.agree
            ? 'Every service agrees with its stamp and none wrote after the cut-off.'
            : 'The services do not agree, so nothing past clean-area is allowed.'}
      </p>
      <div className="dk-table-wrap" role="region" aria-label="Services" tabIndex={0}>
        <table className="adm-table" data-testid="joint-table">
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col">Stamp</th>
              <th scope="col">Live position</th>
              <th scope="col">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {joint.services.map((s) => (
              <tr key={s.service} data-testid="joint-row">
                <td>{SERVICE_LABEL[s.service] ?? s.service}</td>
                <td>{s.stamp ?? 'None'}</td>
                <td>{s.position ?? 'Unknown'}</td>
                <td>{s.ok ? 'Agrees' : s.reason && Object.hasOwn(DISAGREE_WORDS, s.reason) ? DISAGREE_WORDS[s.reason] : 'Disagrees'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {reads
        .filter((r) => !r.ok)
        .map((r) => (
          <p key={r.service} className="dk-muted" data-testid="read-failed">
            {SERVICE_LABEL[r.service] ?? r.service} could not be read: {(r.code && refusalWords(r.code)) || r.message || 'no answer'}
          </p>
        ))}
    </section>
  );
}

function Run({ detail, userId }: { detail: RunDetail; userId: string }) {
  const { run } = detail;
  return (
    <section className="dk-stack" aria-label="Restore run" data-testid="run-detail">
      <h3>Run {run.restoreNo}</h3>
      <dl className="dk-dl">
        <dt>Cut-off</dt>
        <dd>{formatWhen(run.cutOff)}</dd>
        <dt>Started by</dt>
        <dd>{run.startedBy}</dd>
        <dt>Started</dt>
        <dd>{formatWhen(run.startedAt)}</dd>
        <dt>Restored</dt>
        <dd data-testid="restored">{detail.restored ? 'Yes, all four steps are recorded' : 'No'}</dd>
      </dl>
      <ol data-testid="steps">
        {(['restore_clean', 'validate', 'preview', 'finalize'] as const).map((s) => {
          const row = detail.steps.find((x) => x.step === s);
          return (
            <li key={s} data-testid="step-row">
              {STEP_LABEL[s]}: {row ? `recorded by ${row.actor} at ${formatWhen(row.at)}` : 'not yet'}
            </li>
          );
        })}
      </ol>
      <p className="dk-muted">Step rows record what the operator attested.</p>
      <Verdicts detail={detail} />
      {detail.next && detail.next !== 'finalize' && <StepButton restoreNo={run.restoreNo} step={detail.next} />}
      {detail.next === 'finalize' && !detail.finalizeOffered && (
        <p className="dk-muted" data-testid="finalize-parked">
          Finalize is off: the owner has not set a restore storage target, the ledger posting freeze is off, or the services do not agree.
        </p>
      )}
      {detail.finalizeOffered && <FinalizeDesk restoreNo={run.restoreNo} cutOff={run.cutOff} userId={userId} />}
    </section>
  );
}

/** Why this founder cannot send restore writes from this console: shown before the controls, which still refuse on press. */
function WritesParked({ writes }: { writes: RefusalView }) {
  return (
    <div className="adm-callout" data-tone="warn" role="status" data-testid="restore-writes-parked">
      <strong>{writes.title}</strong>
      <p>{writes.body}</p>
      <p className="dk-muted">{writes.next}</p>
      {writes.code && <p className="dk-muted">Code: {writes.code}</p>}
    </div>
  );
}

export function RestoreRoom({
  room,
  runNo,
  userId,
  writes = null,
}: {
  room: Room;
  runNo: string | null;
  userId: string;
  writes?: RefusalView | null;
}) {
  return (
    <div className="dk-stack" data-testid="restore-room">
      <h2>Joint restore</h2>
      <p className="dk-muted">
        A restore is one cut-off that the ledger, identity, bank and pay must all agree on. Each service is read live and compared with its
        own stamp. As of {formatAsOf(room.asOf)}.
      </p>
      {writes && <WritesParked writes={writes} />}

      <section className="dk-stack" aria-label="Backups">
        <h3>Backups</h3>
        {room.backups.kind === 'failed' ? (
          <Failed part={room.backups} testId="backups-failed" />
        ) : room.backups.data.backups.length === 0 ? (
          <div data-testid="backups-empty">
            <p className="dk-muted">No backup is listed. {refusalWords(room.backups.data.reason) ?? room.backups.data.reason}</p>
            <p className="dk-muted">Code: {room.backups.data.reason}</p>
          </div>
        ) : (
          <p data-testid="backups-count">{room.backups.data.backups.length} backups listed by svc-ops.</p>
        )}
      </section>

      <section className="dk-stack" aria-label="Stamps">
        <h3>Recorded stamps</h3>
        {room.stamps.kind === 'failed' ? (
          <Failed part={room.stamps} testId="stamps-failed" />
        ) : room.stamps.data.rows.length === 0 ? (
          <p className="dk-muted" data-testid="stamps-empty">
            No stamp has been recorded.
          </p>
        ) : (
          <div className="dk-table-wrap" role="region" aria-label="Stamps" tabIndex={0}>
            <table className="adm-table" data-testid="stamps-table">
              <thead>
                <tr>
                  <th scope="col">Service</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Watermark</th>
                  <th scope="col">Recorded</th>
                </tr>
              </thead>
              <tbody>
                {room.stamps.data.rows.map((r) => (
                  <tr key={`${r.service}:${r.recordedAt}`} data-testid="stamp-row">
                    <td>{SERVICE_LABEL[r.service.replace(/^svc-/, '')] ?? r.service}</td>
                    <td>{r.kind}</td>
                    <td>{r.watermark}</td>
                    <td>{formatWhen(r.recordedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="dk-muted">Services in the joint check: {RESTORE_SERVICES.map((s) => SERVICE_LABEL[s]).join(', ')}.</p>
        <RecordStamp userId={userId} />
      </section>

      <section className="dk-stack" aria-label="Runs">
        <h3>Restore runs</h3>
        {room.runs.kind === 'failed' ? (
          <Failed part={room.runs} testId="runs-failed" />
        ) : room.runs.data.length === 0 ? (
          <p className="dk-muted" data-testid="runs-empty">
            svc-ops reports no restore run.
          </p>
        ) : (
          <ul data-testid="runs-list">
            {room.runs.data.map((r) => (
              <li key={r.restoreNo} data-testid="run-item">
                <Link href={runHref(r.restoreNo)} aria-current={r.restoreNo === runNo ? 'page' : undefined}>
                  {r.restoreNo}
                </Link>{' '}
                <span className="dk-muted">cut-off {formatWhen(r.cutOff)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {room.run &&
        (room.run.kind === 'ok' ? <Run detail={room.run.data} userId={userId} /> : <Failed part={room.run} testId="run-failed" />)}

      <StartRun />
    </div>
  );
}
