import Link from 'next/link';
import { formatAsOf } from '@/lib/as-of';
import type { ComplianceSection, EdgeComplianceStatus } from '@/lib/compliance/model';
import { blockingBlanks, STAFF_COUNTS_UNWIRED, type SettingRow } from '@/lib/settings/effective';
import './desk.css';

export interface EffectiveSettingsProps {
  readonly rows: readonly SettingRow[];
  readonly deployment: { readonly appEnv: string; readonly drop: string };
  readonly edge: ComplianceSection<EdgeComplianceStatus>;
  readonly edgeAsOf: string;
  readonly flags: readonly { readonly name: string; readonly value: string }[];
}

/**
 * Platform settings in force (OPS-admin-access-08): the blank settings that stop something first, each with what it stops,
 * then every setting this console reads, svc-edge's screening and network posture in its own words, and the flag overrides.
 * A secret is shown as set or blank, never its value.
 */
export function EffectiveSettings({ rows, deployment, edge, edgeAsOf, flags }: EffectiveSettingsProps) {
  const blocking = blockingBlanks(rows);
  return (
    <div className="dk-stack" data-testid="effective-settings">
      <header className="dk-stack">
        <h1>Platform settings</h1>
        <p className="dk-muted">
          The settings in force on this console ({deployment.appEnv}, launch drop {deployment.drop}) and what each blank one stops. Names
          and presence only: no secret is shown, and nothing blank is filled in with a default. Each service keeps its own owner settings
          and refuses with its own code when one is blank; svc-edge’s are below.
        </p>
      </header>

      <section className="adm-callout dk-stack" data-tone={blocking.length ? 'warn' : 'info'} data-testid="settings-blocking">
        <h2>Blank settings that stop an action</h2>
        {blocking.length === 0 ? (
          <p>None: every setting this console needs is set.</p>
        ) : (
          <ul>
            {blocking.map((row) => (
              <li key={row.name} data-testid={`blocking-${row.name}`}>
                <code>{row.name}</code> is blank. Stops: {row.blocks}
              </li>
            ))}
          </ul>
        )}
        <EdgeBlanks edge={edge} />
      </section>

      <section className="dk-stack" aria-labelledby="h-console-settings">
        <h2 id="h-console-settings">This console’s settings</h2>
        <div className="dk-table-wrap">
          <table className="dk-table" data-testid="settings-console">
            <thead>
              <tr>
                <th scope="col">Setting</th>
                <th scope="col">What it is</th>
                <th scope="col">State</th>
                <th scope="col">When blank</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name} data-testid={`setting-${row.name}`} data-state={row.state}>
                  <td>
                    <code>{row.name}</code>
                  </td>
                  <td>{row.what}</td>
                  <td>{row.state === 'blank' ? 'Blank' : row.value === null ? 'Set (secret, not shown)' : <code>{row.value}</code>}</td>
                  <td>{row.state === 'set' ? '' : (row.blocks ?? row.blankMeans)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="dk-stack" aria-labelledby="h-edge-posture" data-testid="settings-edge-posture">
        <h2 id="h-edge-posture">Screening and network (svc-edge)</h2>
        <p className="dk-asof">As of {formatAsOf(edgeAsOf)} (when this console read svc-edge)</p>
        {edge.kind === 'failed' ? (
          <div className="adm-callout" data-tone="warn" role="status" data-state="refused">
            <strong>Could not read svc-edge’s settings</strong>
            <p>{edge.message}</p>
            <p className="dk-muted">Code: ops.settings_read_unavailable{edge.code ? ` (svc-edge: ${edge.code})` : ''}</p>
          </div>
        ) : (
          <dl className="dk-kv" data-state="read">
            <div className="dk-kv-row">
              <dt>Sanctions screening list</dt>
              <dd data-testid="edge-screening" data-state={edge.data.geoBlock.screeningConfigured ? 'set' : 'blank'}>
                {edge.data.geoBlock.screeningConfigured ? 'Set' : 'Blank'}. {edge.data.geoBlock.screeningDeclaration}
              </dd>
            </div>
            <div className="dk-kv-row">
              <dt>Network signal partner</dt>
              <dd data-testid="edge-network" data-state={edge.data.networkSignal.partnerConfigured ? 'set' : 'blank'}>
                {edge.data.networkSignal.partnerConfigured ? 'Set' : 'Blank'}. {edge.data.networkSignal.declaration}
              </dd>
            </div>
            <div className="dk-kv-row">
              <dt>Region</dt>
              <dd>{edge.data.region.statusLine}</dd>
            </div>
          </dl>
        )}
        <p>
          <Link href="/jurisdiction">Jurisdiction rules in force</Link> · <Link href="/">Flags and kill-switches</Link> ·{' '}
          <Link href="/launch">Launch sequence</Link>
        </p>
      </section>

      <section className="dk-stack" aria-labelledby="h-flag-overrides" data-testid="settings-flags">
        <h2 id="h-flag-overrides">Flag overrides on this console</h2>
        {flags.length === 0 ? (
          <p>No INTAFACED_FLAG_* override is set; every flag follows the launch drop.</p>
        ) : (
          <ul>
            {flags.map((flag) => (
              <li key={flag.name}>
                <code>{flag.name}</code> = <code>{flag.value}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      <article className="adm-callout" data-tone="warn" data-testid={`unwired-${STAFF_COUNTS_UNWIRED.id}`} data-state="unwired">
        <strong>{STAFF_COUNTS_UNWIRED.label}: no source</strong>
        <p>{STAFF_COUNTS_UNWIRED.reason}</p>
        <p className="dk-muted">Code: {STAFF_COUNTS_UNWIRED.code}</p>
      </article>
    </div>
  );
}

function EdgeBlanks({ edge }: { edge: ComplianceSection<EdgeComplianceStatus> }) {
  if (edge.kind === 'failed')
    return <p className="dk-muted">svc-edge’s own settings could not be read; see below. Nothing is assumed set.</p>;
  const blanks = [
    !edge.data.geoBlock.screeningConfigured && {
      id: 'screening',
      text: `svc-edge’s sanctions screening list is blank. ${edge.data.geoBlock.screeningDeclaration}`,
    },
    !edge.data.networkSignal.partnerConfigured && {
      id: 'network',
      text: `svc-edge’s network signal partner is blank. ${edge.data.networkSignal.declaration}`,
    },
  ].filter((b): b is { id: string; text: string } => Boolean(b));
  if (blanks.length === 0) return null;
  return (
    <ul>
      {blanks.map((b) => (
        <li key={b.id} data-testid={`blocking-edge-${b.id}`}>
          {b.text}
        </li>
      ))}
    </ul>
  );
}
