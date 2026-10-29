import Link from 'next/link';
import type { OpsAlert, OpsAlertDetail, OpsAlertSource } from '@intafaced/contracts/ops-reconciliation-alerts';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import type { Part } from '@/lib/desk/part';
import { NOTICE_WORDS, refusalWords } from '@/lib/recon-alerts/model';
import type { AlertsRoom as Room } from '@/lib/recon-alerts/read';
import { AlertActions } from './actions';
import '../desk.css';

/**
 * Reconciliation alerts (OPS-reconciliation-03). svc-ops raises one alert per control, failing asset and period from the ledger's
 * settled evaluations and counts every repeat. Each part is svc-ops's own answer; a failed part says why and lists nothing, and a
 * failed ledger read shows as the source, never as an empty list.
 */

function Failed({ part, testId }: { part: Extract<Part<unknown>, { kind: 'failed' }>; testId: string }) {
  return (
    <div className="adm-callout" data-tone={part.forbidden || part.notBuilt ? 'warn' : 'danger'} role="status" data-testid={testId}>
      <strong>{part.forbidden ? 'Access refused' : 'This part could not be read'}</strong>
      <p>{(part.code && refusalWords(part.code)) || part.message}</p>
      {part.code && (
        <p className="dk-muted" data-testid={`${testId}-code`}>
          Code: {part.code}
        </p>
      )}
      <p className="dk-muted">Nothing is shown here rather than a guess.</p>
    </div>
  );
}

export function Source({ source }: { source: OpsAlertSource }) {
  if (source.status === 'ok') {
    return (
      <p className="dk-muted" data-testid="alert-source" data-status="ok">
        Ledger evaluations last read {formatWhen(source.readAt)}.
      </p>
    );
  }
  if (source.status === 'never_read') {
    return (
      <div className="adm-callout" data-tone="warn" role="status" data-testid="alert-source" data-status="never_read">
        <strong>The ledger&apos;s evaluations have not been read yet.</strong>
        <p>No alert is listed until svc-ops has read them; an empty list here does not mean nothing failed.</p>
      </div>
    );
  }
  return (
    <div className="adm-callout" data-tone="danger" role="status" data-testid="alert-source" data-status="unavailable">
      <strong>svc-ops could not read the ledger&apos;s evaluations.</strong>
      <p>{source.message}</p>
      <p className="dk-muted">
        Code: <span data-testid="alert-source-code">{source.code}</span> · since {formatWhen(source.since)} · last read{' '}
        {source.lastOkAt ? formatWhen(source.lastOkAt) : 'never'}
      </p>
    </div>
  );
}

const severityLabel = (a: OpsAlert): string => (a.severity.status === 'set' ? a.severity.value : 'unset');

const assetLabel = (a: OpsAlert): string => a.assetId ?? 'No asset (the run failed without asset evidence)';

