import { useMemo } from 'react';
import { Button, Tag } from '@intafaced/ui/lit';
import { useDataEnv, useSource } from '../../../data/hooks';
import { refusalCopy } from '../../../data';
import { statusPageFetcher, statusPostmortemsFetcher, type PublishedPostmortem, type StatusPage } from '../status';
import { statusCopy } from '../status-copy';
import { StatusBadgeShare } from './StatusBadgeShare';
import { StatusSubscribe } from './StatusSubscribe';

type CopyKey = Parameters<ReturnType<typeof statusCopy.useCopy>['t']>[0];
type Component = StatusPage['components'][number];
type Incident = StatusPage['incidents'][number];

/** A component's state as a tag's tone: operational reads up, an outage down, the rest neutral; the words say which. */
const STATE_TONE: Record<Component['state'], 'up' | 'down' | 'neutral'> = {
  operational: 'up',
  degraded: 'neutral',
  maintenance: 'neutral',
  partial_outage: 'down',
  major_outage: 'down',
  no_data: 'neutral',
};

const whenUtc = (instant: string) => `${instant.slice(0, 16).replace('T', ' ')} UTC`;

/**
 * The founders' components on /status (SP-status-01). Every state is one the service derived from a reading or a published
 * notice; a component with no current reading says "No data", and with none defined the page shows no overall status at all.
 */
export function StatusComponents() {
  const copy = statusCopy.useCopy();
  const env = useDataEnv();
  const source = useMemo(
    () => env.poller.source<StatusPage>('public-status-page', statusPageFetcher(env.api), { intervalMs: 30_000 }),
    [env],
  );
  const postmortemSource = useMemo(
    () =>
      env.poller.source<PublishedPostmortem[]>('public-status-postmortems', statusPostmortemsFetcher(env.api), {
        intervalMs: 60_000,
      }),
    [env],
  );
  const load = useSource(source);
  const postmortems = useSource(postmortemSource);
  const postmortemOf = useMemo(
    () => new Map(postmortems.status === 'ready' ? postmortems.data.map((p) => [p.incidentId, p] as const) : []),
    [postmortems],
  );
  if (load.status === 'loading') return <p role="status">{copy.t('componentsLoading')}</p>;
  if (load.status === 'refused') return <p role="alert">{refusalCopy(load.code).title || copy.t('componentsFailed')}</p>;
  if (load.status !== 'ready')
    return (
      <p role="alert">
        {copy.t('componentsFailed')}
        {load.status === 'error' ? (
          <>
            {' '}
            <Button tone="quiet" onClick={load.retry}>
              {copy.t('retry')}
            </Button>
          </>
        ) : null}
      </p>
    );
  const page = load.data;
  const grouped = groups(page.components);
  return (
    <>
      {page.overall === 'none_defined' ? (
        <section className="lt-stack" aria-labelledby="status-components" data-testid="status-components">
          <h2 id="status-components">{copy.t('componentsTitle')}</h2>
          <p role="status" data-testid="status-components-none">
            {copy.t('componentsNone')}
          </p>
        </section>
      ) : (
        <>
          <section className="lt-stack" role="status" data-testid="status-overall" data-state={page.overall}>
            <h2>{copy.t(`overall_${page.overall}` as CopyKey)}</h2>
            {page.overall === 'no_data' ? <p>{copy.t('overall_no_data_body')}</p> : null}
          </section>
          <section className="lt-stack" aria-labelledby="status-components" data-testid="status-components">
            <h2 id="status-components">{copy.t('componentsTitle')}</h2>
            <p className="lt-hint" data-testid="status-asof">
              {copy.t('pageAsOf')} <time dateTime={page.asOf}>{whenUtc(page.asOf)}</time>
            </p>
            {grouped.map(([group, rows]) => (
              <div key={group ?? ''} className="lt-stack">
                {group !== null || grouped.length > 1 ? <h3>{group ?? copy.t('ungrouped')}</h3> : null}
                <ul className="lt-stack">
                  {rows.map((row) => (
                    <ComponentRow key={row.id} row={row} uptimeDays={page.settings.uptimeDays} />
                  ))}
                </ul>
              </div>
            ))}
            {page.settings.uptimeDays === null ? (
              <p className="lt-hint" data-testid="status-uptime-unset">
                {copy.t('uptimeUnset')}
              </p>
            ) : (
              <p className="lt-hint">{copy.t('uptimeNote')}</p>
            )}
          </section>
        </>
      )}
      <section className="lt-stack" aria-labelledby="status-incidents" data-testid="status-incidents">
        <h2 id="status-incidents">{copy.t('incidentsTitle')}</h2>
        {page.incidents.length === 0 ? <p>{copy.t('incidentsNone')}</p> : null}
        {page.incidents.some((i) => i.resolvedAt !== null) && (postmortems.status === 'error' || postmortems.status === 'refused') ? (
          <p className="lt-hint" role="status" data-testid="status-postmortems-failed">
            {postmortems.status === 'refused'
              ? refusalCopy(postmortems.code).title || copy.t('postmortemsFailed')
              : copy.t('postmortemsFailed')}
          </p>
        ) : null}
        {page.incidents.map((incident) => (
          <IncidentCard key={incident.id} incident={incident} names={page.components} postmortem={postmortemOf.get(incident.id) ?? null} />
        ))}
      </section>
      <StatusBadgeShare components={page.components} />
      <StatusSubscribe components={page.components} />
    </>
  );
}

