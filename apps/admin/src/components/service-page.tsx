import Link from 'next/link';
import type { ReactNode } from 'react';
import { SERVICE_OWNER_UNSET } from '@intafaced/contracts/ops-console-services';
import { Chip } from '@/components/chip';
import { ServiceRecordForm } from '@/components/service-record-form';
import { formatAsOf } from '@/lib/as-of';
import { HEALTH_ROWS, HEALTH_SOURCE_UNAVAILABLE, HEALTH_SOURCE_UNWIRED } from '@/lib/module-health/board';
import { INCIDENT_ACTIONS_BLOCKER, MODULE_ALERT_LABEL, type Panel, type ServicePageView } from '@/lib/service-page/model';
import './desk.css';

/**
 * ONE MODULE'S SERVICE PAGE (`/health/:module`, OPS-service-health-01).
 *
 * Owner, who is on call, dependencies, runbook, open incidents, alerts, objectives and dashboards, each in its own panel.
 * A panel whose source fails refuses on its own and the others still show; a panel with no source in this build names its
 * blocker. Nobody is shown as owner until a founder names the team ("owner not set").
 */

const labelOf = (module: string) => HEALTH_ROWS.find((r) => r.module === module)?.label ?? module;

function PanelCard<T>({ id, title, panel, children }: { id: string; title: string; panel: Panel<T>; children: (data: T) => ReactNode }) {
  if (panel.kind === 'unwired')
    return (
      <article className="adm-callout" data-tone="warn" data-testid={`service-${id}`} data-state="unwired">
        <strong>{title}: no source</strong>
        <p>{panel.blocker}</p>
        <p className="dk-muted">Code: {panel.code}</p>
      </article>
    );
  if (panel.kind === 'unavailable')
    return (
      <article className="adm-callout" data-tone="danger" data-testid={`service-${id}`} data-state="unavailable" role="status">
        <strong>
          {title}: could not read {panel.service}
        </strong>
        <p>{panel.message}</p>
        <p className="dk-muted">
          Code: {panel.code}
          {panel.cause ? ` (${panel.cause})` : ''}. Nothing is shown in its place.
        </p>
      </article>
    );
  return (
    <article className="adm-callout" data-tone="info" data-testid={`service-${id}`} data-state="read">
      <strong>{title}</strong>
      {children(panel.data)}
    </article>
  );
}

