import { useEffect, useMemo, useRef } from 'react';
import {
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  ArrowUpRight,
  CircleDot,
  CreditCard,
  Check,
  Gift,
  Lock,
  LockOpen,
  Receipt,
  Repeat,
  type LucideIcon,
} from 'lucide-react';
import {
  groupActivity,
  inTab,
  isLedgerTab,
  tabFromSearch,
  tabHref,
  titleOf,
  tradeDetail,
  TABS,
  type ActivityGroup,
  type LedgerTab,
  type Tab,
} from './activity-view';
import { OrdersPanel, TradesPanel } from './TradeTabs';
import { moneyCopy } from './copy';
import {
  Amount,
  Button,
  fmtAmount,
  isHiddenPath,
  navigate,
  refusalCopy,
  Skeleton,
  StateBlock,
  Tabs,
  TabsList,
  TabsTab,
  useActivity,
  type ActivityFeed,
  type ActivityItem,
  type ActivityKind,
  type Loadable,
} from './deps';
import { buyHref } from './links';
import { stamp } from './time';
import { currentPreferences, usePreferences } from '../../shared/preferences';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

const ICON: Record<ActivityKind, LucideIcon> = {
  deposit: ArrowDownToLine,
  welcome_funds: Gift,
  transfer_in: ArrowDownLeft,
  transfer_out: ArrowUpRight,
  trade: Repeat,
  fee: Receipt,
  payment: CreditCard,
  withdrawal: ArrowUpFromLine,
  space_move: ArrowLeftRight,
  order_hold: Lock,
  order_release: LockOpen,
  other: CircleDot,
};

/** A tab shows at least this many rows before it stops looking further back on its own. */
const WANT_ROWS = 10;
/** ...and looks back at most this many extra pages by itself; after that the person presses "Load more". */
const AUTO_PAGES = 4;

const TAB_LABEL: Record<Tab, 'All' | 'Deposits' | 'Transfers' | 'Trades' | 'Orders'> = {
  trades: 'Trades',
  orders: 'Orders',
  all: 'All',
  deposits: 'Deposits',
  transfers: 'Transfers',
};
const TAB_EMPTY: Record<Exclude<LedgerTab, 'all'>, 'No deposits yet' | 'No transfers yet'> = {
  deposits: 'No deposits yet',
  transfers: 'No transfers yet',
};

function Row({ group, copy, hidden }: { group: ActivityGroup; copy: Copy; hidden: boolean }) {
  const { t } = copy;
  const { timeZone } = usePreferences();
  const item = group.main;
  const Icon = ICON[item.kind];
  const title = titleOf(item, t, (key, handle) => t(key, { handle }));
  const up = item.direction === 'in';
  const amount = fmtAmount(item.amount);
  const holding = item.kind === 'order_hold';
  let sub: string | null = item.spaceName ? t('In account {name}', { name: item.spaceName }) : null;
  if (item.kind === 'trade') {
    const { counter, fees } = tradeDetail(group);
    const parts = [
      counter
        ? t(
            counter.direction === 'out'
              ? counter.asset === 'USDT' || counter.asset === 'USDC'
                ? 'Paid {amount} {asset}'
                : 'Gave {amount} {asset}'
              : 'Got {amount} {asset}',
            {
              amount: fmtAmount(counter.amount),
              asset: counter.asset,
            },
          )
        : null,
      ...fees.map((fee) => t('Fee {amount} {asset}', { amount: fmtAmount(fee.amount), asset: fee.asset })),
    ].filter((part): part is string => part !== null);
    sub = parts.length > 0 ? parts.join(' · ') : null;
  }
  return (
    <tr className="money-act" data-kind={item.kind}>
      <td>
        <div className="money-act__what">
          <span className="money-act__icon" data-direction={item.direction} aria-hidden="true">
            <Icon size={18} />
          </span>
          <span className="money-act__text">
            <span className="money-act__title">{title}</span>
            {sub ? <span className="money-act__sub">{sub}</span> : null}
          </span>
        </div>
      </td>
      <td className="money-act__time">
        <time dateTime={item.postedAt}>{stamp(item.postedAt, timeZone)}</time>
      </td>
      <td className="money-num">
        <Amount
          value={`${up ? '+' : '−'}${amount} ${item.asset}`}
          hidden={hidden}
          className={holding ? undefined : up ? 'text-up-text' : 'text-down-text'}
          data-direction={item.direction}
        />
      </td>
      <td className="money-act__status money-cell--status">
        {holding ? (
          <span className="money-act__hold">{t('Set aside')}</span>
        ) : (
          <span className="money-act__done">
            <Check size={14} aria-hidden="true" />
            {t('Completed')}
          </span>
        )}
      </td>
    </tr>
  );
}

function SkeletonRows({ count, label }: { count: number; label: string }) {
  return (
    <div aria-busy="true" role="status" aria-label={label} className="money-act-skeleton">
      {Array.from({ length: count }, (_, index) => (
        <div className="money-act-skeleton__row" key={index}>
          <Skeleton width={32} height={32} circle className="bg-field" />
          <Skeleton width={180} height={20} className="bg-field" />
          <span className="money-skeleton-gap" />
          <Skeleton width={120} height={20} className="bg-field" />
          <Skeleton width={110} height={20} className="bg-field" />
          <Skeleton width={84} height={20} className="bg-field" />
        </div>
      ))}
    </div>
  );
}

