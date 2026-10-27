import { dayTime } from './clock';
import { homeCopy } from './copy';
import {
  Amount,
  classifyRefusal,
  detailHref,
  fmtAmount,
  groupActivity,
  refusalCopy,
  Skeleton,
  StateBlock,
  type ActivityFeed,
  type ActivityItem,
  type Loadable,
} from './deps';
import { HOME_LINKS } from './links';
import { STATE_IN_COLUMN } from './panel';
import { usePreferences } from '../../shared/preferences';

/** How many movements Home lists: a glance, not the history (J-home-ia-01 #5). The Activity room has the rest. */
const SHOWN = 3;

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
 * The last few money movements, newest first, grouped as the Activity room groups them (one trade is one row), each
 * opening its own record. Amounts are the service's decimal strings
 * to their last digit, never rounded for the list. An account with none gets one honest line, not a blank box: nothing is invented to
 * fill it. The full history is the Activity screen under Money.
 */
export function RecentActivity({
  activity,
  hidden,
  className = 'home-section',
  testId,
}: {
  activity: Loadable<ActivityFeed>;
  hidden: boolean;
  className?: string;
  testId?: string;
}) {
  const { t } = homeCopy.useCopy();
  const { timeZone } = usePreferences();
  return (
    <section data-testid={testId} className={className} aria-labelledby="home-activity-title">
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
        <div data-testid="home-activity" className="home-activity" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <div data-testid="home-activity__row" className="home-activity__row" key={index}>
              <Skeleton width={120} height={36} />
              <Skeleton width={88} height={20} />
            </div>
          ))}
        </div>
      ) : activity.status === 'empty' ? (
        <StateBlock kind="empty" className={STATE_IN_COLUMN} title={t('No activity yet')} body={t('No activity body')} />
      ) : activity.status === 'ready' ? (
        <ul data-testid="home-activity" className="home-activity">
          {groupActivity(activity.data.items)
            .groups.slice(0, SHOWN)
            .map((group) => {
              const item = group.main;
              const when = dayTime(item.postedAt, timeZone);
              return (
                <li key={group.id}>
                  <a data-testid="home-activity__row" className="home-activity__row" href={detailHref(group)}>
                    <span className="home-activity__what">
                      <span data-testid="home-activity__kind" className="home-activity__kind">
                        {t(LABEL[item.kind])}
                      </span>
                      {when ? (
                        <span data-testid="home-activity__when" className="home-activity__when">
                          {when}
                        </span>
                      ) : null}
                    </span>
                    <Amount
                      data-testid="home-activity__amount"
                      className="home-activity__amount"
                      value={`${item.direction === 'in' ? '+' : '−'}${fmtAmount(item.amount, { places: 18 })} ${item.asset}`}
                      hidden={hidden}
                    />
                  </a>
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
    return (
      <StateBlock kind="empty" className={STATE_IN_COLUMN} title={t('Activity after verify')} body={t('Activity after verify body')} />
    );
  const copy = refusalCopy(code);
  return (
    <StateBlock kind="refused" className={STATE_IN_COLUMN} title={copy.title} body={copy.body} code={copy.reference} action={copy.action} />
  );
}
