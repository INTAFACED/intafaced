import { useState } from 'react';
import { StateBlock } from '@intafaced/ui';
import { useSession } from '../session/session';
import { liveCopy } from './developers-live-copy';
import {
  CHANGELOG_AREA_IDS,
  readChangelog,
  readUpcomingChanges,
  type ChangelogAreaId,
  type ChangelogEntry,
  type UpcomingChanges,
} from './developers-api';
import { useRead } from './use-read';
import '../public/public-pages.css';

/** /developers/changelog: published entries newest first, filtered by area and by the breaking flag. */
export function ChangelogPage() {
  const { t } = liveCopy.useCopy();
  const { api } = useSession();
  const [area, setArea] = useState<ChangelogAreaId | null>(null);
  const [breaking, setBreaking] = useState(false);
  const { read, reload } = useRead((signal) => readChangelog(api, { area, breaking }, signal), [api, area, breaking]);
  return (
    <div className="pub-page" data-testid="developers-changelog">
      <header className="pub-heading">
        <h1>{t('changelogTitle')}</h1>
        <p className="muted">{t('changelogLead')}</p>
      </header>
      <section className="pub-card">
        <label>
          {t('filterArea')}{' '}
          <select
            value={area ?? ''}
            onChange={(event) => setArea(event.target.value === '' ? null : (event.target.value as ChangelogAreaId))}
          >
            <option value="">{t('filterAll')}</option>
            {CHANGELOG_AREA_IDS.map((id) => (
              <option key={id} value={id}>
                {t(`area_${id}` as const)}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          <input type="checkbox" checked={breaking} onChange={(event) => setBreaking(event.target.checked)} /> {t('filterBreaking')}
        </label>{' '}
        <a className="text-link" href="/developers/changelog/upcoming">
          {t('upcomingLink')} →
        </a>
      </section>
      {read.status === 'loading' ? (
        <StateBlock kind="loading" rows={3} rowHeight={72} label={t('loading')} />
      ) : read.status === 'failed' ? (
        <StateBlock kind="error" title={t('loadFailed')} onRetry={reload} retryLabel={t('tryAgain')} />
      ) : (
        <ChangelogList entries={read.data} />
      )}
      <a className="text-link" href="/developers">
        ← {t('back')}
      </a>
    </div>
  );
}

function Items({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <p>
      <strong>{title}</strong>:{' '}
      {items.map((item, index) => (
        <span key={item}>
          {index === 0 ? '' : ', '}
          <code>{item}</code>
        </span>
      ))}
    </p>
  );
}

export function ChangelogList({ entries }: { entries: readonly ChangelogEntry[] }) {
  const { t } = liveCopy.useCopy();
  if (entries.length === 0)
    return (
      <section className="pub-notice" role="status">
        <p>{t('changelogNone')}</p>
      </section>
    );
  return (
    <>
      {entries.map((entry) => {
        const log = entry.changelog;
        return (
          <article className="pub-card" key={entry.id} data-breaking={log?.breaking ? 'true' : 'false'}>
            <h2>{entry.title}</h2>
            <p className="muted">
              {log ? t(`area_${log.area}` as const) : t('areaNotSet')}
              {log?.breaking ? ` · ${t('breaking')}` : ''}
              {entry.publishedAt ? ` · ${entry.publishedAt.slice(0, 10)}` : ''}
              {log
                ? ` · ${t('addedOn', { date: log.addedOn ?? t('dateNotSet') })} · ${t('releaseOn', { date: log.releaseOn ?? t('dateNotSet') })}`
                : ''}
            </p>
            <p>{entry.body}</p>
            {log ? (
              <>
                <Items title={t('endpointsTitle')} items={log.endpoints} />
                <Items title={t('scopesTitle')} items={log.scopes} />
                <Items title={t('retiredTitle')} items={log.retired} />
                {log.before && log.after ? (
                  <div>
                    <h3>{t('beforeTitle')}</h3>
                    <pre>{log.before}</pre>
                    <h3>{t('afterTitle')}</h3>
                    <pre>{log.after}</pre>
                  </div>
                ) : null}
                {log.migrationNote ? (
                  <p>
                    <strong>{t('migrationTitle')}</strong>: {log.migrationNote}
                  </p>
                ) : null}
              </>
            ) : null}
          </article>
        );
      })}
    </>
  );
}

/** /developers/changelog/upcoming: breaking changes not yet in effect, and every retired endpoint. */
export function UpcomingPage() {
  const { t } = liveCopy.useCopy();
  const { api } = useSession();
  const { read, reload } = useRead((signal) => readUpcomingChanges(api, signal), [api]);
  return (
    <div className="pub-page" data-testid="developers-upcoming">
      <header className="pub-heading">
        <h1>{t('upcomingTitle')}</h1>
        <p className="muted">{t('upcomingLead')}</p>
      </header>
      {read.status === 'loading' ? (
        <StateBlock kind="loading" rows={3} rowHeight={72} label={t('loading')} />
      ) : read.status === 'failed' ? (
        <StateBlock kind="error" title={t('loadFailed')} onRetry={reload} retryLabel={t('tryAgain')} />
      ) : (
        <UpcomingView data={read.data} />
      )}
      <a className="text-link" href="/developers/changelog">
        ← {t('changelogBack')}
      </a>
    </div>
  );
}

export function UpcomingView({ data }: { data: UpcomingChanges }) {
  const { t } = liveCopy.useCopy();
  return (
    <>
      {data.upcoming.length === 0 ? (
        <section className="pub-notice" role="status">
          <p>{t('upcomingNone')}</p>
        </section>
      ) : (
        <ChangelogList entries={data.upcoming} />
      )}
      <section className="pub-card" aria-labelledby="up-retired">
        <h2 id="up-retired">{t('retiredListTitle')}</h2>
        {data.retired.length === 0 ? (
          <p>{t('retiredListNone')}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">{t('colEndpoint')}</th>
                <th scope="col">{t('colEntry')}</th>
                <th scope="col">{t('colDate')}</th>
              </tr>
            </thead>
            <tbody>
              {data.retired.map((row) => (
                <tr key={row.endpoint}>
                  <th scope="row">
                    <code>{row.endpoint}</code>
                  </th>
                  <td>{t('retiredBy', { title: row.title })}</td>
                  <td>{row.releaseOn ?? t('dateNotSet')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