export function AlertsRoom({ room }: { room: Room }) {
  return (
    <section className="dk-stack" aria-label="Reconciliation alerts" data-testid="recon-alerts">
      <h2>Reconciliation alerts</h2>
      <p className="dk-muted">Read {formatAsOf(room.asOf)}. One alert per control, failing asset and period; a repeat raises its count.</p>
      {room.list.kind === 'failed' ? (
        <Failed part={room.list} testId="alerts-failed" />
      ) : (
        <>
          <Source source={room.list.data.source} />
          {room.list.data.alerts.length === 0 ? (
            <p data-testid="alerts-empty">No alert is stored.</p>
          ) : (
            <div className="dk-table-wrap" role="region" aria-label="Alerts" tabIndex={0}>
              <table className="adm-table" data-testid="alerts-table">
                <thead>
                  <tr>
                    <th scope="col">Asset</th>
                    <th scope="col">Control</th>
                    <th scope="col">Period</th>
                    <th scope="col">State</th>
                    <th scope="col">Severity</th>
                    <th scope="col">Count</th>
                    <th scope="col">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {room.list.data.alerts.map((a) => (
                    <tr
                      key={a.id}
                      data-testid="alert-row"
                      data-alert-id={a.id}
                      data-control-id={a.controlId}
                      data-asset={a.assetId ?? ''}
                      data-state={a.state}
                      data-occurrences={a.occurrences}
                      data-period-start={a.periodStart}
                    >
                      <td>
                        <Link href={`/ledger/alerts/${a.id}`}>{assetLabel(a)}</Link>
                      </td>
                      <td>{a.controlId}</td>
                      <td>
                        {formatWhen(a.periodStart)} to {formatWhen(a.periodEnd)}
                      </td>
                      <td>{a.snooze ? `${a.state}, snoozed` : a.state}</td>
                      <td>{severityLabel(a)}</td>
                      <td>{a.occurrences}</td>
                      <td>{formatWhen(a.lastSeen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {room.list.data.next && (
            <p>
              <Link href={`/ledger/alerts?after=${encodeURIComponent(`${room.list.data.next.lastSeen}|${room.list.data.next.id}`)}`}>
                Older alerts
              </Link>
            </p>
          )}
        </>
      )}
      <h3>Periods</h3>
      {room.periods.kind === 'failed' ? (
        <Failed part={room.periods} testId="periods-failed" />
      ) : room.periods.data.periods.length === 0 ? (
        <p data-testid="periods-empty">No period has been evaluated.</p>
      ) : (
        <div className="dk-table-wrap" role="region" aria-label="Periods" tabIndex={0}>
          <table className="adm-table" data-testid="periods-table">
            <thead>
              <tr>
                <th scope="col">Control</th>
                <th scope="col">Period</th>
                <th scope="col">Last result</th>
                <th scope="col">Open</th>
                <th scope="col">Acknowledged</th>
                <th scope="col">Green</th>
              </tr>
            </thead>
            <tbody>
              {room.periods.data.periods.map((p) => (
                <tr
                  key={`${p.controlId}:${p.periodStart}`}
                  data-testid="period-row"
                  data-control-id={p.controlId}
                  data-period-start={p.periodStart}
                  data-green={String(p.green)}
                  data-status={p.lastStatus}
                >
                  <td>{p.controlId}</td>
                  <td>
                    {formatWhen(p.periodStart)} to {formatWhen(p.periodEnd)}
                  </td>
                  <td>{p.lastStatus}</td>
                  <td>{p.open}</td>
                  <td>{p.acknowledged}</td>
                  <td>{p.green ? 'Green' : 'Not green'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Notices({ alert }: { alert: OpsAlert }) {
  const n = alert.notices;
  return (
    <section className="dk-stack" aria-label="Notices" data-testid="alert-notices" data-sent={n.sent}>
      <h3>Notices</h3>
      <p>
        In-console notices sent: {n.sent}
        {n.lastSentAt ? `, last ${formatWhen(n.lastSentAt)}` : ''}.
      </p>
      <p data-testid="alert-repeat" data-status={n.repeat.status}>
        {n.repeat.status === 'set'
          ? `Repeat every ${n.repeat.seconds} seconds${n.repeat.nextDueAt ? `; next due ${formatWhen(n.repeat.nextDueAt)}` : ''}.`
          : `No repeat interval is set (${n.repeat.code}); a repeat failure sends no notice.`}
      </p>
      <p className="dk-muted" data-testid="alert-outside">
        Email and push notices are not built: {n.outside.email}, {n.outside.push}.
      </p>
    </section>
  );
}

export function AlertDetail({ part }: { part: Part<OpsAlertDetail> }) {
  if (part.kind === 'failed') return <Failed part={part} testId="alert-failed" />;
  const { alert, timeline, snoozes, source } = part.data;
  const ev = alert.evidence;
  return (
    <section
      className="dk-stack"
      aria-label="Alert"
      data-testid="alert-detail"
      data-state={alert.state}
      data-occurrences={alert.occurrences}
      data-version={alert.version}
      data-snoozed={String(alert.snooze !== null)}
    >
      <Source source={source} />
      <h2>
        {assetLabel(alert)} · {alert.state}
      </h2>
      <dl className="dk-stack">
        <div>
          <dt>Control</dt>
          <dd>{alert.controlId}</dd>
        </div>
        <div>
          <dt>Period</dt>
          <dd>
            {formatWhen(alert.periodStart)} to {formatWhen(alert.periodEnd)}
          </dd>
        </div>
        <div>
          <dt>Severity</dt>
          <dd>{severityLabel(alert)}</dd>
        </div>
        <div>
          <dt>Count</dt>
          <dd data-testid="alert-occurrences">{alert.occurrences}</dd>
        </div>
        <div>
          <dt>First and last seen</dt>
          <dd>
            {formatWhen(alert.firstSeen)} · {formatWhen(alert.lastSeen)}
          </dd>
        </div>
      </dl>
      <h3>Latest failing evaluation</h3>
      <p>
        Run {ev.run.id} · {ev.run.status} · finished {formatWhen(ev.finishedAt)}
      </p>
      {ev.asset ? (
        <p data-testid="alert-evidence">
          Observed {ev.asset.observed} · expected {ev.asset.expected} · difference {ev.asset.difference} · tolerance {ev.asset.tolerance}
        </p>
      ) : (
        <p data-testid="alert-evidence">The run failed with no asset evidence to name.</p>
      )}
      {alert.acknowledged && (
        <p data-testid="alert-acknowledged" data-by={alert.acknowledged.by}>
          Acknowledged by {alert.acknowledged.by} at {formatWhen(alert.acknowledged.at)}: {alert.acknowledged.note}
        </p>
      )}
      {alert.snooze && (
        <p data-testid="alert-snooze">
          Notices snoozed until {formatWhen(alert.snooze.endsAt)} by {alert.snooze.by}. The alert still counts every failure.
        </p>
      )}
      <AlertActions alertId={alert.id} version={alert.version} state={alert.state} snoozed={alert.snooze !== null} />
      <Notices alert={alert} />
      <h3>Timeline</h3>
      <ol data-testid="alert-timeline">
        {timeline.map((t) => (
          <li key={t.id} data-testid="timeline-entry" data-kind={t.kind} data-notice={t.notice ?? ''}>
            {formatWhen(t.at)} · {t.kind} · {t.actor}
            {t.notice ? ` · ${NOTICE_WORDS[t.notice] ?? t.notice}` : ''}
            {t.note ? ` · ${t.note}` : ''}
          </li>
        ))}
      </ol>
      <h3>Snoozes</h3>
      {snoozes.length === 0 ? (
        <p>None.</p>
      ) : (
        <ul data-testid="alert-snoozes">
          {snoozes.map((s) => (
            <li key={s.id} data-testid="snooze-entry" data-expired={String(s.expiredAt !== null)}>
              {formatWhen(s.startsAt)} to {formatWhen(s.endsAt)} by {s.by}
              {s.reason ? ` · ${s.reason}` : ''}
              {s.expiredAt ? ` · ended ${formatWhen(s.expiredAt)}` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
