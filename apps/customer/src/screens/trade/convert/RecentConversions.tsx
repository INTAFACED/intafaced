import { refusalCopy } from '../buy/deps';
import { EmptyState, useActivity } from './deps';
import { convertCopy } from './copy';
import { recentPanelState } from './recent';

const ACTIVITY_HREF = '/money/activity?tab=all';

/**
 * Recent conversions (TRMKT R3). Parked until the conversion history read (TRD-0857) exists: Activity cannot tell a
 * conversion from a zero-fee spot order, so the panel names the blocker instead of listing or claiming "none". A
 * failed or refused ledger read keeps its own typed state.
 */
export function RecentConversions() {
  const { t } = convertCopy.useCopy();
  const activity = useActivity();
  const panel = recentPanelState(activity);
  const refused = activity.status === 'refused' ? refusalCopy(activity.code) : null;

  return (
    <section className="cvt-recent" aria-labelledby="cvt-recent-title" data-testid="cvt-recent">
      <div className="cvt-recent__head">
        <h2 id="cvt-recent-title">{t('Recent conversions')}</h2>
        <a className="cvt-recent__all" href={ACTIVITY_HREF}>
          {t('View activity')}
        </a>
      </div>
      {refused ? (
        <EmptyState
          variant="refused"
          title={refused.title}
          reason={refused.body}
          code={refused.reference}
          action={refused.action ? { label: refused.action.label, href: refused.action.href } : undefined}
        />
      ) : activity.status === 'error' ? (
        <EmptyState
          size="inline"
          variant="unavailable"
          title={t('Recent error title')}
          reason={t('Recent error body')}
          action={{ label: t('Retry'), onClick: activity.retry, variant: 'secondary' }}
        />
      ) : (
        <EmptyState
          size="inline"
          variant="unavailable"
          title={t('Recent parked title')}
          reason={t('Recent parked body')}
          action={{ label: t('View activity'), href: ACTIVITY_HREF, variant: 'secondary' }}
        />
      )}
    </section>
  );
}
