// volt-room: /developers/changelog
// volt-room: /developers/changelog/upcoming
import { useState } from 'react';
import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { useSession } from '../session';
import { liveCopy } from './developers-live-copy';
import { CHANGELOG_AREA_IDS, readChangelog, readUpcomingChanges, type ChangelogAreaId } from '../../shared/notify-reads';
import { useRead } from './use-read';
import { ReadFailed, ReadLoading } from './ReadState';
import { ChangelogList, UpcomingView } from './changelog-list/ChangelogList';

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
