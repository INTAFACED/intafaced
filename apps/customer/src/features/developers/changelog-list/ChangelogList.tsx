import type { ChangelogEntry, UpcomingChanges } from '../../../shared/notify-reads';
import { liveCopy } from '../developers-live-copy';

/** One list of names in an entry (endpoints, scopes, retired), each in code type; nothing when there are none. */
function Items({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <p>
      <strong>{title}</strong>:{' '}
      {items.map((item, index) => (
        <span key={item}>
          {index === 0 ? '' : ', '}
          <code className="lt-mono">{item}</code>
        </span>
      ))}
    </p>
  );
}

/**
 * The entries, each marked with the language its text is in (`lang`). An entry with no text in the reader's language
 * shows its English source and says so, rather than passing it off as a translation. Drawn from the Volt kit, once, for
 * /developers/changelog, /developers/changelog/upcoming and the /notice advance notice.
 */
export function ChangelogList({ entries, language }: { entries: readonly ChangelogEntry[]; language?: string }) {
  const { t } = liveCopy.useCopy();
  if (entries.length === 0)
    return (
      <section className="lt-empty" role="status">
        <p className="lt-empty-body">{t('changelogNone')}</p>
      </section>
    );
  return (
    <>
      {entries.map((entry) => {
        const log = entry.changelog;
        return (
          <article
            className="lt-region"
            key={entry.id}
            data-breaking={log?.breaking ? 'true' : 'false'}
            {...(entry.language ? { lang: entry.language, 'data-language': entry.language } : {})}
          >
            <h2 className="lt-sheet-title">{entry.title}</h2>
            {language && entry.language && entry.language !== language ? (
              <p className="lt-hint" lang={language} data-testid="changelog-not-in-language">
                {t('notInLanguage')}
              </p>
            ) : null}
            <p className="lt-hint">
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
                    <pre className="lt-mono">{log.before}</pre>
                    <h3>{t('afterTitle')}</h3>
                    <pre className="lt-mono">{log.after}</pre>
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

/** Breaking changes not yet in effect, and every retired endpoint with the entry that retired it. */
export function UpcomingView({ data, language }: { data: UpcomingChanges; language?: string }) {
  const { t } = liveCopy.useCopy();
  return (
    <>
      {data.upcoming.length === 0 ? (
        <section className="lt-empty" role="status">
          <p className="lt-empty-body">{t('upcomingNone')}</p>
        </section>
      ) : (
        <ChangelogList entries={data.upcoming} language={language} />
      )}
      <section className="lt-region" aria-labelledby="up-retired">
        <h2 id="up-retired" className="lt-sheet-title">
          {t('retiredListTitle')}
        </h2>
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
                    <code className="lt-mono">{row.endpoint}</code>
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
