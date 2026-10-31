import { dec, str, type ActivityItem, type ActivityKind } from './deps';

/**
 * The tabs of Activity (UI-SPEC 5.4): All first (every money movement on the ledger, which is what a person opening
 * Activity wants to see), then Trades (fills), Orders (open orders and order history), Deposits, Transfers, Fees and Ledger (the
 * same lines one by one, nothing grouped). Trades and
 * Orders read the trade service; the rest read `bank.activity.list`.
 */
export const TABS = ['all', 'trades', 'orders', 'deposits', 'transfers', 'fees', 'ledger'] as const;
export type Tab = (typeof TABS)[number];
export type LedgerTab = 'all' | 'deposits' | 'transfers' | 'fees' | 'ledger';

export const isLedgerTab = (tab: Tab): tab is LedgerTab =>
  tab === 'all' || tab === 'deposits' || tab === 'transfers' || tab === 'fees' || tab === 'ledger';

const KINDS: Readonly<Record<Exclude<LedgerTab, 'all' | 'ledger'>, ReadonlySet<ActivityKind>>> = {
  deposits: new Set<ActivityKind>(['deposit', 'welcome_funds']),
  transfers: new Set<ActivityKind>(['transfer_in', 'transfer_out', 'space_move']),
  fees: new Set<ActivityKind>(['fee']),
};

/** The tab Activity opens on when the address names none, or names one that does not exist. */
export const DEFAULT_TAB: Tab = 'all';

/** `?tab=orders`. Nothing, or anything unknown, reads as All (the first tab). */
export function tabFromSearch(search: string): Tab {
  const value = new URLSearchParams(search).get('tab');
  return (TABS as readonly string[]).includes(value ?? '') ? (value as Tab) : DEFAULT_TAB;
}

/** `?asset=BTC`: show only this coin. Empty or missing reads as no filter; the symbol is upper-cased like the coins are. */
export function assetFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get('asset')?.trim().toUpperCase();
  return value ? value : null;
}

/** `?fill=<id>`: the one trade a link opens on (a fill notice); Trades marks that row. */
export function fillFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get('fill')?.trim();
  return value ? value : null;
}

/** The Activity link for a tab, keeping the coin filter when there is one. */
export function tabHref(tab: Tab, asset: string | null = null): string {
  const query = [tab === DEFAULT_TAB ? null : `tab=${tab}`, asset ? `asset=${encodeURIComponent(asset)}` : null].filter(Boolean).join('&');
  return query ? `/money/activity?${query}` : '/money/activity';
}

/**
 * What an empty ledger list may honestly say. `more`: nothing matched in the pages loaded so far but older pages exist, so it
 * must not claim there is none (and must keep "Load more"). Otherwise the whole history has been read: `asset` (a coin filter
 * matched nothing), `tab` (Deposits or Transfers has nothing), or `all` (no activity at all).
 */
export type LedgerEmpty = 'more' | 'asset' | 'tab' | 'all';
export function ledgerEmpty(tab: LedgerTab, asset: string | null, hasMore: boolean): LedgerEmpty {
  if (hasMore && (tab !== 'all' || asset !== null)) return 'more';
  if (asset !== null) return 'asset';
  return tab === 'all' ? 'all' : 'tab';
}

/** The fills call returns only the latest page; a full page means older fills may exist that it never saw. */
export const FILLS_PAGE = 100;
export type TradesEmpty = 'none' | 'asset' | 'asset-latest';
/** Empty Trades: `none` (no fills at all), `asset-latest` (a coin filter matched nothing in a full page of fills), or `asset` (nothing in the coin, and all fills were seen). */
export function tradesEmpty(asset: string | null, loaded: number): TradesEmpty {
  if (asset === null || loaded === 0) return 'none';
  return loaded >= FILLS_PAGE ? 'asset-latest' : 'asset';
}

/** Does a fill's symbol ("BTC/USDT", or "BTC-USDT") have this coin as its base or quote? */
export function symbolHasAsset(symbol: string, asset: string): boolean {
  return symbol.replace('-', '/').split('/').includes(asset);
}

export function inTab(item: ActivityItem, tab: LedgerTab): boolean {
  return tab === 'all' || tab === 'ledger' || KINDS[tab].has(item.kind);
}

/**
 * The tabs that list ledger lines one by one: Fees (every fee line, including the ones a trade row folds into itself) and Ledger
 * (every line, nothing grouped). Every other tab shows the grouped rows from `groupActivity`.
 */
export const isLineTab = (tab: LedgerTab): tab is 'fees' | 'ledger' => tab === 'fees' || tab === 'ledger';