export function ServicePage({ view }: { view: ServicePageView }) {
  const { record, state } = view;
  return (
    <div className="dk" data-testid="service-page" data-module={view.module}>
      <div className="adm-pagehead">
        <div>
          <p className="dk-muted">
            <Link href="/health">Module health</Link> / {view.label}
          </p>
          <h1>{view.label}: service page</h1>
          <p>Who owns this module, what it depends on, how to run it, and what is wrong with it now. Each panel reads on its own.</p>
        </div>
      </div>
      <div className="dk-row">
        <a className="adm-btn" href={`/health/${view.module}`}>
          Refresh
        </a>
        <span className="dk-asof">Read started {formatAsOf(view.asOf)}</span>
        <button type="button" className="adm-btn" disabled title={INCIDENT_ACTIONS_BLOCKER} aria-describedby="incident-actions-why">
          Escalate
        </button>
        <button type="button" className="adm-btn" disabled title={INCIDENT_ACTIONS_BLOCKER} aria-describedby="incident-actions-why">
          Declare an incident
        </button>
        <span id="incident-actions-why" className="dk-why">
          {INCIDENT_ACTIONS_BLOCKER}
        </span>
      </div>

      <div className="dk-common">
        <PanelCard id="owner" title="Owner" panel={record}>
          {(r) =>
            r.ownerTeam === null ? (
              <p data-testid="service-owner-unset">
                <strong>Owner not set.</strong> Nobody has named the team that owns this module.{' '}
                <span className="dk-muted">Code: {SERVICE_OWNER_UNSET}</span>
              </p>
            ) : (
              <p data-testid="service-owner-team">{r.ownerTeam}</p>
            )
          }
        </PanelCard>
        <PanelCard id="on-call" title="On call" panel={view.onCall}>
          {() => null}
        </PanelCard>
        <PanelCard id="dependencies" title="Dependencies" panel={record}>
          {(r) =>
            r.dependencies.length === 0 ? (
              <p className="dk-muted">{r.revision === 0 ? 'Not set.' : 'None: the record names no module this one depends on.'}</p>
            ) : (
              <ul className="dk-stack" aria-label="Depends on">
                {r.dependencies.map((d) => (
                  <li key={d}>
                    <Link href={`/health/${d}`}>{labelOf(d)}</Link>
                  </li>
                ))}
              </ul>
            )
          }
        </PanelCard>
        <PanelCard id="runbook" title="Runbook" panel={record}>
          {(r) =>
            r.runbook === null ? (
              <p className="dk-muted">Not set.</p>
            ) : (
              <p>
                <code className="dk-packet" data-testid="service-runbook-path">
                  {r.runbook}
                </code>
                <br />
                <span className="dk-muted">
                  A path in the repository’s runbooks folder, as a founder typed it. This page does not check that the file exists.
                </span>
              </p>
            )
          }
        </PanelCard>
        <PanelCard id="incidents" title="Open incidents" panel={view.incidents}>
          {() => null}
        </PanelCard>
        <PanelCard id="alerts" title="Alerts" panel={view.alerts}>
          {(a) =>
            a.items.length === 0 ? (
              <p className="dk-muted">
                No alert rule is labelled {MODULE_ALERT_LABEL}={view.module}, so none can fire for this module.
              </p>
            ) : (
              <>
                <ul className="dk-stack">
                  {a.items.map(({ rule, status }) => (
                    <li key={rule.id}>
                      {rule.name}{' '}
                      {status === null ? (
                        <Chip tone="warn">not evaluated yet</Chip>
                      ) : (
                        <Chip tone={status.state === 'normal' && status.health === 'ok' ? 'live' : 'warn'}>
                          {status.state} · {status.health === 'no_data' ? 'no data' : status.health}
                        </Chip>
                      )}
                    </li>
                  ))}
                </ul>
                {a.nextCursor && <p className="dk-muted">The first {a.items.length} rules; more are labelled with this module.</p>}
              </>
            )
          }
        </PanelCard>
        <PanelCard id="objectives" title="Objectives" panel={view.objectives}>
          {() => null}
        </PanelCard>
        <PanelCard id="dashboards" title="Dashboards" panel={view.dashboards}>
          {() => null}
        </PanelCard>
      </div>

      <section className="dk-stack" aria-labelledby="h-module-state" data-testid="service-state" data-state={state.state}>
        <h2 id="h-module-state">Module state</h2>
        {state.state === 'read' && (
          <dl className="dk-kv">
            {(
              [
                ['Volume', state.volume],
                ['Failures', state.failures],
                ['Oldest waiting', state.oldest],
              ] as const
            ).map(([label, figure]) => (
              <div className="dk-kv-row" key={label}>
                <dt>{label}</dt>
                <dd>
                  {figure.value === null ? <span className="dk-muted">Not given</span> : <strong>{figure.value}</strong>}{' '}
                  <span className="dk-muted">{figure.note}</span>
                </dd>
              </div>
            ))}
          </dl>
        )}
        {state.state === 'unwired' && (
          <p>
            <strong>No source: </strong>
            {state.blocker} <span className="dk-muted">Code: {HEALTH_SOURCE_UNWIRED}</span>
          </p>
        )}
        {state.state === 'refused' && (
          <p role="status">
            <strong>Could not read {state.service}: </strong>
            {state.message} <span className="dk-muted">Code: {HEALTH_SOURCE_UNAVAILABLE}</span>
          </p>
        )}
        <p>{state.desk ? <Link href={state.desk.href}>{state.desk.label}</Link> : <span className="dk-muted">No desk yet</span>}</p>
      </section>

      <ServiceRecordForm
        module={view.module}
        record={record.kind === 'read' ? record.data : null}
        blocker={record.kind === 'read' ? null : 'The record could not be read, so it cannot be changed from here. Reload the page.'}
      />
    </div>
  );
}
