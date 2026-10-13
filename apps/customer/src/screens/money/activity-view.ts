import { dec, str, type ActivityItem, type ActivityKind } from './deps';

/**
 * The tabs of Activity (UI-SPEC 5.4): Trades (fills) first, Orders (open orders and order history), then the
 * ledger-based All, Deposits and Transfers. Trades and Orders read the trade service; the rest read `bank.activity.list`.
 */
export const TABS = ['trades', 'orders', 'all', 'deposits', 'transfers'] as const;
export type Tab = (typeof TABS)[number];
export type LedgerTab = 'all' | 'deposits' | 'transfers';

export const isLedgerTab = (tab: Tab): tab is LedgerTab => tab === 'all' || tab === 'deposits' || tab === 'transfers';

const KINDS: Readonly<Record<Exclude<LedgerTab, 'all'>, ReadonlySet<ActivityKind>>> = {
  deposits: new Set<ActivityKind>(['deposit', 'welcome_funds']),
  transfers: new Set<ActivityKind>(['transfer_in', 'transfer_out', 'space_move']),
};

/** `?tab=orders`. Nothing, or anything unknown, reads as Trades (the first tab). */
export function tabFromSearch(search: string): Tab {
  const value = new URLSearchParams(search).get('tab');
  return (TABS as readonly string[]).includes(value ?? '') ? (value as Tab) : 'trades';
}

export function tabHref(tab: Tab): string {
  return tab === 'trades' ? '/money/activity' : `/money/activity?tab=${tab}`;
}

export function inTab(item: ActivityItem, tab: LedgerTab): boolean {
  return tab === 'all' || KINDS[tab].has(item.kind);
}

// ── grouping ─────────────────────────────────────────────────────────────────

/**
 * One thing that happened, made of one or more ledger lines. A buy is several lines (the money set aside, the coin
 * received, the unused part returned, a fee); the person sees one "Trade".
 */
export interface ActivityGroup {
  id: string;
  /** The line that names the group and is shown as its amount. */
  main: ActivityItem;
  /** Every line of the group, the main one included. */
  lines: ActivityItem[];
}

/** Which line names a group when several share one: the more specific kind wins. */
const RANK: Readonly<Record<ActivityKind, number>> = {
  trade: 9,
  withdrawal: 8,
  payment: 8,
  deposit: 7,
  welcome_funds: 7,
  transfer_in: 7,
  transfer_out: 7,
  space_move: 7,
  order_hold: 4,
  order_release: 4,
  fee: 2,
  other: 1,
};

/**
 * The server posts the lines of one fill as separate entries, each with its own id and a few milliseconds apart (the
 * money set aside, the coin, the unused change). Lines of kind `other` or `fee` this close to a trade belong to it.
 */
export const TRADE_WINDOW_MS = 500;

const at = (item: ActivityItem): number => Date.parse(item.postedAt);

function mainOf(lines: ActivityItem[]): ActivityItem {
  return lines.reduce((best, line) => (RANK[line.kind] > RANK[best.kind] ? line : best), lines[0]!);
}

/** Joins a `trade` line that takes an asset with the nearest one, within the window, that gives a different asset. */
function pairTradeLegs(groups: ActivityGroup[]): ActivityGroup[] {
  const trades = groups.filter((group) => group.main.kind === 'trade');
  const paired = new Set<ActivityGroup>();
  const merged = new Map<ActivityGroup, ActivityGroup>();
  const candidates: Array<{ gap: number; got: ActivityGroup; gave: ActivityGroup }> = [];
  for (const got of trades.filter((group) => group.main.direction === 'in'))
    for (const gave of trades.filter((group) => group.main.direction === 'out')) {
      const gap = Math.abs(at(got.main) - at(gave.main));
      if (gap <= TRADE_WINDOW_MS && got.main.asset !== gave.main.asset) candidates.push({ gap, got, gave });
    }
  candidates.sort((a, b) => a.gap - b.gap);
  for (const { got, gave } of candidates) {
    if (paired.has(got) || paired.has(gave)) continue;
    paired.add(got);
    paired.add(gave);
    merged.set(got, { id: got.id, main: got.main, lines: [...got.lines, ...gave.lines] });
  }
  return groups.flatMap((group) => (merged.get(group) ? [merged.get(group)!] : paired.has(group) ? [] : [group]));
}

