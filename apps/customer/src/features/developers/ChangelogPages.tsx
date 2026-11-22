import { useState } from 'react';
import { StateBlock } from '@intafaced/ui';
import { useSession } from '../session';
import { liveCopy } from './developers-live-copy';
import { CHANGELOG_AREA_IDS, readChangelog, readUpcomingChanges, type ChangelogAreaId } from '../../shared/notify-reads';
import { useRead } from './use-read';
import { ChangelogList, UpcomingView } from './changelog-list/ChangelogList';
import '../../shared/public-pages.css';

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
        <ChangelogList entries={read.data} language={requestedLocale} />
      )}
      <a className="text-link" href="/developers">
        ← {t('back')}
      </a>
    </div>
  );
}

/** /developers/changelog/upcoming: breaking changes not yet in effect, and every retired endpoint. */
export function UpcomingPage() {
  const { t, requestedLocale } = liveCopy.useCopy();
  const { api } = useSession();
  const { read, reload } = useRead((signal) => readUpcomingChanges(api, requestedLocale, signal), [api, requestedLocale]);
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
        <UpcomingView data={read.data} language={requestedLocale} />
      )}
      <a className="text-link" href="/developers/changelog">
        ← {t('changelogBack')}
      </a>
    </div>
  );
}