/** One row per ledger line of the tab, in the order the bank sent them. */
export function lineGroups(items: ActivityItem[], tab: 'fees' | 'ledger'): ActivityGroup[] {
  return items.filter((item) => inTab(item, tab)).map(single);
}

// ── grouping ─────────────────────────────────────────────────────────────────

/** A sum of money in one asset. `in` adds to what you hold, `out` takes away. The amount is unsigned. */
export interface Money {
  direction: 'in' | 'out';
  asset: string;
  amount: string;
}

/**
 * - `line`: one ledger line, shown as it is (deposits, transfers, payments, and anything with no order).
 * - `trade`: the lines of one order that filled.
 * - `cancelled`: an order whose money was set aside and returned in full, with nothing spent.
 * - `open`: an order whose money is set aside and still resting.
 */
export type GroupKind = 'line' | 'trade' | 'cancelled' | 'open';

/**
 * One row of Activity, made of one or more ledger lines. The ledger tells which lines belong to one order (`orderId`);
 * nothing else groups lines. Every line is in exactly one group, and its money shows on the row: as the amount, as
 * `counter`, in `notes` or in `fees` (the test helper `accounted` in activity-view.test.ts checks this).
 */
export interface ActivityGroup {
  id: string;
  kind: GroupKind;
  /** The line shown as the row's amount. For a sweep (several fills) its amount is their exact sum. */
  main: ActivityItem;
  /** Every ledger line of the group. */
  lines: ActivityItem[];
  /** `trade` only: the other side of the fills (what was paid, or got), from the fill lines of the other asset. */
  counter: Money | null;
  /** `trade` only: money of the order's holds and releases (`out` reads "Set aside", `in` reads "Returned"). */
  notes: Money[];
  /** `trade` only: the order's fee lines. */
  fees: Money[];
}

const at = (item: ActivityItem): number => Date.parse(item.postedAt) || 0;
const signed = (item: Pick<ActivityItem, 'direction' | 'amount'>): bigint => {
  const value = dec(item.amount) ?? 0n;
  return item.direction === 'in' ? value : -value;
};
const moneyOf = (asset: string, value: bigint): Money => ({
  direction: value < 0n ? 'out' : 'in',
  asset,
  amount: str(value < 0n ? -value : value),
});
const newest = (lines: ActivityItem[]): ActivityItem => lines.reduce((best, line) => (at(line) > at(best) ? line : best), lines[0]!);
const sum = (lines: ActivityItem[]): bigint => lines.reduce((total, line) => total + signed(line), 0n);
const assetsOf = (lines: ActivityItem[]): string[] => [...new Set(lines.map((line) => line.asset))];

const single = (item: ActivityItem): ActivityGroup => ({
  id: item.id,
  kind: 'line',
  main: item,
  lines: [item],
  counter: null,
  notes: [],
  fees: [],
});

/** Net of lines per asset as money, skipping assets that net to nothing. */
function netMoney(lines: ActivityItem[]): Money[] {
  return assetsOf(lines).flatMap((asset) => {
    const value = sum(lines.filter((line) => line.asset === asset));
    return value === 0n ? [] : [moneyOf(asset, value)];
  });
}

/** The groups of one order's lines. Anything the order's lines do not account for cleanly stays a row of its own. */
function orderGroups(orderId: string, lines: ActivityItem[]): ActivityGroup[] {
  const fills = lines.filter((line) => line.kind === 'trade');
  const holds = lines.filter((line) => line.kind === 'order_hold');
  const releases = lines.filter((line) => line.kind === 'order_release');
  const fees = lines.filter((line) => line.kind === 'fee');
  const id = `order:${orderId}`;

  if (fills.length > 0) {
    // The main line is the asset received (an `in` fill); with none, the first fill.
    const anchor = fills.find((line) => line.direction === 'in') ?? fills[0]!;
    const mainLegs = fills.filter((line) => line.asset === anchor.asset && line.direction === anchor.direction);
    const counterDirection = anchor.direction === 'in' ? 'out' : 'in';
    const counterAsset = fills.find((line) => line.direction === counterDirection && line.asset !== anchor.asset)?.asset;
    const counterLegs = counterAsset ? fills.filter((line) => line.direction === counterDirection && line.asset === counterAsset) : [];
    const used = new Set<ActivityItem>([...mainLegs, ...counterLegs, ...holds, ...releases, ...fees]);
    const main = { ...newest(mainLegs), amount: str(mainLegs.reduce((total, line) => total + (dec(line.amount) ?? 0n), 0n)) };
    return [
      {
        id,
        kind: 'trade',
        main,
        lines: lines.filter((line) => used.has(line)),
        counter: counterLegs.length > 0 ? moneyOf(counterAsset!, sum(counterLegs)) : null,
        notes: [...netMoney(holds), ...netMoney(releases)],
        fees: netMoney(fees),
      },
      ...lines.filter((line) => !used.has(line)).map(single),
    ];
  }

  const money = [...holds, ...releases];
  const assets = assetsOf(money);
  const others = lines.filter((line) => !money.includes(line));
  if (assets.length === 1 && holds.length > 0) {
    const held = -sum(holds);
    const back = sum(releases);
    const asset = assets[0]!;
    // Set aside and returned, to the digit: the order was cancelled (or expired) and nothing was spent.
    if (releases.length > 0 && held > 0n && held === back)
      return [
        {
          id,
          kind: 'cancelled',
          main: { ...newest(releases), kind: 'order_release', direction: 'in', asset, amount: str(back) },
          lines: money,
          counter: null,
          notes: [],
          fees: [],
        },
        ...others.map(single),
      ];
    // Set aside and nothing back yet: the order is resting.
    if (releases.length === 0 && held > 0n)
      return [
        {
          id,
          kind: 'open',
          main: { ...newest(holds), kind: 'order_hold', direction: 'out', asset, amount: str(held) },
          lines: money,
          counter: null,
          notes: [],
          fees: [],
        },
        ...others.map(single),
      ];
  }
  return lines.map(single);
}