export interface Grouped {
  groups: ActivityGroup[];
  /** Lines left out of the list: money set aside for orders, and returned from them, that the server files as `other`. */
  holdLines: number;
}

/**
 * Newest first. Lines of one ledger transaction (same `txId`) become one group; then loose `other`/`fee` lines within
 * `TRADE_WINDOW_MS` of a trade join the nearest trade. Loose `other` lines left over are holds and releases of resting
 * orders (the only things the server files under `other` for a customer); they are counted, not listed, until the server
 * labels them (`order_hold` / `order_release`, which this screen already shows).
 */
export function groupActivity(items: readonly ActivityItem[]): Grouped {
  const byTx = new Map<string, ActivityItem[]>();
  for (const item of items) {
    const list = byTx.get(item.txId);
    if (list) list.push(item);
    else byTx.set(item.txId, [item]);
  }
  let groups: ActivityGroup[] = [...byTx.values()].map((lines) => {
    const main = mainOf(lines);
    return { id: main.id, main, lines };
  });

  // The two legs of one fill (coin in, dollars out) are both `trade` lines, a few ms apart: they are one trade.
  groups = pairTradeLegs(groups);
  const trades = groups.filter((group) => group.main.kind === 'trade');
  if (trades.length > 0) {
    const absorbed = new Set<ActivityGroup>();
    for (const group of groups) {
      if (group.main.kind !== 'other' && group.main.kind !== 'fee') continue;
      let nearest: ActivityGroup | null = null;
      let gap = TRADE_WINDOW_MS + 1;
      for (const trade of trades) {
        const distance = Math.abs(at(trade.main) - at(group.main));
        if (distance < gap) {
          gap = distance;
          nearest = trade;
        }
      }
      if (nearest) {
        nearest.lines.push(...group.lines);
        absorbed.add(group);
      }
    }
    groups = groups.filter((group) => !absorbed.has(group));
  }

  let holdLines = 0;
  groups = groups.filter((group) => {
    if (group.main.kind !== 'other') return true;
    holdLines += group.lines.length;
    return false;
  });
  groups.sort((a, b) => at(b.main) - at(a.main));
  return { groups, holdLines };
}

export interface TradeDetail {
  /** What the other side of the trade was, when the lines say: a coin spent (`out`) or received. */
  counter: { direction: 'in' | 'out'; asset: string; amount: string } | null;
  fees: Array<{ asset: string; amount: string }>;
}

/** Net movement of one asset over some lines (in adds, out takes away), exact. */
function net(lines: ActivityItem[], asset: string): bigint {
  let total = 0n;
  for (const line of lines) {
    if (line.asset !== asset) continue;
    const value = dec(line.amount) ?? 0n;
    total += line.direction === 'in' ? value : -value;
  }
  return total;
}

/**
 * What a trade group says besides its main line: what was paid (or given) for it, net of the unused part returned, and
 * any fee lines. Null counter when the lines do not show it.
 */
export function tradeDetail(group: ActivityGroup): TradeDetail {
  const others = group.lines.filter((line) => line !== group.main && line.kind !== 'fee');
  const assets = [...new Set(others.map((line) => line.asset).filter((asset) => asset !== group.main.asset))];
  let counter: TradeDetail['counter'] = null;
  for (const asset of assets) {
    const value = net(others, asset);
    if (value === 0n) continue;
    counter = { direction: value < 0n ? 'out' : 'in', asset, amount: str(value < 0n ? -value : value) };
    break;
  }
  const feeAssets = [...new Set(group.lines.filter((line) => line.kind === 'fee').map((line) => line.asset))];
  const fees = feeAssets.flatMap((asset) => {
    const value = net(
      group.lines.filter((line) => line.kind === 'fee'),
      asset,
    );
    return value === 0n ? [] : [{ asset, amount: str(value < 0n ? -value : value) }];
  });
  return { counter, fees };
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
      | 'On hold for an open order'
      | 'Returned from an order'
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
      return t('On hold for an open order');
    case 'order_release':
      return t('Returned from an order');
    case 'other':
      return t('Other activity');
  }
}
