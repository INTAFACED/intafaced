import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  ArrowUpRight,
  CircleDot,
  CreditCard,
  Search,
  Check,
  Download,
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
  isLineTab,
  lineGroups,
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
import { detailHref } from './activity-detail';
import {
  ADDRESS_MAX,
  ADDRESS_MIN,
  askedOfTheBank,
  groupMatches,
  hasFilters,
  NO_FILTERS,
  rangeProblem,
  serverOptions,
  type ActivityFilters,
} from './activity-filter';
import { useNamedAccounts } from './portfolio-source';
import { activityCsv, csvFileName } from './activity-csv';
import { StatementPanel } from './StatementPanel';
import { TaxEffects } from './TaxEffects';
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

const TAB_LABEL: Record<Tab, 'All' | 'Deposits' | 'Transfers' | 'Trades' | 'Orders' | 'Fees' | 'Entries'> = {
  trades: 'Trades',
  orders: 'Orders',
  all: 'All',
  deposits: 'Deposits',
  transfers: 'Transfers',
  fees: 'Fees',
  ledger: 'Entries',
};
const TAB_EMPTY: Record<Exclude<LedgerTab, 'all'>, 'No deposits yet' | 'No transfers yet' | 'No fees yet' | 'No entries yet'> = {
  deposits: 'No deposits yet',
  transfers: 'No transfers yet',
  fees: 'No fees yet',
  ledger: 'No entries yet',
};
const TAB_LATEST: Record<
  Exclude<LedgerTab, 'all'>,
  'No deposits in the latest items' | 'No transfers in the latest items' | 'No fees in the latest items' | 'No entries in the latest items'
> = {
  deposits: 'No deposits in the latest items',
  transfers: 'No transfers in the latest items',
  fees: 'No fees in the latest items',
  ledger: 'No entries in the latest items',
};

/** The words a row shows as its title, so a search finds what the person reads. */
function groupTitle(group: ActivityGroup, copy: Copy): string {
  const { t } = copy;
  return group.kind === 'cancelled' ? t('Order cancelled · nothing spent') : titleOf(group.main, t, (key, handle) => t(key, { handle }));
}

