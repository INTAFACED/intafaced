// volt-room: /developers/changelog
// volt-room: /developers/changelog/upcoming
import { useState } from 'react';
import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { useSession } from '../session';
import { liveCopy } from './developers-live-copy';
import {
  CHANGELOG_AREA_IDS,
  readChangelog,
  readUpcomingChanges,
  type ChangelogAreaId,
  type ChangelogEntry,
  type UpcomingChanges,
} from '../../shared/notify-reads';
import { useRead } from './use-read';
import { ReadFailed, ReadLoading } from './ReadState';

/** /developers/changelog: published entries newest first, filtered by area and by the breaking flag. */
export function ChangelogPage() {
  const { t, requestedLocale } = liveCopy.useCopy();
  const { api } = useSession();
  const [area, setArea] = useState<ChangelogAreaId | null>(null);
  const [breaking, setBreaking] = useState(false);
  // Read again when the reader picks another language: each entry comes in it when the operator wrote it.
  const { read, reload } = useRead(
    (signal) => readChangelog(api, { area, breaking }, requestedLocale, signal),
    [api, area, breaking, requestedLocale],
  );
  return (
    <div data-testid="developers-changelog">
      <ReadingTemplate
        title={t('changelogTitle')}
        description={t('changelogLead')}
        state={{ kind: 'ready' }}
        meta={
          <div className="lt-actions">
            <label className="lt-field">
              <span>{t('filterArea')}</span>
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
            </label>
            <label className="lt-field">
              <input type="checkbox" checked={breaking} onChange={(event) => setBreaking(event.target.checked)} /> {t('filterBreaking')}
            </label>
            <a className="lt-link lt-link-alone" href="/developers/changelog/upcoming">
              {t('upcomingLink')} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
            </a>
          </div>
        }
        body={
          read.status === 'loading' ? (
            <ReadLoading rows={3} label={t('loading')} />
          ) : read.status === 'failed' ? (
            <ReadFailed title={t('loadFailed')} onRetry={reload} retryLabel={t('tryAgain')} />
          ) : (
            <ChangelogList entries={read.data} language={requestedLocale} />
          )
        }
        footer={
          <a className="lt-link lt-link-alone" href="/developers">
            <span className="lt-arrow lt-arrow-back" aria-hidden="true" /> {t('back')}
          </a>
        }
      />
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

/**
 * The entries, each marked with the language its text is in (`lang`). An entry with no text in the reader's language
 * shows its English source and says so, rather than passing it off as a translation.
 */
export function ChangelogList({ entries, language }: { entries: readonly ChangelogEntry[]; language?: string }) {
  const { t } = liveCopy.useCopy();
  if (entries.length === 0)
    return (
      <section role="status">
        <p>{t('changelogNone')}</p>
      </section>
    );
  return (
    <>
      {entries.map((entry) => {
        const log = entry.changelog;
        return (
          <article
            key={entry.id}
            data-breaking={log?.breaking ? 'true' : 'false'}
            {...(entry.language ? { lang: entry.language, 'data-language': entry.language } : {})}
          >
            <h2>{entry.title}</h2>
            {language && entry.language && entry.language !== language ? (
              <p lang={language} data-testid="changelog-not-in-language">
                {t('notInLanguage')}
              </p>
            ) : null}
            <p>
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
  const { t, requestedLocale } = liveCopy.useCopy();
  const { api } = useSession();
  const { read, reload } = useRead((signal) => readUpcomingChanges(api, requestedLocale, signal), [api, requestedLocale]);
  return (
    <div data-testid="developers-upcoming">
      <ReadingTemplate
        title={t('upcomingTitle')}
        description={t('upcomingLead')}
        state={{ kind: 'ready' }}
        body={
          read.status === 'loading' ? (
            <ReadLoading rows={3} label={t('loading')} />
          ) : read.status === 'failed' ? (
            <ReadFailed title={t('loadFailed')} onRetry={reload} retryLabel={t('tryAgain')} />
          ) : (
            <UpcomingView data={read.data} language={requestedLocale} />
          )
        }
        footer={
          <a className="lt-link lt-link-alone" href="/developers/changelog">
            <span className="lt-arrow lt-arrow-back" aria-hidden="true" /> {t('changelogBack')}
          </a>
        }
      />
    </div>
  );
}

export function UpcomingView({ data, language }: { data: UpcomingChanges; language?: string }) {
  const { t } = liveCopy.useCopy();
  return (
    <>
      {data.upcoming.length === 0 ? (
        <section role="status">
          <p>{t('upcomingNone')}</p>
        </section>
      ) : (
        <ChangelogList entries={data.upcoming} language={language} />
      )}
      <section aria-labelledby="up-retired">
        <h2 id="up-retired">{t('retiredListTitle')}</h2>
        {data.retired.length === 0 ? (
          <p>{t('retiredListNone')}</p>
        ) : (
          <table className="lt-table">
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
