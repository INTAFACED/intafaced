import { readUpcomingChanges } from '../../shared/notify-reads';
import { useResource } from '../../shared/resource';
import { useSession } from '../session';
import { UpcomingView } from './changelog-list/ChangelogList';
import { liveCopy } from './developers-live-copy';

/**
 * Advance notice of breaking API changes on /notice (DV-versioning-02, J-developer-16 #4): the same read and list as
 * /developers/changelog/upcoming, so a developer who reads the public notices sees each cutover date and the retired list.
 * Drawn only from the Volt kit, so the notice room takes it as it is.
 */
export function BreakingChangesNotice() {
  const { t, requestedLocale } = liveCopy.useCopy();
  const { api } = useSession();
  const { resource } = useResource(
    (signal) => readUpcomingChanges(api, requestedLocale, signal),
    `notice-upcoming-changes:${requestedLocale}`,
  );
  // On /notice, only show developer API breaking changes when an operator has actually published one or retired an endpoint.
  if (resource.status !== 'ready' || (resource.data.upcoming.length === 0 && resource.data.retired.length === 0)) return null;
  return (
    <section className="lt-review" aria-labelledby="notice-breaking" data-testid="breaking-changes">
      <h2 id="notice-breaking" className="lt-sheet-title">
        {t('upcomingTitle')}
      </h2>
      <p className="lt-hint">{t('upcomingLead')}</p>
      <UpcomingView data={resource.data} language={requestedLocale} />
      <a className="lt-link" href="/developers/changelog">
        {t('changelogBack')}
      </a>
    </section>
  );
}
