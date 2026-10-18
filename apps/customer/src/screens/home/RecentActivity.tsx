import { dayTime } from './clock';
import { homeCopy } from './copy';
import { Amount, fmtAmount, Skeleton, StateBlock, type ActivityFeed, type ActivityItem, type Loadable } from './deps';
import { HOME_LINKS } from './links';
import { STATE_IN_COLUMN } from './panel';
import { usePreferences } from '../../shared/preferences';

const SHOWN = 5;

const LABEL = {
  deposit: 'Activity deposit',
  welcome_funds: 'Activity welcome_funds',
  transfer_in: 'Activity transfer_in',
  transfer_out: 'Activity transfer_out',
  trade: 'Activity trade',
  fee: 'Activity fee',
  payment: 'Activity payment',
  withdrawal: 'Activity withdrawal',
  space_move: 'Activity space_move',
  order_hold: 'Activity order_hold',
  order_release: 'Activity order_release',
  other: 'Activity other',
} as const satisfies Record<ActivityItem['kind'], string>;

/**
 * The last few money movements. An account with none gets one honest line, not a blank box: nothing is invented to
 * fill it. The full history is the Activity screen under Money.
 */
export function RecentActivity({ activity, hidden }: { activity: Loadable<ActivityFeed>; hidden: boolean }) {
  const { t } = homeCopy.useCopy();
  const { timeZone } = usePreferences();
  return (
    <section className="home-section" aria-labelledby="home-activity-title">
      <div className="home-section__head">
        <h2 className="home-h2" id="home-activity-title">
          {t('Recent activity')}
        </h2>
        {activity.status === 'ready' ? (
          <a className="home-link" href={HOME_LINKS.activity}>
            {t('See all')}
          </a>
        ) : null}
      </div>
      {activity.status === 'loading' ? (
        <div className="home-activity" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <div className="home-activity__row" key={index}>
              <Skeleton width={120} height={36} />
              <Skeleton width={88} height={20} />
            </div>
          ))}
        </div>
      ) : activity.status === 'empty' ? (
        <StateBlock kind="empty" className={STATE_IN_COLUMN} title={t('No activity yet')} body={t('No activity body')} />
      ) : activity.status === 'ready' ? (
        <ul className="home-activity">
          {activity.data.items.slice(0, SHOWN).map((item) => {
            const when = dayTime(item.postedAt, timeZone);
            return (
              <li key={item.id} className="home-activity__row">
                <span className="home-activity__what">
                  <span className="home-activity__kind">{t(LABEL[item.kind])}</span>
                  {when ? <span className="home-activity__when">{when}</span> : null}
                </span>
                <Amount
                  className="home-activity__amount"
                  value={`${item.direction === 'in' ? '+' : '−'}${fmtAmount(item.amount, { round: 'down' })} ${item.asset}`}
                  hidden={hidden}
                />
              </li>
            );
          })}
        </ul>
      ) : activity.status === 'error' ? (
        <StateBlock
          kind="error"
          className={STATE_IN_COLUMN}
          title={t('Couldn’t load your activity')}
          onRetry={activity.retry}
          retryLabel={t('Try again')}
        />
      ) : (
        <StateBlock kind="empty" className={STATE_IN_COLUMN} title={t('Couldn’t load your activity')} />
      )}
    </section>
  );
}
