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
  /** The line that names the group and is shown as its amount. For a sweep (several fills) its amount is their exact sum. */
  main: ActivityItem;
  /** Every line of the group (for a sweep, each fill: `main` carries their sum). */
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
 * money set aside, the coin, the unused change). Lines this close to a trade may belong to it. Every ledger line has its
 * own `txId`, so the window does the grouping, and it can be wrong: a number is shown only when the lines prove it
 * (see `tradeDetail`).
 */
export const TRADE_WINDOW_MS = 500;

const at = (item: ActivityItem): number => Date.parse(item.postedAt);

function mainOf(lines: ActivityItem[]): ActivityItem {
  return lines.reduce((best, line) => (RANK[line.kind] > RANK[best.kind] ? line : best), lines[0]!);
}

/**
 * One order can fill against several makers: the server posts one `trade` line per maker, a few ms apart. Within the
 * window, `trade` groups of the same asset and direction become one group whose main line holds the exact sum.
 */
function mergeSweeps(groups: ActivityGroup[]): ActivityGroup[] {
  const byKey = new Map<string, ActivityGroup[]>();
  for (const group of groups) {
    if (group.main.kind !== 'trade') continue;
    const key = `${group.main.asset}|${group.main.direction}`;
    const list = byKey.get(key);
    if (list) list.push(group);
    else byKey.set(key, [group]);
  }
  const replaced = new Map<ActivityGroup, ActivityGroup>();
  const dropped = new Set<ActivityGroup>();
  for (const list of byKey.values()) {
    list.sort((a, b) => at(a.main) - at(b.main));
    let run: ActivityGroup[] = [];
    const flush = () => {
      if (run.length > 1) {
        const newest = run[run.length - 1]!;
        const total = run.reduce((sum, group) => sum + (dec(group.main.amount) ?? 0n), 0n);
        replaced.set(newest, {
          id: newest.id,
          main: { ...newest.main, amount: str(total) },
          lines: run.flatMap((group) => group.lines),
        });
        for (const group of run.slice(0, -1)) dropped.add(group);
      }
      run = [];
    };
    for (const group of list) {
      const last = run[run.length - 1];
      if (last && at(group.main) - at(last.main) > TRADE_WINDOW_MS) flush();
      run.push(group);
    }
    flush();
  }
  return groups.flatMap((group) => (dropped.has(group) ? [] : [replaced.get(group) ?? group]));
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
}

/** Lines that may be the money set aside for, returned from, or charged on a trade. */
const LOOSE: ReadonlySet<ActivityKind> = new Set<ActivityKind>(['other', 'fee', 'order_hold', 'order_release']);

/** The time of the nearest `trade` line of a group to a moment, as a distance in ms. */
const distanceTo = (trade: ActivityGroup, line: ActivityItem): number =>
  Math.min(...trade.lines.filter((l) => l.kind === 'trade').map((l) => Math.abs(at(l) - at(line))));

/**
 * Newest first, and nothing is left out: every ledger line is shown, alone or inside a trade. Lines of one ledger
 * transaction (same `txId`) become one group; `trade` lines of one order that filled against several makers become one
 * group; then loose `fee`, `order_hold`, `order_release` and `other` lines within `TRADE_WINDOW_MS` of a trade, in a
 * different asset than the coin it moved, join the nearest trade. What stays loose is listed as its own row (an `other`
 * line is "Other activity" with its real amount).
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

  // Several fills of one order are one trade; then the two legs of one fill (coin in, dollars out) are one trade.
  groups = pairTradeLegs(mergeSweeps(groups));
  const trades = groups.filter((group) => group.main.kind === 'trade');
  if (trades.length > 0) {
    const absorbed = new Set<ActivityGroup>();
    for (const group of groups) {
      if (!LOOSE.has(group.main.kind)) continue;
      let nearest: ActivityGroup | null = null;
      let gap = TRADE_WINDOW_MS + 1;
      for (const trade of trades) {
        if (group.main.kind !== 'fee' && group.main.asset === trade.main.asset) continue;
        const distance = distanceTo(trade, group.main);
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
  groups.sort((a, b) => at(b.main) - at(a.main));
  return { groups };
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

const isHold = (line: ActivityItem): boolean => line.kind === 'order_hold' || line.kind === 'other';
const isRelease = (line: ActivityItem): boolean => line.kind === 'order_release' || line.kind === 'other';

/**
 * What a trade group says besides its main line: what was paid (or given) for it, and any fee lines. Wrong numbers
 * become no number: the counter is shown only when the lines prove it.
 * - It must run the opposite way to the main line (a buy pays out, a sell receives).
 * - From `trade` legs of the other asset: their exact net.
 * - Otherwise from money set aside minus money returned, and only with exactly one of each (a hold out, a release in).
 *   A hold alone is a resting or part-filled order, so it says nothing about the price; two releases mean another
 *   order's cancel is in the window.
 * - If two assets would both qualify, none is shown.
 */
export function tradeDetail(group: ActivityGroup): TradeDetail {
  const { main } = group;
  const counterDirection = main.direction === 'in' ? 'out' : 'in';
  const others = group.lines.filter((line) => line !== main && line.kind !== 'fee' && line.asset !== main.asset);
  const assets = [...new Set(others.map((line) => line.asset))];
  const found: Array<NonNullable<TradeDetail['counter']>> = [];
  for (const asset of assets) {
    const lines = others.filter((line) => line.asset === asset);
    const legs = lines.filter((line) => line.kind === 'trade');
    let value = 0n;
    if (legs.length > 0) {
      if (legs.length !== lines.length) continue;
      value = net(legs, asset);
      if ((counterDirection === 'out') !== value < 0n) continue;
    } else {
      if (main.direction !== 'in') continue; // money is set aside only to receive something
      const holds = lines.filter((line) => isHold(line) && line.direction === counterDirection);
      const releases = lines.filter((line) => isRelease(line) && line.direction === main.direction);
      if (holds.length !== 1 || releases.length !== 1 || holds.length + releases.length !== lines.length) continue;
      const set = dec(holds[0]!.amount) ?? 0n;
      const back = dec(releases[0]!.amount) ?? 0n;
      if (set <= back) continue;
      value = set - back;
      value = -value;
    }
    if (value === 0n) continue;
    found.push({ direction: counterDirection, asset, amount: str(value < 0n ? -value : value) });
  }
  const counter = found.length === 1 ? found[0]! : null;
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
      | 'Set aside for an order'
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
      return t('Set aside for an order');
    case 'order_release':
      return t('Returned from an order');
    case 'other':
      return t('Other activity');
  }
}