function FilterBar({ filters, onChange, copy }: { filters: ActivityFilters; onChange: (next: ActivityFilters) => void; copy: Copy }) {
  const { t } = copy;
  const { timeZone } = usePreferences();
  const problem = rangeProblem(filters, timeZone);
  const accounts = useNamedAccounts();
  // The latest few UTC calendar years. A tax year that starts on another date is an owner value that is not set.
  const thisYear = new Date().getUTCFullYear();
  const years = Array.from({ length: 6 }, (_, back) => thisYear - back);
  return (
    <form className="money-bar" role="search" aria-label={t('Search activity')} onSubmit={(event) => event.preventDefault()}>
      <label className="money-bar__search">
        <Search size={16} aria-hidden="true" />
        <span className="if-sr">{t('Search activity')}</span>
        <input
          type="search"
          value={filters.q}
          placeholder={t('Search activity hint')}
          autoComplete="off"
          onChange={(event) => onChange({ ...filters, q: event.target.value })}
        />
      </label>
      <label className="money-bar__field">
        <span>{t('Money in or out')}</span>
        <select value={filters.dir} onChange={(event) => onChange({ ...filters, dir: event.target.value as ActivityFilters['dir'] })}>
          <option value="all">{t('All')}</option>
          <option value="in">{t('Money in')}</option>
          <option value="out">{t('Money out')}</option>
        </select>
      </label>
      <label className="money-bar__field">
        <span>{t('From date')}</span>
        <input type="date" value={filters.from} onChange={(event) => onChange({ ...filters, from: event.target.value })} />
      </label>
      <label className="money-bar__field">
        <span>{t('To date')}</span>
        <input type="date" value={filters.to} onChange={(event) => onChange({ ...filters, to: event.target.value })} />
      </label>
      <label className="money-bar__field">
        <span>{t('Order')}</span>
        <select value={filters.sort} onChange={(event) => onChange({ ...filters, sort: event.target.value as ActivityFilters['sort'] })}>
          <option value="desc">{t('Newest first')}</option>
          <option value="asc">{t('Oldest first')}</option>
        </select>
      </label>
      {accounts.status === 'ready' && accounts.data.length > 0 ? (
        <label className="money-bar__field">
          <span>{t('Account')}</span>
          <select value={filters.accountId} onChange={(event) => onChange({ ...filters, accountId: event.target.value })}>
            <option value="">{t('All accounts')}</option>
            <option value="main">{t('Main account')}</option>
            {accounts.data.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="money-bar__field">
        <span>{t('Year')}</span>
        <select value={filters.year} onChange={(event) => onChange({ ...filters, year: event.target.value })}>
          <option value="">{t('Any year')}</option>
          {years.map((year) => (
            <option key={year} value={String(year)}>
              {year}
            </option>
          ))}
          <option value="" disabled>
            {t('Tax year not set up')}
          </option>
        </select>
      </label>
      <label className="money-bar__field">
        <span>{t('Withdrawal address')}</span>
        <input
          type="search"
          value={filters.address}
          placeholder={t('Address hint', { min: ADDRESS_MIN })}
          autoComplete="off"
          spellCheck={false}
          maxLength={ADDRESS_MAX}
          onChange={(event) => onChange({ ...filters, address: event.target.value })}
        />
      </label>
      <label className="money-bar__check">
        <input type="checkbox" checked={filters.hasNote} onChange={(event) => onChange({ ...filters, hasNote: event.target.checked })} />
        <span>{t('Only lines with a note')}</span>
      </label>
      {hasFilters(filters) && (
        <Button type="button" variant="secondary" size={40} onClick={() => onChange(NO_FILTERS)}>
          {t('Clear filters')}
        </Button>
      )}
      <p className="money-bar__note">{t('Tax year note')}</p>
      {filters.address.trim() !== '' && filters.address.trim().length < ADDRESS_MIN ? (
        <p className="money-bar__note" role="status">
          {t('Address too short', { min: ADDRESS_MIN })}
        </p>
      ) : null}
      {problem && (
        <p className="money-bar__error" role="alert">
          {problem === 'order' ? t('Date range order') : t('Date range invalid')}
        </p>
      )}
    </form>
  );
}

/** Downloads the customer's own records that match the filters. It reads every older page first, within a bound. */
const EXPORT_MAX_PAGES = 100;
function ExportButton({ feed, rows, copy, sort }: { feed: ActivityFeed; rows: ActivityGroup[]; copy: Copy; sort: 'desc' | 'asc' }) {
  const { t } = copy;
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'nothing' | 'failed'>('idle');
  const [count, setCount] = useState(0);
  const pages = useRef(0);
  const latest = useRef({ feed, rows, sort });
  latest.current = { feed, rows, sort };

  function download() {
    const lines = latest.current.rows.flatMap((group) => group.lines);
    if (lines.length === 0) {
      setState('nothing');
      return;
    }
    const seen = new Set<string>();
    const unique = lines.filter((line) => (seen.has(line.id) ? false : (seen.add(line.id), true)));
    // The file keeps the order the screen shows.
    const asc = latest.current.sort === 'asc';
    unique.sort((a, b) => (asc ? Date.parse(a.postedAt) - Date.parse(b.postedAt) : Date.parse(b.postedAt) - Date.parse(a.postedAt)));
    try {
      const csv = activityCsv(unique, (line) => titleOf(line, t, (key) => t(key === 'Sent to {handle}' ? 'Sent' : 'Received')));
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = csvFileName(new Date());
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setCount(unique.length);
      setState('done');
    } catch {
      setState('failed');
    }
  }

  useEffect(() => {
    if (state !== 'loading') return;
    if (feed.moreFailed) {
      setState('failed');
      return;
    }
    if (feed.loadingMore) return;
    if (feed.hasMore && pages.current < EXPORT_MAX_PAGES) {
      pages.current += 1;
      feed.loadMore();
      return;
    }
    if (feed.hasMore) {
      setState('failed');
      return;
    }
    download();
  }, [state, feed]);

  return (
    <div className="money-export">
      <Button
        variant="secondary"
        size={40}
        onClick={() => {
          pages.current = 0;
          setState('loading');
        }}
        disabled={state === 'loading'}
      >
        <Download size={16} aria-hidden="true" />
        {t('Export CSV')}
      </Button>
      <p className="money-export__note" role="status" aria-live="polite">
        {state === 'loading'
          ? t('Exporting', { count: feed.items.length })
          : state === 'done'
            ? t('Export done', { count })
            : state === 'nothing'
              ? t('Export nothing')
              : state === 'failed'
                ? t('Export failed')
                : t('Export note')}
      </p>
      {state === 'loading' && (
        <Button variant="secondary" size={40} onClick={() => setState('idle')}>
          {t('Export cancel')}
        </Button>
      )}
    </div>
  );
}

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
    <tr data-testid="money-act" className="money-act" data-kind={item.kind}>
      <td>
        <div className="money-act__what">
          <span className="money-act__icon" data-direction={item.direction} aria-hidden="true">
            <Icon size={18} />
          </span>
          <span className="money-act__text">
            <a data-testid="money-act__title" className="money-act__title money-act__link" href={detailHref(group)}>
              {title}
            </a>
            {sub ? (
              <span data-testid="money-act__sub" className="money-act__sub">
                {sub}
              </span>
            ) : null}
          </span>
        </div>
      </td>
      <td data-testid="money-act__time" className="money-act__time">
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
      <td data-testid="money-act__status" className="money-act__status money-cell--status">
        {holding ? (
          <span data-testid="money-act__hold" className="money-act__hold">
            {t('Set aside')}
          </span>
        ) : (
          <span data-testid="money-act__done" className="money-act__done">
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
        <div data-testid="money-act-skeleton__row" className="money-act-skeleton__row" key={index}>
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
  filters,
}: {
  feed: ActivityFeed;
  tab: LedgerTab;
  asset: string | null;
  copy: Copy;
  hidden: boolean;
  filters: ActivityFilters;
}) {
  const { t } = copy;
  const { timeZone } = usePreferences();
  // The bank already answers in the order asked for; the rows keep it.
  const groups = useMemo(
    () => (isLineTab(tab) ? lineGroups(feed.items, tab) : groupActivity(feed.items, filters.sort).groups),
    [feed.items, tab, filters.sort],
  );
  const filtered = hasFilters(filters) && rangeProblem(filters, timeZone) === null;
  const rows = groups.filter(
    (group) =>
      inTab(group.main, tab) &&
      (!asset || groupInAsset(group, asset)) &&
      (!filtered || groupMatches(group, filters, timeZone, groupTitle(group, copy))),
  );
  const pages = useRef(0);
  // All and Ledger keep every line, so they only look further back when a filter or a coin narrows them.
  const everyLine = tab === 'all' || tab === 'ledger';

  // The server has no kind filter, so a narrow tab may be thin: look further back a few pages, then ask.
  useEffect(() => {
    pages.current = 0;
  }, [tab, asset, filters]);
  useEffect(() => {
    if ((everyLine && !asset && !filtered) || !feed.hasMore || feed.loadingMore || feed.moreFailed) return;
    if (rows.length >= WANT_ROWS || pages.current >= AUTO_PAGES) return;
    pages.current += 1;
    feed.loadMore();
  }, [tab, everyLine, asset, filtered, rows.length, feed]);

  const searching =
    (!everyLine || asset !== null || filtered) && rows.length === 0 && feed.hasMore && pages.current < AUTO_PAGES && !feed.moreFailed;
  const more = feed.hasMore ? (
    <div className="money-more">
      {feed.moreFailed ? (
        <p data-testid="money-more__note" className="money-more__note">
          {t('Couldn’t load more')}
        </p>
      ) : null}
      <Button variant="secondary" size={40} loading={feed.loadingMore} onClick={feed.loadMore}>
        {feed.moreFailed ? t('Try again') : t('Load more')}
      </Button>
    </div>
  ) : null;
  if (rows.length === 0 && !searching && filtered) {
    return (
      <>
        <StateBlock
          kind="empty"
          testId="money-state"
          className="money-state"
          title={t('No matches')}
          body={feed.hasMore ? t('No matches more body') : t('No matches body')}
        />
        {more}
      </>
    );
  }
  if (rows.length === 0 && !searching) {
    // A filter that matches nothing in the pages read so far must not say there is nothing: older pages may match.
    const why = ledgerEmpty(tab, asset, feed.hasMore);
    const block =
      why === 'more' ? (
        <StateBlock
          kind="empty"
          testId="money-state"
          className="money-state"
          title={asset ? t('No {asset} activity in the latest items', { asset }) : t(TAB_LATEST[tab as Exclude<LedgerTab, 'all'>])}
          body={t('Load more to look further back')}
        />
      ) : why === 'asset' && asset ? (
        <StateBlock
          kind="empty"
          testId="money-state"
          className="money-state"
          title={t('No {asset} activity', { asset })}
          body={t('No {asset} activity body', { asset })}
        />
      ) : (
        <StateBlock
          kind="empty"
          testId="money-state"
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
      <ExportButton feed={feed} rows={rows} copy={copy} sort={filters.sort} />
      <StatementPanel />
      <TaxEffects />
      <table data-testid="money-table" className="money-table money-table--activity">
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
  filters,
  asked,
}: {
  activity: Loadable<ActivityFeed>;
  tab: LedgerTab;
  asset: string | null;
  copy: Copy;
  hidden: boolean;
  filters: ActivityFilters;
  /** The bank was asked to narrow or reorder the list, so "empty" means "nothing matches", not "no activity at all". */
  asked: boolean;
}) {
  const { t } = copy;
  switch (activity.status) {
    case 'loading':
      return <SkeletonRows count={8} label={t('Loading activity')} />;
    case 'error':
      return (
        <StateBlock
          kind="error"
          testId="money-state"
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
          testId="money-state"
          className="money-state"
          title={words.title}
          body={words.body}
          code={words.reference}
          action={words.action}
        />
      );
    }
    case 'empty':
      if (asked)
        return <StateBlock kind="empty" testId="money-state" className="money-state" title={t('No matches')} body={t('No matches body')} />;
      return (
        <StateBlock
          kind="empty"
          testId="money-state"
          className="money-state"
          title={t('No activity yet')}
          body={t('No activity yet body')}
          action={emptyAction(copy)}
        />
      );
    case 'ready':
      return <Body feed={activity.data} tab={tab} asset={asset} copy={copy} hidden={hidden} filters={filters} />;
  }
}

/** The ledger-based tabs (All, Deposits, Transfers). Mounted only on those tabs, so the other two never read the ledger. */
function LedgerTabs({
  tab,
  asset,
  copy,
  hidden,
  filters,
}: {
  tab: LedgerTab;
  asset: string | null;
  copy: Copy;
  hidden: boolean;
  filters: ActivityFilters;
}) {
  // Typing an address asks the bank only once the person pauses.
  const [address, setAddress] = useState(filters.address);
  useEffect(() => {
    const timer = window.setTimeout(() => setAddress(filters.address), 400);
    return () => window.clearTimeout(timer);
  }, [filters.address]);
  const asked = serverOptions({ ...filters, address });
  const activity = useActivity(asked);
  return (
    <Content
      activity={activity}
      tab={tab}
      asset={asset}
      copy={copy}
      hidden={hidden}
      filters={filters}
      asked={askedOfTheBank({ ...filters, address })}
    />
  );
}

export default function Activity({ search }: { search: string }) {
  const copy = moneyCopy.useCopy();
  const { t } = copy;
  const { hideBalances, layoutMode } = usePreferences();
  const [filters, setFilters] = useState<ActivityFilters>(NO_FILTERS);
  const tab = tabFromSearch(search);
  // `?asset=BTC` narrows every tab that lists money lines or fills; Orders lists orders, so it ignores it.
  const asset = tab === 'orders' ? null : assetFromSearch(search);
  // On a phone the tab row scrolls on its own; keep the open tab in view, also when a link opens a far one.
  const tabList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tabList.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab]);
  return (
    <div data-testid="if-money" className="if-money if-money--activity" data-density={layoutMode === 'pro' ? 'pro' : undefined}>
      <h1 className="money-title">{t('Activity')}</h1>
      <Tabs value={tab} onValueChange={(next) => navigate(tabHref(next as Tab, assetFromSearch(search)))}>
        <TabsList ref={tabList} divider aria-label={t('Activity filters')} data-testid="money-tabs" className="money-tabs">
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
      {isLedgerTab(tab) && <FilterBar filters={filters} onChange={setFilters} copy={copy} />}
      <section data-testid="money-card" className="money-card money-card--activity" aria-label={t('Activity')}>
        {tab === 'trades' ? (
          <TradesPanel asset={asset} />
        ) : tab === 'orders' ? (
          <OrdersPanel />
        ) : isLedgerTab(tab) ? (
          <LedgerTabs tab={tab} asset={asset} copy={copy} hidden={hideBalances} filters={filters} />
        ) : null}
      </section>
    </div>
  );
}