function groups(rows: readonly Component[]): [string | null, Component[]][] {
  const out = new Map<string | null, Component[]>();
  for (const row of rows) out.set(row.group, [...(out.get(row.group) ?? []), row]);
  return [...out.entries()];
}

function ComponentRow({ row, uptimeDays }: { row: Component; uptimeDays: number | null }) {
  const copy = statusCopy.useCopy();
  return (
    <li className="lt-stack" data-testid={`status-component-${row.id}`} data-state={row.state}>
      <div className="lt-actions">
        <strong>{row.name}</strong>
        <Tag tone={STATE_TONE[row.state]}>{copy.t(`state_${row.state}` as CopyKey)}</Tag>
      </div>
      <p className="lt-hint">
        {row.basis === 'reading' && row.reading ? (
          <>
            {copy.t('basis_reading')} {row.reading.source} {copy.t('readingAt')} {whenUtc(row.reading.observedAt)}
          </>
        ) : (
          copy.t(`basis_${row.basis}` as CopyKey)
        )}
        {row.source ? (
          <>
            {' '}
            · {copy.t('outsideSource')}: {row.source}
          </>
        ) : null}
      </p>
      {uptimeDays !== null ? (
        <ol className="lt-uptime" aria-label={`${copy.t('uptimeLabel')}: ${row.name}`} data-testid={`status-uptime-${row.id}`}>
          {row.uptime.map((day) => (
            <li
              key={day.date}
              data-state={day.state ?? 'empty'}
              title={`${day.date}: ${day.state ? copy.t(`state_${day.state}` as CopyKey) : copy.t('uptimeEmptyDay')}`}
            />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function IncidentCard({
  incident,
  names,
  postmortem,
}: {
  incident: Incident;
  names: readonly Component[];
  postmortem: PublishedPostmortem | null;
}) {
  const copy = statusCopy.useCopy();
  const affected = incident.components.map((id) => names.find((c) => c.id === id)?.name ?? id);
  return (
    <article className="lt-stack" id={`incident-${incident.id}`} data-testid={`status-incident-${incident.id}`}>
      <h3>{incident.title}</h3>
      <p className="lt-hint">
        {incident.resolvedAt ? `${copy.t('incidentResolved')} ${whenUtc(incident.resolvedAt)}` : copy.t('incidentOpen')}
        {incident.impact ? ` · ${copy.t(`impact_${incident.impact}` as CopyKey)}` : null} · {copy.t('incidentAffects')}:{' '}
        {affected.length ? affected.join(', ') : copy.t('incidentNoComponent')}
      </p>
      <ol data-testid="status-timeline">
        {[...incident.updates].reverse().map((update) => (
          <li key={update.id}>
            <span className="lt-hint">{whenUtc(update.publishedAt)}</span> <span>{update.body}</span>
          </li>
        ))}
      </ol>
      {postmortem ? (
        <section className="lt-stack" data-testid={`status-postmortem-${incident.id}`}>
          <h4>{copy.t('postmortemTitle')}</h4>
          <p className="lt-hint">
            {copy.t('postmortemPublished')} {whenUtc(postmortem.publishedAt)}
          </p>
          <p className="lt-pre">{postmortem.body}</p>
        </section>
      ) : null}
    </article>
  );
}
