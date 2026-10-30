import Link from 'next/link';
import type { OpsAlert, OpsAlertDetail, OpsAlertSource, OpsPlatformIncidents } from '@intafaced/contracts/ops-reconciliation-alerts';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import type { Part } from '@/lib/desk/part';
import type { RefusalView } from '@/lib/desk/refusal-copy';
import { NOTICE_WORDS, TEAM_WORDS, closeBlocked, refusalWords } from '@/lib/recon-alerts/model';
import type { AlertsRoom as Room } from '@/lib/recon-alerts/read';
import { AlertAccept } from './accept';
import { AlertActions } from './actions';
import '../desk.css';

/**
 * Reconciliation alerts (OPS-reconciliation-03, -04). svc-ops raises one alert per control, failing asset, period and cause from the
 * ledger's settled evaluations and counts every repeat: a FAIL goes to finance, a run that could not finish to the platform team. Each part is svc-ops's own answer; a failed part says why and lists nothing, and a
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

const assetLabel = (a: OpsAlert): string =>
  a.assetId ?? (a.cause === 'error' ? 'No asset (the run could not finish)' : 'No asset (the run failed without asset evidence)');

function PlatformIncidents({ part }: { part: Part<OpsPlatformIncidents> }) {
  if (part.kind === 'failed') return <Failed part={part} testId="platform-incidents-failed" />;
  const { bus, incidents } = part.data;
  return (
    <section className="dk-stack" aria-label="Platform incidents" data-testid="platform-incidents" data-bus={bus}>
      {bus === 'detached' && (
        <div className="adm-callout" data-tone="warn" role="status" data-testid="platform-incidents-detached">
          <strong>svc-ops is not attached to the event bus.</strong>
          <p>No new incident arrives while it is detached; this list may be behind.</p>
        </div>
      )}
      {incidents.length === 0 ? (
        <p data-testid="platform-incidents-empty">svc-ops has received no run the ledger could not finish.</p>
      ) : (
        <div className="dk-table-wrap" role="region" aria-label="Platform incidents" tabIndex={0}>
          <table className="adm-table">
            <thead>
              <tr>
                <th scope="col">Error</th>
                <th scope="col">Phase</th>
                <th scope="col">Runs in a row</th>
                <th scope="col">Ledger run</th>
                <th scope="col">Happened</th>
                <th scope="col">Received</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((i) => (
                <tr
                  key={i.eventKey}
                  data-testid="platform-incident"
                  data-event-key={i.eventKey}
                  data-error-code={i.errorCode}
                  data-phase={i.phase}
                >
                  <td>{i.errorCode}</td>
                  <td>{i.phase}</td>
                  <td>{i.consecutiveIncomplete}</td>
                  <td>{i.ledgerRunId ?? 'None'}</td>
                  <td>{formatWhen(i.occurredAt)}</td>
                  <td>{formatWhen(i.receivedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function AlertsRoom({ room }: { room: Room }) {
  return (
    <section className="dk-stack" aria-label="Reconciliation alerts" data-testid="recon-alerts">
      <h2>Reconciliation alerts</h2>
      <p className="dk-muted">
        Read {formatAsOf(room.asOf)}. One alert per control, failing asset, period and cause; a repeat raises its count. A failure goes to
        finance; a run that could not finish goes to the platform team.
      </p>
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
                    <th scope="col">Team</th>
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
                      data-cause={a.cause}
                      data-team={a.team}
                    >
                      <td>
                        <Link href={`/ledger/alerts/${a.id}`}>{assetLabel(a)}</Link>
                      </td>
                      <td>{a.team}</td>
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
      <h3>Platform incidents</h3>
      <p className="dk-muted">Ledger reconciliation runs that could not finish, as svc-ops received them. These go to the platform team.</p>
      <PlatformIncidents part={room.incidents} />
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

export interface AlertClose {
  readonly founderId: string;
  /** SHA-256 hex of the alert's evidence as the contract spells it, computed by this console; null when the alert was not read. */
  readonly evidenceHash: string | null;
  /** Why this founder cannot send a resolve or an acceptance (the treasury credential), or null. */
  readonly writes: RefusalView | null;
}

