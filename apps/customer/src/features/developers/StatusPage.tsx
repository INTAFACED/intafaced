import { StateBlock } from '@intafaced/ui';
import { useSession } from '../session/session';
import { liveCopy } from './developers-live-copy';
import { readStatusFeed, STATUS_COMPONENT_IDS, type StatusFeed } from './developers-api';
import { useRead } from './use-read';
import '../public/public-pages.css';

const when = (instant: string) => `${instant.slice(0, 16).replace('T', ' ')} UTC`;

/** /developers/status: the machine-readable status feed, as a page. */
export function StatusPage() {
  const { t } = liveCopy.useCopy();
  const { api } = useSession();
  const { read, reload } = useRead((signal) => readStatusFeed(api, signal), [api]);
  return (
    <div className="pub-page" data-testid="developers-status">
      <header className="pub-heading">
        <h1>{t('statusTitle')}</h1>
        <p className="muted">{t('statusLead')}</p>
      </header>
      {read.status === 'loading' ? (
        <StateBlock kind="loading" rows={4} rowHeight={48} label={t('loading')} />
      ) : read.status === 'failed' ? (
        <StateBlock kind="error" title={t('loadFailed')} onRetry={reload} retryLabel={t('tryAgain')} />
      ) : (
        <StatusView feed={read.data} />
      )}
      <a className="text-link" href="/developers">
        ← {t('back')}
      </a>
    </div>
  );
}

export function StatusView({ feed }: { feed: StatusFeed }) {
  const { t } = liveCopy.useCopy();
  const historyDays = feed.history.days.filter((entry) => entry.components.some((c) => c.incidentMinutes > 0));
  return (
    <>
      <p className="muted">{t('asOf', { when: when(feed.asOf) })}</p>
      <section className="pub-card" aria-labelledby="st-components">
        <h2 id="st-components">{t('componentsTitle')}</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">{t('colComponent')}</th>
              <th scope="col">{t('colState')}</th>
              <th scope="col">{t('colSince')}</th>
            </tr>
          </thead>
          <tbody>
            {STATUS_COMPONENT_IDS.map((id) => {
              const row = feed.components.find((entry) => entry.component === id);
              return (
                <tr key={id} data-component-state={row?.state ?? 'unknown'}>
                  <th scope="row">{t(`component_${id}` as const)}</th>
                  <td>
                    {t(`state_${row?.state ?? 'unknown'}` as const)}
                    {!row || row.state === 'unknown' ? <span className="muted"> · {t('unknownNote')}</span> : null}
                  </td>
                  <td>{row?.since ? when(row.since) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <section className="pub-card" aria-labelledby="st-incidents">
        <h2 id="st-incidents">{t('incidentsTitle')}</h2>
        {feed.incidents.length === 0 ? (
          <p>{t('incidentsNone')}</p>
        ) : (
          <ul>
            {feed.incidents.map((incident) => (
              <li key={incident.id} data-incident-state={incident.resolvedAt ? 'resolved' : 'open'}>
                <strong>{incident.title}</strong>{' '}
                <span className="muted">
                  {incident.impact ? `${t(`impact_${incident.impact}` as const)} · ` : ''}
                  {incident.components.map((id) => t(`component_${id}` as const)).join(', ')} ·{' '}
                  {incident.resolvedAt ? t('incidentResolved', { when: when(incident.resolvedAt) }) : t('incidentOpen')}
                </span>
                <ol>
                  {incident.updates.map((update) => (
                    <li key={update.id}>
                      <time dateTime={update.publishedAt}>{when(update.publishedAt)}</time> {update.body}
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="pub-card" aria-labelledby="st-maintenance">
        <h2 id="st-maintenance">{t('maintenanceTitle')}</h2>
        {feed.maintenance.length === 0 ? (
          <p>{t('maintenanceNone')}</p>
        ) : (
          <ul>
            {feed.maintenance.map((window) => (
              <li key={window.id}>
                <strong>{window.title}</strong>{' '}
                <span className="muted">
                  {window.components.map((id) => t(`component_${id}` as const)).join(', ')} ·{' '}
                  {window.startsAt ? when(window.startsAt) : t('windowNotSet')} → {window.endsAt ? when(window.endsAt) : t('windowNotSet')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="pub-card" aria-labelledby="st-history">
        <h2 id="st-history">{t('historyTitle')}</h2>
        <p className="muted">{t('historyLead')}</p>
        {historyDays.length === 0 ? (
          <p>{t('historyNone')}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">{t('colSince')}</th>
                {STATUS_COMPONENT_IDS.map((id) => (
                  <th scope="col" key={id}>
                    {t(`component_${id}` as const)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {historyDays.map((entry) => (
                <tr key={entry.date}>
                  <th scope="row">{entry.date}</th>
                  {STATUS_COMPONENT_IDS.map((id) => {
                    const minutes = entry.components.find((c) => c.component === id)?.incidentMinutes ?? 0;
                    return <td key={id}>{minutes > 0 ? t('minutes', { count: minutes }) : ''}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
