import { dayTime } from './clock';
import { homeCopy } from './copy';
import {
  classifyRefusal,
  detailHref,
  fmtAmount,
  groupActivity,
  refusalCopy,
  type ActivityFeed,
  type ActivityItem,
  type Loadable,
} from './deps';
import { HOME_LINKS } from './links';
import { Amount, Ghost, StateBlock } from './volt-parts';
import { usePreferences } from '../../shared/preferences';
import { RECENT_ACTIVITY_LIMIT_UNSET } from '@intafaced/contracts/home-work-items';
import type { ActivityLimit } from './recent-activity-limit';

const LABEL = {
  deposit: 'Activity deposit',
  welcome_funds: 'Activity welcome_funds',
  transfer_in: 'Activity transfer_in',
  transfer_out: 'Activity transfer_out',
  trade: 'Activity trade',
  convert: 'Activity convert',
  fee: 'Activity fee',
  payment: 'Activity payment',
  withdrawal: 'Activity withdrawal',
  space_move: 'Activity space_move',
  earn: 'Activity earn',
  staking: 'Activity staking',
  reward: 'Activity reward',
  order_hold: 'Activity order_hold',
  order_release: 'Activity order_release',
  other: 'Activity other',
} as const satisfies Record<ActivityItem['kind'], string>;

/**
 * The newest money movements, as many as the owner's `recentActivityLimit` (J-home-ia-01 #5; blank says "not set"),
 * newest first, grouped as the Activity room groups them (one trade is one row), each
 * opening its own record. Amounts are the service's decimal strings
 * to their last digit, never rounded for the list. An account with none gets one honest line, not a blank box: nothing is invented to
 * fill it. The full history is the Activity screen under Money.
 */
export function RecentActivity({
  activity,
  limit,
  hidden,
  testId,
}: {
  activity: Loadable<ActivityFeed>;
  /** The owner's count of rows (`useRecentActivityLimit`). */
  limit: ActivityLimit;
  hidden: boolean;
  testId?: string;
}) {
  const { t } = homeCopy.useCopy();
  const { timeZone } = usePreferences();
  return (
    <section data-testid={testId} className="lt-stack" aria-labelledby="home-activity-title">
      <div className="lt-title-row">
        <h2 id="home-activity-title">{t('Recent activity')}</h2>
        {activity.status === 'ready' && limit.state !== 'loading' ? (
          <a className="lt-link" href={HOME_LINKS.activity}>
            {t('See all')}
          </a>
        ) : null}
      </div>
      {limit.state === 'unset' ? (
        <StateBlock
          kind="refused"
          title={t('Activity limit unset')}
          body={t('Activity limit unset body')}
          code={RECENT_ACTIVITY_LIMIT_UNSET}
        />
      ) : limit.state === 'failed' ? (
        <StateBlock kind="error" title={t('Couldn’t load your activity')} onRetry={limit.retry} retryLabel={t('Try again')} />
      ) : activity.status === 'loading' || limit.state === 'loading' ? (
        <div data-testid="home-activity" aria-hidden="true">
          <div data-testid="home-activity__row">
            <Ghost shape="rows" count={3} />
          </div>
        </div>
      ) : activity.status === 'empty' ? (
        <StateBlock kind="empty" title={t('No activity yet')} body={t('No activity body')} />
      ) : activity.status === 'ready' ? (
        <ul data-testid="home-activity" className="lt-rows">
          {groupActivity(activity.data.items)
            .groups.slice(0, limit.count)
            .map((group) => {
              const item = group.main;
              const when = dayTime(item.postedAt, timeZone);
              return (
                <li key={group.id}>
                  <a data-testid="home-activity__row" className="lt-row-link" href={detailHref(group)}>
                    <span className="lt-lines">
                      <span data-testid="home-activity__kind">{t(LABEL[item.kind])}</span>
                      {when ? (
                        <span data-testid="home-activity__when" className="lt-hint">
                          {when}
                        </span>
                      ) : null}
                    </span>
                    <Amount
                      testId="home-activity__amount"
                      value={`${item.direction === 'in' ? '+' : '−'}${fmtAmount(item.amount, { places: 18 })} ${item.asset}`}
                      hidden={hidden}
                    />
                  </a>
                </li>
              );
            })}
        </ul>
      ) : activity.status === 'error' ? (
        <StateBlock kind="error" title={t('Couldn’t load your activity')} onRetry={activity.retry} retryLabel={t('Try again')} />
      ) : (
        <Refused code={activity.code} />
      )}
    </section>
  );
}

/**
 * The service said no: its reason, never a bare failure. The one exception is "verify first": Home's summary already
 * asks for that with its own Verify now, so this card says only what it will hold, without a second copy of the ask.
 */
function Refused({ code }: { code: string }) {
  const { t } = homeCopy.useCopy();
  if (classifyRefusal(code) === 'verify')
    return <StateBlock kind="empty" title={t('Activity after verify')} body={t('Activity after verify body')} />;
  const copy = refusalCopy(code);
  return <StateBlock kind="refused" title={copy.title} body={copy.body} code={copy.reference} action={copy.action} />;
}