function Resolved({ resolved }: { resolved: NonNullable<OpsAlert['resolved']> }) {
  return (
    <div
      data-testid="alert-resolved"
      data-resolution={resolved.resolution}
      data-by={resolved.by}
      data-passing-run-id={resolved.passingRunId ?? ''}
    >
      <p>
        {resolved.resolution === 'auto'
          ? `Resolved automatically at ${formatWhen(resolved.at)}: run ${resolved.passingRunId ?? 'unknown'} of the same control and period passed.`
          : `Resolved as fixed by ${resolved.by} at ${formatWhen(resolved.at)}.`}
        {resolved.note ? ` Note: ${resolved.note}` : ''}
      </p>
      {resolved.correctiveTxIds.length > 0 && (
        <ul>
          {resolved.correctiveTxIds.map((tx) => (
            <li key={tx} data-testid="alert-resolved-tx" data-tx-id={tx}>
              Corrective ledger transaction {tx}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Accepted({ accepted }: { accepted: NonNullable<OpsAlert['accepted']> }) {
  return (
    <div
      data-testid="alert-accepted"
      data-evidence-hash={accepted.evidenceHash}
      data-requested-by={accepted.requestedBy}
      data-approved-by={accepted.approvedBy}
    >
      <p>
        Accepted at {formatWhen(accepted.at)}: asked by {accepted.requestedBy}, approved by {accepted.approvedBy}. Note: {accepted.note}
      </p>
      <p className="dk-muted">Evidence frozen at hash {accepted.evidenceHash}.</p>
    </div>
  );
}

export function AlertDetail({ part, close }: { part: Part<OpsAlertDetail>; close: AlertClose }) {
  if (part.kind === 'failed') return <Failed part={part} testId="alert-failed" />;
  const { alert, timeline, snoozes, source } = part.data;
  const ev = alert.evidence;
  const blocked = closeBlocked(alert.state, alert.cause) ?? close.writes?.body ?? null;
  return (
    <section
      className="dk-stack"
      aria-label="Alert"
      data-testid="alert-detail"
      data-state={alert.state}
      data-occurrences={alert.occurrences}
      data-version={alert.version}
      data-snoozed={String(alert.snooze !== null)}
      data-cause={alert.cause}
      data-team={alert.team}
    >
      <Source source={source} />
      <h2>
        {assetLabel(alert)} · {alert.state}
      </h2>
      <dl className="dk-stack">
        <div>
          <dt>Raised to</dt>
          <dd data-testid="alert-team">{TEAM_WORDS[alert.team] ?? alert.team}</dd>
        </div>
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
      {alert.error && (
        <p data-testid="alert-error" data-code={alert.error.code} data-phase={alert.error.phase ?? ''}>
          The run could not finish: {alert.error.code}
          {alert.error.phase ? ` in phase ${alert.error.phase}` : ''}.
        </p>
      )}
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
      {close.evidenceHash && (
        <p className="dk-muted">
          Evidence hash (what an acceptance freezes): <code data-testid="alert-evidence-hash">{close.evidenceHash}</code>
        </p>
      )}
      {alert.resolved && <Resolved resolved={alert.resolved} />}
      {alert.accepted && <Accepted accepted={alert.accepted} />}
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
      <AlertActions
        alertId={alert.id}
        version={alert.version}
        state={alert.state}
        snoozed={alert.snooze !== null}
        resolveBlocked={blocked}
      />
      {close.evidenceHash && (
        <AlertAccept alertId={alert.id} evidenceHash={close.evidenceHash} founderId={close.founderId} askBlocked={blocked} />
      )}
      <Notices alert={alert} />
      <h3>Timeline</h3>
      <ol data-testid="alert-timeline">
        {timeline.map((t) => (
          <li key={t.id} data-testid="timeline-entry" data-kind={t.kind} data-notice={t.notice ?? ''}>
            {formatWhen(t.at)} · {t.kind} · {t.actor}
            {t.notice ? ` · ${NOTICE_WORDS[t.notice] ?? t.notice}` : ''}
            {t.note ? ` · ${t.note}` : ''}
            {t.txIds.length > 0 && (
              <ul>
                {t.txIds.map((tx) => (
                  <li key={tx} data-testid="timeline-tx" data-tx-id={tx}>
                    {tx}
                  </li>
                ))}
              </ul>
            )}
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
