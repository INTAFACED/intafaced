import { formatWhen } from '@/lib/as-of';
import type { OpsCapitalScenario, OpsCapitalSnapshot } from '@intafaced/contracts/ops-capital';
import { CAPITAL_REFUSAL_WORDS, PARTNER_SOURCE, STATE_WORDS, accountName, reserveWords } from '@/lib/capital/model';
import type { Part } from '@/lib/desk/part';
import '../desk.css';

/** A part that could not be read: "unknown", with svc-ops' own words and the code. Never a zero. */
function Unknown({ testId, title, code, message }: { testId: string; title: string; code: string; message: string }) {
  return (
    <div className="adm-callout" data-tone="warn" role="status" data-testid={testId} data-state="unknown">
      <strong>{title}: unknown</strong>
      <p>{message}</p>
      <p className="dk-muted">
        Code: <code>{code}</code>. {CAPITAL_REFUSAL_WORDS[code] ?? ''}
      </p>
    </div>
  );
}

function OwnFunds({ part }: { part: OpsCapitalSnapshot['ownFunds'] }) {
  if (part.status === 'unknown')
    return <Unknown testId="own-funds-unknown" title="INTAFACED’s own funds" code={part.code} message={part.message} />;
  return (
    <>
      <p className="dk-muted" data-testid="own-funds-source">
        Source: the ledger (svc-ledger), house and module accounts only, read {formatWhen(part.asOf)}. Customer balances are never counted
        as ours.
      </p>
      {part.assets.length === 0 ? (
        <p data-testid="own-funds-empty">The ledger holds no funds of INTAFACED’s. That is the ledger’s answer, not a missing read.</p>
      ) : (
        <table className="adm-table" aria-label="INTAFACED’s own funds per asset">
          <thead>
            <tr>
              <th scope="col">Asset</th>
              <th scope="col">Own funds</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {part.assets.map((a) => (
              <tr key={a.assetId}>
                <th scope="row">{a.assetId}</th>
                <td data-testid={`own-funds-${a.assetId}`}>{a.amount}</td>
                <td>
                  Ledger: {a.accounts} {a.accounts === 1 ? 'account' : 'accounts'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {part.accounts.length > 0 && (
        <details>
          <summary>The ledger accounts these sum</summary>
          <table className="adm-table" aria-label="Ledger accounts in INTAFACED’s own funds">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Asset</th>
                <th scope="col">Balance</th>
              </tr>
            </thead>
            <tbody>
              {part.accounts.map((a) => (
                <tr key={`${a.ownerType}:${a.ownerId}:${a.assetId}:${a.kind}:${a.purpose}`}>
                  <th scope="row">{accountName(a)}</th>
                  <td>{a.assetId}</td>
                  <td>{a.balance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </>
  );
}

function Venues({ part }: { part: OpsCapitalSnapshot['venues'] }) {
  if (part.status === 'not_connected') {
    return (
      <div className="adm-callout" data-tone="warn" role="status" data-testid="venues-not-connected" data-not-connected={part.code}>
        <strong>Not connected</strong>
        <p>{part.message}</p>
        <p className="dk-muted">
          Code: <code>{part.code}</code>
        </p>
      </div>
    );
  }
  return (
    <table className="adm-table" aria-label="Builder account at each venue">
      <thead>
        <tr>
          <th scope="col">Venue</th>
          <th scope="col">Builder account balance, as the venue reports it</th>
          <th scope="col">As of</th>
          <th scope="col">Venue’s published minimum for collecting builder fees</th>
          <th scope="col">Source</th>
        </tr>
      </thead>
      <tbody>
        {part.venues.map((v) => (
          <tr key={v.venueId} data-testid={`venue-${v.venueId}`} data-state={v.balance.status}>
            <th scope="row">
              {v.displayName}
              {v.test ? ' (TEST)' : ''}
            </th>
            <td>{v.balance.status === 'read' ? `${v.balance.amount} ${v.balance.assetId}` : `unknown (${v.balance.code})`}</td>
            <td>{v.balance.status === 'read' ? formatWhen(v.balance.asOf) : 'unknown'}</td>
            <td>
              {v.minimum.status === 'published'
                ? `${v.minimum.amount} ${v.minimum.assetId}`
                : v.minimum.status === 'unknown'
                  ? `unknown (${v.minimum.code})`
                  : 'not published'}
            </td>
            <td>The venue’s own record for {v.builderAccount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Reserves({ part }: { part: OpsCapitalSnapshot['reserves'] }) {
  if (part.status === 'unknown')
    return <Unknown testId="reserves-unknown" title="Partner reserves" code={part.code} message={part.message} />;
  if (part.partners.length === 0)
    return <p data-testid="reserves-none">No partner is connected on this deployment, so no partner holds a reserve of ours.</p>;
  return (
    <table className="adm-table" aria-label="Reserves partners hold of ours">
      <thead>
        <tr>
          <th scope="col">Partner</th>
          <th scope="col">Reserve it holds of ours</th>
          <th scope="col">Source</th>
        </tr>
      </thead>
      <tbody>
        {part.partners.map((p) => (
          <tr key={p.partner}>
            <th scope="row">{p.label}</th>
            <td data-testid={`reserve-${p.partner}`} data-status={p.reserve.status}>
              {reserveWords(p.reserve)}
            </td>
            <td>
              {PARTNER_SOURCE[p.partner]}, read {formatWhen(part.asOf)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Buffers({ snapshot }: { snapshot: OpsCapitalSnapshot }) {
  if (snapshot.buffers.length === 0) return <p data-testid="buffers-empty">No asset has own funds or a threshold.</p>;
  return (
    <table className="adm-table" aria-label="Buffer thresholds per asset">
      <thead>
        <tr>
          <th scope="col">Asset</th>
          <th scope="col">Buffer (own funds)</th>
          <th scope="col">Minimum</th>
          <th scope="col">State</th>
        </tr>
      </thead>
      <tbody>
        {snapshot.buffers.map((b) => (
          <tr key={b.assetId} data-testid={`buffer-${b.assetId}`} data-state={b.state}>
            <th scope="row">{b.assetId}</th>
            <td>{b.buffer ?? 'unknown'}</td>
            <td>
              {b.threshold.status === 'set'
                ? `${b.threshold.minimum} (version ${b.threshold.version}; breaches go to ${b.threshold.contact})`
                : 'Not set'}
            </td>
            <td>
              <strong>{STATE_WORDS[b.state]}</strong>
              {b.threshold.status === 'unset' && (
                <span className="dk-muted">
                  {' '}
                  <code>{b.threshold.code}</code> {CAPITAL_REFUSAL_WORDS[b.threshold.code]}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Alerts({ alerts }: { alerts: OpsCapitalSnapshot['alerts'] }) {
  if (alerts.length === 0) return <p data-testid="alerts-empty">No breach alert has opened.</p>;
  return (
    <table className="adm-table" aria-label="Breach alerts">
      <thead>
        <tr>
          <th scope="col">Alert</th>
          <th scope="col">Asset</th>
          <th scope="col">Day (UTC)</th>
          <th scope="col">Buffer</th>
          <th scope="col">Minimum</th>
          <th scope="col">Escalated to</th>
          <th scope="col">Opened</th>
        </tr>
      </thead>
      <tbody>
        {alerts.map((a) => (
          <tr key={a.key}>
            <th scope="row">
              <code>{a.key}</code>
            </th>
            <td>{a.assetId}</td>
            <td>{a.period}</td>
            <td>{a.buffer}</td>
            <td>{a.minimum}</td>
            <td>{a.escalatedTo}</td>
            <td>{formatWhen(a.openedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The monitor as svc-ops evaluated it. Each part names its source, and a part that could not be read says unknown. */
export function CapitalMonitor({ snapshot }: { snapshot: OpsCapitalSnapshot }) {
  return (
    <div className="dk-stack" data-testid="capital-monitor">
      <p className="dk-muted">
        Evaluated {formatWhen(snapshot.asOf)}. Breach alerts count per asset and UTC day ({snapshot.period}).
      </p>
      <section aria-label="INTAFACED’s own funds" className="dk-stack">
        <h3>INTAFACED’s own funds</h3>
        <OwnFunds part={snapshot.ownFunds} />
      </section>
      <section aria-label="Builder account at each venue" className="dk-stack">
        <h3>Builder account at each venue</h3>
        <Venues part={snapshot.venues} />
      </section>
      <section aria-label="Reserves partners hold of ours" className="dk-stack">
        <h3>Reserves partners hold of ours</h3>
        <Reserves part={snapshot.reserves} />
      </section>
      <section aria-label="Buffer thresholds" className="dk-stack">
        <h3>Buffer thresholds</h3>
        <Buffers snapshot={snapshot} />
      </section>
      <section aria-label="Breach alerts" className="dk-stack">
        <h3>Breach alerts</h3>
        <Alerts alerts={snapshot.alerts} />
      </section>
    </div>
  );
}

/** A scenario's answer, or svc-ops' refusal in words with its code. */
export function ScenarioResult({ part }: { part: Part<OpsCapitalScenario> }) {
  if (part.kind === 'failed') {
    return (
      <div className="adm-callout" data-tone="warn" role="status" data-testid="scenario-refused">
        <strong>No scenario was run</strong>
        <p>{part.message}</p>
        {part.code && (
          <p className="dk-muted">
            Code: <code>{part.code}</code>
          </p>
        )}
      </div>
    );
  }
  const s = part.data;
  return (
    <dl className="dk-stack" data-testid="scenario-result">
      <div>
        <dt>Loss</dt>
        <dd>
          {s.loss} {s.assetId} ({s.exposure} exposure to {s.counterparty} × {s.lossShare} loss share)
        </dd>
      </div>
      <div>
        <dt>Own funds before and after</dt>
        <dd>
          {s.ownFundsBefore} → {s.ownFundsAfter} {s.assetId}, from the ledger read {formatWhen(s.asOf)}
        </dd>
      </div>
      <div>
        <dt>Against the threshold</dt>
        <dd>{STATE_WORDS[s.stateAfter]}</dd>
      </div>
    </dl>
  );
}
