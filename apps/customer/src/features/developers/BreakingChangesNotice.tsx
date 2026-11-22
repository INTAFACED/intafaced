import { readUpcomingChanges } from '../../shared/notify-reads';
import { useResource } from '../../shared/resource';
import { useSession } from '../session';
import { UpcomingView } from './ChangelogPages';
import { liveCopy } from './developers-live-copy';
import { ReadFailed, ReadLoading } from './ReadState';

/**
 * Advance notice of breaking API changes on /notice (DV-versioning-02, J-developer-16 #4): the same read and list as
 * /developers/changelog/upcoming, so a developer who reads the public notices sees each cutover date and the retired list.
 */
export function BreakingChangesNotice() {
  const { t, requestedLocale } = liveCopy.useCopy();
  const { api } = useSession();
  const { resource, reload } = useResource(
    (signal) => readUpcomingChanges(api, requestedLocale, signal),
    `notice-upcoming-changes:${requestedLocale}`,
  );
  return (
    <section className="lt-stack" aria-labelledby="notice-breaking" data-testid="breaking-changes">
      <h2 id="notice-breaking">{t('upcomingTitle')}</h2>
      <p className="lt-hint">{t('upcomingLead')}</p>
      {resource.status === 'loading' ? (
        <ReadLoading label={t('loading')} rows={2} />
      ) : resource.status === 'failed' ? (
        <ReadFailed title={t('loadFailed')} onRetry={reload} retryLabel={t('tryAgain')} />
      ) : (
        <UpcomingView data={resource.data} language={requestedLocale} />
      )}
      <a className="lt-link lt-link-alone" href="/developers/changelog">
        {t('changelogBack')} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
      </a>
    </section>
  );
}