function emptyAction(copy: Copy) {
  const { t } = copy;
  const buy = buyHref(null, null, false, currentPreferences().layoutMode === 'pro' ? 'pro' : 'simple');
  if (buy) return { label: t('Buy crypto'), href: buy };
  return isHiddenPath('/pay/receive') ? undefined : { label: t('Receive'), href: '/pay/receive' };
}

function Body({ feed, tab, copy, hidden }: { feed: ActivityFeed; tab: LedgerTab; copy: Copy; hidden: boolean }) {
  const { t } = copy;
  const { groups, holdLines } = useMemo(() => groupActivity(feed.items), [feed.items]);
  const rows = groups.filter((group) => inTab(group.main, tab));
  const pages = useRef(0);

  // The server has no kind filter, so a narrow tab may be thin: look further back a few pages, then ask.
  useEffect(() => {
    pages.current = 0;
  }, [tab]);
  useEffect(() => {
    if (tab === 'all' || !feed.hasMore || feed.loadingMore || feed.moreFailed) return;
    if (rows.length >= WANT_ROWS || pages.current >= AUTO_PAGES) return;
    pages.current += 1;
    feed.loadMore();
  }, [tab, rows.length, feed]);

  const searching = tab !== 'all' && rows.length === 0 && feed.hasMore && pages.current < AUTO_PAGES && !feed.moreFailed;
  if (rows.length === 0 && !searching)
    return (
      <StateBlock
        kind="empty"
        className="money-state"
        title={t(tab === 'all' ? 'No activity yet' : TAB_EMPTY[tab])}
        body={tab === 'all' ? t('No activity yet body') : t('Nothing of this kind yet body')}
        action={tab === 'all' ? emptyAction(copy) : undefined}
      />
    );
  if (rows.length === 0) return <SkeletonRows count={4} label={t('Searching your history')} />;

  return (
    <>
      {tab === 'all' && holdLines > 0 ? <p className="money-act-note">{t('Holds not listed note')}</p> : null}
      <table className="money-table money-table--activity">
        <colgroup>
          <col className="money-act-col--what" />
          <col className="money-act-col--time" />
          <col className="money-act-col--amount" />
          <col className="money-act-col--status money-cell--status" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">{t('Activity')}</th>
            <th scope="col">{t('Date')}</th>
            <th scope="col" className="money-num">
              {t('Amount')}
            </th>
            <th scope="col" className="money-cell--status">
              {t('Status')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((group) => (
            <Row key={group.id} group={group} copy={copy} hidden={hidden} />
          ))}
        </tbody>
      </table>
      {feed.hasMore ? (
        <div className="money-more">
          {feed.moreFailed ? <p className="money-more__note">{t('Couldn’t load more')}</p> : null}
          <Button variant="secondary" size={40} loading={feed.loadingMore} onClick={feed.loadMore}>
            {feed.moreFailed ? t('Try again') : t('Load more')}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function Content({ activity, tab, copy, hidden }: { activity: Loadable<ActivityFeed>; tab: LedgerTab; copy: Copy; hidden: boolean }) {
  const { t } = copy;
  switch (activity.status) {
    case 'loading':
      return <SkeletonRows count={8} label={t('Loading activity')} />;
    case 'error':
      return (
        <StateBlock
          kind="error"
          className="money-state"
          title={t('Couldn’t load your activity')}
          onRetry={activity.retry}
          retryLabel={t('Try again')}
        />
      );
    case 'refused': {
      const words = refusalCopy(activity.code);
      return (
        <StateBlock
          kind="refused"
          className="money-state"
          title={words.title}
          body={words.body}
          code={words.reference}
          action={words.action}
        />
      );
    }
    case 'empty':
      return (
        <StateBlock
          kind="empty"
          className="money-state"
          title={t('No activity yet')}
          body={t('No activity yet body')}
          action={emptyAction(copy)}
        />
      );
    case 'ready':
      return <Body feed={activity.data} tab={tab} copy={copy} hidden={hidden} />;
  }
}

/** The ledger-based tabs (All, Deposits, Transfers). Mounted only on those tabs, so the other two never read the ledger. */
function LedgerTabs({ tab, copy, hidden }: { tab: LedgerTab; copy: Copy; hidden: boolean }) {
  const activity = useActivity();
  return <Content activity={activity} tab={tab} copy={copy} hidden={hidden} />;
}

export default function Activity({ search }: { search: string }) {
  const copy = moneyCopy.useCopy();
  const { t } = copy;
  const { hideBalances, layoutMode } = usePreferences();
  const tab = tabFromSearch(search);
  return (
    <div className="if-money if-money--activity" data-density={layoutMode === 'pro' ? 'pro' : undefined}>
      <h1 className="money-title">{t('Activity')}</h1>
      <Tabs value={tab} onValueChange={(next) => navigate(tabHref(next as Tab))}>
        <TabsList divider aria-label={t('Activity filters')} className="money-tabs">
          {TABS.map((id) => (
            <TabsTab key={id} value={id}>
              {t(TAB_LABEL[id])}
            </TabsTab>
          ))}
        </TabsList>
      </Tabs>
      <section className="money-card money-card--activity" aria-label={t('Activity')}>
        {tab === 'trades' ? (
          <TradesPanel />
        ) : tab === 'orders' ? (
          <OrdersPanel />
        ) : isLedgerTab(tab) ? (
          <LedgerTabs tab={tab} copy={copy} hidden={hideBalances} />
        ) : null}
      </section>
    </div>
  );
}
