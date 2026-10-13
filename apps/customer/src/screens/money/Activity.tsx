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
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  assetFromSearch,
  groupActivity,
  groupInAsset,
  inTab,
  isLedgerTab,
  ledgerEmpty,
  tabFromSearch,
  tabHref,
  titleOf,
  type Money,
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
  quotePlaces,
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
  const cancelled = group.kind === 'cancelled';
  const title = cancelled ? t('Order cancelled · nothing spent') : titleOf(item, t, (key, handle) => t(key, { handle }));
  const up = item.direction === 'in';
  const amount = fmtAmount(item.amount);
  const holding = item.kind === 'order_hold';
  const places = (money: { asset: string; amount: string }) => fmtAmount(money.amount, { places: quotePlaces(money.asset), fixed: true });
  const say = (money: Money, key: 'Fee {amount} {asset}' | 'Set aside {amount} {asset}' | 'Returned {amount} {asset}') =>
    t(key, { amount: places(money), asset: money.asset });
  let sub: string | null = item.spaceName ? t('In account {name}', { name: item.spaceName }) : null;
  if (group.kind === 'trade') {
    const { counter } = group;
    const parts = [
      counter
        ? t(
            counter.direction === 'out'
              ? counter.asset === 'USDT' || counter.asset === 'USDC'
                ? 'Paid {amount} {asset}'
                : 'Gave {amount} {asset}'
              : 'Got {amount} {asset}',
            { amount: places(counter), asset: counter.asset },
          )
        : null,
      ...group.notes.map((note) => say(note, note.direction === 'out' ? 'Set aside {amount} {asset}' : 'Returned {amount} {asset}')),
      ...group.fees.map((fee) => say(fee, 'Fee {amount} {asset}')),
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
          value={cancelled ? `${amount} ${item.asset}` : `${up ? '+' : '−'}${amount} ${item.asset}`}
          hidden={hidden}
          className={holding || cancelled ? undefined : up ? 'text-up-text' : 'text-down-text'}
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

function Body({
  feed,
  tab,
  asset,
  copy,
  hidden,
}: {
  feed: ActivityFeed;
  tab: LedgerTab;
  asset: string | null;
  copy: Copy;
  hidden: boolean;
}) {
  const { t } = copy;
  const { groups } = useMemo(() => groupActivity(feed.items), [feed.items]);
  const rows = groups.filter((group) => inTab(group.main, tab) && (!asset || groupInAsset(group, asset)));
  const pages = useRef(0);

  // The server has no kind filter, so a narrow tab may be thin: look further back a few pages, then ask.
  useEffect(() => {
    pages.current = 0;
  }, [tab, asset]);
  useEffect(() => {
    if ((tab === 'all' && !asset) || !feed.hasMore || feed.loadingMore || feed.moreFailed) return;
    if (rows.length >= WANT_ROWS || pages.current >= AUTO_PAGES) return;
    pages.current += 1;
    feed.loadMore();
  }, [tab, asset, rows.length, feed]);

  const searching =
    (tab !== 'all' || asset !== null) && rows.length === 0 && feed.hasMore && pages.current < AUTO_PAGES && !feed.moreFailed;
  const more = feed.hasMore ? (
    <div className="money-more">
      {feed.moreFailed ? <p className="money-more__note">{t('Couldn’t load more')}</p> : null}
      <Button variant="secondary" size={40} loading={feed.loadingMore} onClick={feed.loadMore}>
        {feed.moreFailed ? t('Try again') : t('Load more')}
      </Button>
    </div>
  ) : null;
  if (rows.length === 0 && !searching) {
    // A filter that matches nothing in the pages read so far must not say there is nothing: older pages may match.
    const why = ledgerEmpty(tab, asset, feed.hasMore);
    const block =
      why === 'more' ? (
        <StateBlock
          kind="empty"
          className="money-state"
          title={
            asset
              ? t('No {asset} activity in the latest items', { asset })
              : t(tab === 'deposits' ? 'No deposits in the latest items' : 'No transfers in the latest items')
          }
          body={t('Load more to look further back')}
        />
      ) : why === 'asset' && asset ? (
        <StateBlock
          kind="empty"
          className="money-state"
          title={t('No {asset} activity', { asset })}
          body={t('No {asset} activity body', { asset })}
        />
      ) : (
        <StateBlock
          kind="empty"
          className="money-state"
          title={t(tab === 'all' ? 'No activity yet' : TAB_EMPTY[tab as Exclude<LedgerTab, 'all'>])}
          body={tab === 'all' ? t('No activity yet body') : t('Nothing of this kind yet body')}
          action={tab === 'all' ? emptyAction(copy) : undefined}
        />
      );
    return (
      <>
        {block}
        {more}
      </>
    );
  }
  if (rows.length === 0) return <SkeletonRows count={4} label={t('Searching your history')} />;

  return (
    <>
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
      {more}
    </>
  );
}

function Content({
  activity,
  tab,
  asset,
  copy,
  hidden,
}: {
  activity: Loadable<ActivityFeed>;
  tab: LedgerTab;
  asset: string | null;
  copy: Copy;
  hidden: boolean;
}) {
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
      return <Body feed={activity.data} tab={tab} asset={asset} copy={copy} hidden={hidden} />;
  }
}

/** The ledger-based tabs (All, Deposits, Transfers). Mounted only on those tabs, so the other two never read the ledger. */
function LedgerTabs({ tab, asset, copy, hidden }: { tab: LedgerTab; asset: string | null; copy: Copy; hidden: boolean }) {
  const activity = useActivity();
  return <Content activity={activity} tab={tab} asset={asset} copy={copy} hidden={hidden} />;
}

export default function Activity({ search }: { search: string }) {
  const copy = moneyCopy.useCopy();
  const { t } = copy;
  const { hideBalances, layoutMode } = usePreferences();
  const tab = tabFromSearch(search);
  // `?asset=BTC` narrows every tab that lists money lines or fills; Orders lists orders, so it ignores it.
  const asset = tab === 'orders' ? null : assetFromSearch(search);
  return (
    <div className="if-money if-money--activity" data-density={layoutMode === 'pro' ? 'pro' : undefined}>
      <h1 className="money-title">{t('Activity')}</h1>
      <Tabs value={tab} onValueChange={(next) => navigate(tabHref(next as Tab, assetFromSearch(search)))}>
        <TabsList divider aria-label={t('Activity filters')} className="money-tabs">
          {TABS.map((id) => (
            <TabsTab key={id} value={id}>
              {t(TAB_LABEL[id])}
            </TabsTab>
          ))}
        </TabsList>
      </Tabs>
      {asset ? (
        <div className="money-filter">
          <button
            type="button"
            className="money-chip"
            aria-label={t('Remove {asset} filter', { asset })}
            onClick={() => navigate(tabHref(tab))}
          >
            {asset}
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <section className="money-card money-card--activity" aria-label={t('Activity')}>
        {tab === 'trades' ? (
          <TradesPanel asset={asset} />
        ) : tab === 'orders' ? (
          <OrdersPanel />
        ) : isLedgerTab(tab) ? (
          <LedgerTabs tab={tab} asset={asset} copy={copy} hidden={hideBalances} />
        ) : null}
      </section>
    </div>
  );
}
