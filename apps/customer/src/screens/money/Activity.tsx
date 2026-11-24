// volt-room: /money/activity
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  ArrowUpRight,
  CircleDot,
  CreditCard,
  Check,
  Download,
  Gift,
  Lock,
  LockOpen,
  Receipt,
  Repeat,
  X,
  type LucideIcon,
  PiggyBank,
} from 'lucide-react';
import {
  assetFromSearch,
  fillFromSearch,
  groupActivityPages,
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
import { Amount, Button, Checkbox, Field, Select, StateBlock } from '@intafaced/ui/lit';
import { RecordListTemplate, SelectField, Skeleton, TabList } from '@intafaced/ui/lit/templates';
import {
  fmtAmount,
  isHiddenPath,
  navigate,
  quotePlaces,
  refusalCopy,
  useActivity,
  type ActivityFeed,
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
import { PeriodTotals } from './PeriodTotals';
import { DormancyNotice } from './DormancyNotice';
import { TaxEffects } from './TaxEffects';
import { stamp } from './time';
import { currentPreferences, usePreferences } from '../../shared/preferences';
import { useVenueMode } from '../../features/trade/use-venue-mode';
import { SourceActivity } from './SourceActivity';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

const ICON: Record<ActivityKind, LucideIcon> = {
  deposit: ArrowDownToLine,
  welcome_funds: Gift,
  transfer_in: ArrowDownLeft,
  transfer_out: ArrowUpRight,
  trade: Repeat,
  convert: Repeat,
  fee: Receipt,
  payment: CreditCard,
  withdrawal: ArrowUpFromLine,
  space_move: ArrowLeftRight,
  earn: PiggyBank,
  staking: Lock,
  reward: Gift,
  order_hold: Lock,
  order_release: LockOpen,
  other: CircleDot,
};

/** The kit's colour for a line's icon and its amount, by the way the money went. */
const ICON_TONE = { in: 'lt-up', out: 'lt-muted' } as const;
const AMOUNT_TONE = { in: 'lt-up', out: 'lt-down' } as const;

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
    <form className="lt-stack" role="search" aria-label={t('Search activity')} onSubmit={(event) => event.preventDefault()}>
      <div className="lt-toolbar">
        <Field
          type="search"
          label={t('Search activity')}
          value={filters.q}
          placeholder={t('Search activity hint')}
          autoComplete="off"
          onChange={(event) => onChange({ ...filters, q: event.target.value })}
        />
        <Select
          label={t('Money in or out')}
          value={filters.dir}
          options={[
            { value: 'all', label: t('All') },
            { value: 'in', label: t('Money in') },
            { value: 'out', label: t('Money out') },
          ]}
          onChange={(value) => onChange({ ...filters, dir: value as ActivityFilters['dir'] })}
        />
        <Field
          type="date"
          label={t('From date')}
          value={filters.from}
          onChange={(event) => onChange({ ...filters, from: event.target.value })}
        />
        <Field type="date" label={t('To date')} value={filters.to} onChange={(event) => onChange({ ...filters, to: event.target.value })} />
        <Select
          label={t('Order')}
          value={filters.sort}
          options={[
            { value: 'desc', label: t('Newest first') },
            { value: 'asc', label: t('Oldest first') },
          ]}
          onChange={(value) => onChange({ ...filters, sort: value as ActivityFilters['sort'] })}
        />
        {accounts.status === 'ready' && accounts.data.length > 0 ? (
          <Select
            label={t('Account')}
            value={filters.accountId}
            options={[
              { value: '', label: t('All accounts') },
              { value: 'main', label: t('Main account') },
              ...accounts.data.map((account) => ({ value: account.id, label: account.name })),
            ]}
            onChange={(value) => onChange({ ...filters, accountId: value })}
          />
        ) : null}
        {/* Only calendar years: a tax year needs a start date that is an owner value not set, so it is named and refused. */}
        <SelectField
          label={t('Year')}
          value={filters.year}
          options={[
            { value: '', label: t('Any year') },
            ...years.map((year) => ({ value: String(year), label: String(year) })),
            { value: 'tax-year', label: t('Tax year not set up'), disabled: true },
          ]}
          onChange={(value) => onChange({ ...filters, year: value })}
        />
        <Field
          type="search"
          label={t('Withdrawal address')}
          value={filters.address}
          placeholder={t('Address hint', { min: ADDRESS_MIN })}
          autoComplete="off"
          spellCheck={false}
          maxLength={ADDRESS_MAX}
          onChange={(event) => onChange({ ...filters, address: event.target.value })}
        />
        <Checkbox checked={filters.hasNote} onCheckedChange={(checked) => onChange({ ...filters, hasNote: checked })}>
          {t('Only lines with a note')}
        </Checkbox>
        {hasFilters(filters) && (
          <Button type="button" tone="secondary" onClick={() => onChange(NO_FILTERS)}>
            {t('Clear filters')}
          </Button>
        )}
      </div>
      <p className="lt-hint">{t('Tax year note')}</p>
      {filters.address.trim() !== '' && filters.address.trim().length < ADDRESS_MIN ? (
        <p className="lt-hint" role="status">
          {t('Address too short', { min: ADDRESS_MIN })}
        </p>
      ) : null}
      {problem && (
        <p className="lt-hint lt-error" role="alert">
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
    <div className="lt-row">
      <Button
        tone="secondary"
        onClick={() => {
          pages.current = 0;
          setState('loading');
        }}
        disabled={state === 'loading'}
      >
        <Download size={16} aria-hidden="true" />
        {t('Export CSV')}
      </Button>
      <p className="lt-hint" role="status" aria-live="polite">
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
        <Button tone="secondary" onClick={() => setState('idle')}>
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
  // A payment between two people carries the fees the bank recorded when it was made: ours, and the network's.
  const fees = item.fees
    ? [
        item.fees.fee === null
          ? t('Fee not recorded')
          : ZERO.test(item.fees.fee)
            ? t('No fee')
            : t('Fee {amount} {asset}', { amount: fmtAmount(item.fees.fee), asset: item.asset }),
        item.fees.networkFee === null
          ? t('Network fee not known')
          : ZERO.test(item.fees.networkFee)
            ? t('No network fee')
            : t('Network fee {amount} {asset}', { amount: fmtAmount(item.fees.networkFee), asset: item.asset }),
      ].join(' · ')
    : null;
  return (
    <tr data-testid="money-act" data-kind={item.kind} data-ref={item.txId} data-source={item.heldAt ? 'partner' : undefined}>
      <td data-label={t('Activity')}>
        <div className="lt-row lt-row-nowrap">
          <span className={ICON_TONE[item.direction]} data-direction={item.direction} aria-hidden="true">
            <Icon size={18} />
          </span>
          <span className="lt-stack lt-stack-tight">
            <a data-testid="money-act__title" className="lt-link lt-strong" href={detailHref(group)}>
              {title}
            </a>
            {sub ? (
              <span data-testid="money-act__sub" className="lt-hint">
                {sub}
              </span>
            ) : null}
            {fees ? (
              <span data-testid="money-act__fees" className="lt-hint">
                {fees}
              </span>
            ) : null}
          </span>
        </div>
      </td>
      <td data-testid="money-act__time" data-label={t('Date')} className="lt-nowrap">
        <time className="lt-nowrap" dateTime={item.postedAt}>
          {stamp(item.postedAt, timeZone)}
        </time>
      </td>
      <td data-testid="money-act__amount" data-label={t('Amount')} className="lt-end">
        <Amount
          value={cancelled ? `${amount} ${item.asset}` : `${up ? '+' : '−'}${amount} ${item.asset}`}
          hidden={hidden}
          className={holding || cancelled ? undefined : AMOUNT_TONE[item.direction]}
          data-direction={item.direction}
        />
      </td>
      <td data-testid="money-act__status" data-label={t('Status')}>
        {holding ? (
          <span data-testid="money-act__hold" className="lt-muted lt-nowrap">
            {t('Set aside')}
          </span>
        ) : (
          <span data-testid="money-act__done" className="lt-row lt-row-nowrap lt-nowrap">
            <Check size={14} aria-hidden="true" />
            {t('Completed')}
          </span>
        )}
      </td>
    </tr>
  );
}

/** A decimal string that is zero ("0", "0.00"), read without turning money into a number. */
const ZERO = /^0+(\.0+)?$/;

function SkeletonRows({ count, label }: { count: number; label: string }) {
  return (
    <div aria-busy="true" role="status" aria-label={label}>
      {Array.from({ length: count }, (_, index) => (
        <div data-testid="money-act-skeleton__row" key={index}>
          <Skeleton shape="rows" count={1} />
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
    () => (isLineTab(tab) ? lineGroups(feed.items, tab) : groupActivityPages(feed.items, feed.pageStarts, filters.sort).groups),
    [feed.items, feed.pageStarts, tab, filters.sort],
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
    <div data-testid="money-more" className="lt-row">
      {feed.moreFailed ? (
        <p data-testid="money-more__note" className="lt-hint">
          {t('Couldn’t load more')}
        </p>
      ) : null}
      <Button tone="secondary" busy={feed.loadingMore} onClick={feed.loadMore}>
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
          title={asset ? t('No {asset} activity in the latest items', { asset }) : t(TAB_LATEST[tab as Exclude<LedgerTab, 'all'>])}
          body={t('Load more to look further back')}
        />
      ) : why === 'asset' && asset ? (
        <StateBlock
          kind="empty"
          testId="money-state"
          title={t('No {asset} activity', { asset })}
          body={t('No {asset} activity body', { asset })}
        />
      ) : (
        <StateBlock
          kind="empty"
          testId="money-state"
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
      <PeriodTotals filters={filters} />
      <StatementPanel />
      <TaxEffects />
      <div className="lt-table-scroll">
        <table data-testid="money-table" className="lt-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="lt-nowrap">{t('Activity')}</span>
              </th>
              <th scope="col">
                <span className="lt-nowrap">{t('Date')}</span>
              </th>
              <th scope="col" className="lt-end">
                {t('Amount')}
              </th>
              <th scope="col">
                <span className="lt-nowrap">{t('Status')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((group) => (
              <Row key={group.id} group={group} copy={copy} hidden={hidden} />
            ))}
          </tbody>
        </table>
      </div>
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
          title={words.title}
          body={words.body}
          code={words.reference}
          action={words.action}
        />
      );
    }
    case 'empty':
      if (asked) return <StateBlock kind="empty" testId="money-state" title={t('No matches')} body={t('No matches body')} />;
      return (
        <StateBlock
          kind="empty"
          testId="money-state"
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
  // The launch model (OWNER 226): with svc-trade's user-venue door on, All lists what the wallet, the venue and the
  // partner report, each line named with its source (J-portfolio-03 #1), as Assets does (WhereItSits).
  const venue = useVenueMode();
  const bySource = venue.mode === 'on' && venue.status.available ? venue.status : null;
  // `?asset=BTC` narrows every tab that lists money lines or fills; Orders lists orders, so it ignores it.
  const asset = tab === 'orders' ? null : assetFromSearch(search);
  // On a phone the tab row scrolls on its own; the kit's tab row keeps the open tab in view, also when a link opens a far one.
  const section = (
    <div className="lt-stack">
      <div data-testid="money-tabs">
        <TabList
          items={TABS.map((id) => ({ value: id, label: t(TAB_LABEL[id]) }))}
          value={tab}
          onChange={(next) => navigate(tabHref(next, assetFromSearch(search)))}
          label={t('Activity filters')}
        />
      </div>
      {asset ? (
        <div className="lt-row">
          <Button tone="secondary" size="sm" aria-label={t('Remove {asset} filter', { asset })} onClick={() => navigate(tabHref(tab))}>
            {asset}
            <X size={14} aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  );
  return (
    <div data-testid="if-money" data-density={layoutMode === 'pro' ? 'pro' : undefined}>
      <RecordListTemplate
        title={t('Activity')}
        state={{ kind: 'ready' }}
        mode={layoutMode === 'pro' ? 'pro' : 'simple'}
        section={section}
        filters={isLedgerTab(tab) ? <FilterBar filters={filters} onChange={setFilters} copy={copy} /> : undefined}
        summary={<DormancyNotice />}
        list={
          <section data-testid="money-card" className="lt-stack" aria-label={t('Activity')}>
            {tab === 'trades' ? (
              <TradesPanel asset={asset} fill={fillFromSearch(search)} />
            ) : tab === 'orders' ? (
              <OrdersPanel />
            ) : tab === 'all' && bySource ? (
              <SourceActivity status={bySource} filters={filters} asset={asset} hidden={hideBalances} />
            ) : isLedgerTab(tab) ? (
              <LedgerTabs tab={tab} asset={asset} copy={copy} hidden={hideBalances} filters={filters} />
            ) : null}
          </section>
        }
      />
    </div>
  );
}