export interface Grouped {
  groups: ActivityGroup[];
}

/**
 * Newest first (oldest first when the person asked for it), and nothing is left out: every ledger line is shown, alone or inside the order it belongs to. Lines
 * are grouped ONLY when the ledger gives them the same `orderId`. A line with no `orderId` (a deposit, a transfer, a
 * payment, anything else, and every line from a server that does not send it yet) is always its own row with its real
 * amount. Time and `txId` never group anything.
 */
export function groupActivity(items: readonly ActivityItem[], order: 'desc' | 'asc' = 'desc'): Grouped {
  const byOrder = new Map<string, ActivityItem[]>();
  const groups: ActivityGroup[] = [];
  for (const item of items) {
    if (!item.orderId) {
      groups.push(single(item));
      continue;
    }
    const list = byOrder.get(item.orderId);
    if (list) list.push(item);
    else byOrder.set(item.orderId, [item]);
  }
  for (const [orderId, lines] of byOrder) groups.push(...orderGroups(orderId, lines));
  groups.sort((a, b) => (order === 'asc' ? at(a.main) - at(b.main) : at(b.main) - at(a.main)));
  return { groups };
}

/** A row is in a coin when any of its ledger lines is in that coin, so an order's whole row stays together. */
export function groupInAsset(group: ActivityGroup, asset: string): boolean {
  return group.lines.some((line) => line.asset === asset);
}

// ── words ────────────────────────────────────────────────────────────────────

/** The sentence-case title of a row, in plain money words. `t` is the screen's copy function. */
export function titleOf(
  item: ActivityItem,
  t: (
    key:
      | 'Deposit'
      | 'Welcome test funds'
      | 'Received'
      | 'Sent'
      | 'Trade'
      | 'Fee'
      | 'Payment received'
      | 'Payment sent'
      | 'Withdrawal'
      | 'Moved between your accounts'
      | 'Set aside for an order'
      | 'Returned from an order'
      | 'Moved to savings'
      | 'Back from savings'
      | 'Staked'
      | 'Unstaked'
      | 'Reward'
      | 'Other activity',
  ) => string,
  withHandle: (key: 'Received from {handle}' | 'Sent to {handle}', handle: string) => string,
): string {
  const handle = item.counterparty?.handle ?? null;
  switch (item.kind) {
    case 'deposit':
      return t('Deposit');
    case 'welcome_funds':
      return t('Welcome test funds');
    case 'transfer_in':
      return handle ? withHandle('Received from {handle}', handle) : t('Received');
    case 'transfer_out':
      return handle ? withHandle('Sent to {handle}', handle) : t('Sent');
    case 'trade':
      return t('Trade');
    case 'fee':
      return t('Fee');
    case 'payment':
      return item.direction === 'in' ? t('Payment received') : t('Payment sent');
    case 'withdrawal':
      return t('Withdrawal');
    case 'space_move':
      return t('Moved between your accounts');
    case 'order_hold':
      return t('Set aside for an order');
    case 'order_release':
      return t('Returned from an order');
    case 'earn':
      return item.direction === 'out' ? t('Moved to savings') : t('Back from savings');
    case 'staking':
      return item.direction === 'out' ? t('Staked') : t('Unstaked');
    case 'reward':
      return t('Reward');
    case 'other':
      return t('Other activity');
  }
}
