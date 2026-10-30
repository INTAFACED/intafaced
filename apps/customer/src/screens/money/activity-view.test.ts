import { describe, expect, it } from 'vitest';
import {
  assetFromSearch,
  fillFromSearch,
  groupActivity,
  groupInAsset,
  inTab,
  isLedgerTab,
  lineGroups,
  ledgerEmpty,
  tradesEmpty,
  FILLS_PAGE,
  symbolHasAsset,
  TABS,
  tabFromSearch,
  tabHref,
  titleOf,
  type ActivityGroup,
} from './activity-view';
import { dec, type ActivityItem } from './deps';

const item = (over: Partial<ActivityItem>): ActivityItem => ({
  id: 'x',
  kind: 'deposit',
  direction: 'in',
  asset: 'USDT',
  amount: '1',
  postedAt: '2026-10-14T00:00:00.000Z',
  txId: 't',
  counterparty: null,
  spaceName: null,
  ...over,
});
const T0 = Date.parse('2026-10-14T10:00:00.000Z');
const t = (key: string) => key;
const withHandle = (key: string, handle: string) => key.replace('{handle}', `@${handle}`);

describe('tabs', () => {
  it('reads ?tab=, and nothing or anything unknown as All (the first tab)', () => {
    expect(tabFromSearch('?tab=deposits')).toBe('deposits');
    expect(tabFromSearch('?tab=orders&x=1')).toBe('orders');
    expect(tabFromSearch('?tab=trades')).toBe('trades');
    expect(tabFromSearch('?tab=all')).toBe('all');
    expect(tabFromSearch('?tab=nope')).toBe('all');
    expect(tabFromSearch('')).toBe('all');
    expect(tabFromSearch('?asset=BTC')).toBe('all');
    expect(tabHref('all')).toBe('/money/activity');
    expect(tabHref('trades')).toBe('/money/activity?tab=trades');
    expect(tabHref('orders')).toBe('/money/activity?tab=orders');
    expect(tabHref('transfers')).toBe('/money/activity?tab=transfers');
  });

  it('reads ?asset= as an upper-case coin, and nothing or blank as no filter', () => {
    expect(assetFromSearch('?tab=trades&asset=BTC')).toBe('BTC');
    expect(assetFromSearch('?asset=eth')).toBe('ETH');
    expect(assetFromSearch('?asset=')).toBeNull();
    expect(assetFromSearch('?asset=%20')).toBeNull();
    expect(assetFromSearch('?tab=all')).toBeNull();
    expect(assetFromSearch('')).toBeNull();
  });

  it('reads ?fill= as the one trade a link opens on, kept as given; nothing or blank as none', () => {
    expect(fillFromSearch('?tab=trades&asset=BTC&fill=f-1')).toBe('f-1');
    expect(fillFromSearch('?fill=a%20b')).toBe('a b');
    expect(fillFromSearch('?fill=')).toBeNull();
    expect(fillFromSearch('?tab=trades')).toBeNull();
  });

  it('keeps the coin when it builds a tab link', () => {
    expect(tabHref('all', 'BTC')).toBe('/money/activity?asset=BTC');
    expect(tabHref('trades', 'BTC')).toBe('/money/activity?tab=trades&asset=BTC');
    expect(tabHref('trades', null)).toBe('/money/activity?tab=trades');
    expect(tabHref('all', null)).toBe('/money/activity');
  });

  it('matches a fill to a coin by its base or quote, whichever way the symbol is spelled', () => {
    expect(symbolHasAsset('BTC/USDT', 'BTC')).toBe(true);
    expect(symbolHasAsset('BTC/USDT', 'USDT')).toBe(true);
    expect(symbolHasAsset('BTC-USDT', 'USDT')).toBe(true);
    expect(symbolHasAsset('BTC/USDT', 'ETH')).toBe(false);
    expect(symbolHasAsset('WBTC/USDT', 'BTC')).toBe(false);
  });

  it('puts the ledger tabs and only them on the ledger', () => {
    expect(TABS).toEqual(['all', 'trades', 'orders', 'deposits', 'transfers', 'fees', 'ledger']);
    expect(TABS.filter(isLedgerTab)).toEqual(['all', 'deposits', 'transfers', 'fees', 'ledger']);
  });

  it('sorts every kind into a ledger tab', () => {
    const kinds = {
      deposits: ['deposit', 'welcome_funds'],
      transfers: ['transfer_in', 'transfer_out', 'space_move'],
    } as const;
    for (const [tab, list] of Object.entries(kinds))
      for (const kind of list) {
        expect(inTab(item({ kind }), tab as 'deposits')).toBe(true);
        expect(inTab(item({ kind }), 'all')).toBe(true);
      }
    expect(inTab(item({ kind: 'fee' }), 'deposits')).toBe(false);
    expect(inTab(item({ kind: 'fee' }), 'all')).toBe(true);
    expect(inTab(item({ kind: 'trade' }), 'deposits')).toBe(false);
  });
});

let n = 0;
/** A ledger line. Each has its own id and txId, as on the server; `orderId` is what groups them. */
const L = (ms: number, kind: ActivityItem['kind'], direction: 'in' | 'out', asset: string, amount: string, orderId?: string) =>
  item({ id: `i${++n}`, txId: `t${n}`, kind, direction, asset, amount, postedAt: new Date(T0 + ms).toISOString(), orderId });

const signed = (direction: 'in' | 'out', amount: string): bigint => (direction === 'in' ? 1n : -1n) * (dec(amount) ?? 0n);

/**
 * Conservation: every ledger line is in exactly one group, and the money each row shows (its amount, its counter, its
 * set-aside and returned notes, its fees) adds up, per asset, to the money of the lines it holds. Nothing hidden,
 * nothing made up. A cancelled order shows the money it set aside and got back, which nets to nothing.
 */
function expectConserved(lines: ActivityItem[], groups: ActivityGroup[]) {
  const seen = groups.flatMap((group) => group.lines);
  expect(new Set(seen).size, 'a line is in two groups').toBe(seen.length);
  expect([...seen].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...lines].sort((a, b) => a.id.localeCompare(b.id)));
  const assets = new Set(lines.map((line) => line.asset));
  const total = (list: Array<{ direction: 'in' | 'out'; asset: string; amount: string }>, asset: string) =>
    list.filter((m) => m.asset === asset).reduce((sum, m) => sum + signed(m.direction, m.amount), 0n);
  for (const asset of assets) {
    const fromLines = total(lines, asset);
    const shown = groups.reduce((sum, group) => {
      if (group.kind === 'cancelled') return sum; // set aside and returned in full: nets to nothing
      const parts = [group.main, ...(group.counter ? [group.counter] : []), ...group.notes, ...group.fees];
      return sum + total(parts, asset);
    }, 0n);
    expect(shown, `${asset} shown on rows`).toBe(fromLines);
  }
}

const rowsOf = (lines: ActivityItem[]) => {
  const { groups } = groupActivity(lines);
  expectConserved(lines, groups);
  return groups;
};
const money = (direction: 'in' | 'out', asset: string, amount: string) => ({ direction, asset, amount });

describe('groupActivity: only the same orderId groups lines', () => {
  it('single fill with both legs as trade lines: one row, with what was paid and the fee', () => {
    const groups = rowsOf([
      L(0, 'trade', 'out', 'USDT', '678.124', 'o1'),
      L(10, 'trade', 'in', 'BTC', '0.01', 'o1'),
      L(10, 'fee', 'out', 'USDT', '0.6781', 'o1'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: 'trade',
      counter: money('out', 'USDT', '678.124'),
      notes: [],
      fees: [money('out', 'USDT', '0.6781')],
    });
    expect([groups[0]!.main.asset, groups[0]!.main.amount, groups[0]!.main.direction]).toEqual(['BTC', '0.01', 'in']);
  });

  it('a real buy: the coin is the row, the hold and the leftover are shown as they are, and no Paid is worked out', () => {
    const groups = rowsOf([
      L(43, 'order_release', 'in', 'USDT', '0.032542', 'o1'),
      L(21, 'trade', 'in', 'BTC', '0.0000999', 'o1'),
      L(0, 'order_hold', 'out', 'USDT', '6.540908', 'o1'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: 'trade',
      counter: null,
      notes: [money('out', 'USDT', '6.540908'), money('in', 'USDT', '0.032542')],
    });
    expect(groups[0]!.main.amount).toBe('0.0000999');
  });

  it('multi-maker sweep: the fills add up exactly, in one row', () => {
    const groups = rowsOf([
      L(0, 'order_hold', 'out', 'USDT', '100.5', 'o1'),
      L(16, 'trade', 'in', 'BTC', '0.0008', 'o1'),
      L(20, 'trade', 'in', 'BTC', '0.0007', 'o1'),
      L(32, 'order_release', 'in', 'USDT', '2.1', 'o1'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.main).toMatchObject({ asset: 'BTC', direction: 'in', amount: '0.0015' });
    expect(groups[0]!.counter).toBeNull();
    // "Returned 2.1 USDT" is in the detail; it is never shown as "Got".
    expect(groups[0]!.notes).toEqual([money('out', 'USDT', '100.5'), money('in', 'USDT', '2.1')]);
  });

  it('sums fills as exact decimals, with no float noise', () => {
    const groups = rowsOf([L(0, 'trade', 'in', 'BTC', '0.1', 'o1'), L(10, 'trade', 'in', 'BTC', '0.2', 'o1')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.main.amount).toBe('0.3');
  });

  it('a sweep with a trade leg for each maker in the other asset sums both sides', () => {
    const groups = rowsOf([
      L(0, 'trade', 'in', 'BTC', '0.1', 'o1'),
      L(1, 'trade', 'out', 'USDT', '6000.5', 'o1'),
      L(5, 'trade', 'in', 'BTC', '0.2', 'o1'),
      L(6, 'trade', 'out', 'USDT', '12001', 'o1'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.main.amount).toBe('0.3');
    expect(groups[0]!.counter).toEqual(money('out', 'USDT', '18001.5'));
  });

  it('partial fill then cancel: one trade row; the hold and what came back are in its detail', () => {
    const groups = rowsOf([
      L(0, 'order_hold', 'out', 'USDT', '100', 'o1'),
      L(15, 'trade', 'in', 'BTC', '0.00077', 'o1'),
      L(60_000, 'order_release', 'in', 'USDT', '49.5', 'o1'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'trade', counter: null, notes: [money('out', 'USDT', '100'), money('in', 'USDT', '49.5')] });
  });

  it('cancel only, with the same amount set aside and returned: one "nothing spent" row', () => {
    const groups = rowsOf([L(0, 'order_hold', 'out', 'USDT', '5', 'o1'), L(60_000, 'order_release', 'in', 'USDT', '5', 'o1')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('cancelled');
    expect(groups[0]!.lines).toHaveLength(2);
    expect(groups[0]!.main).toMatchObject({ asset: 'USDT', amount: '5' });
  });

  it('cancel only, after an amend: the holds add up and still match the release', () => {
    const groups = rowsOf([
      L(0, 'order_hold', 'out', 'USDT', '5', 'o1'),
      L(10, 'order_hold', 'out', 'USDT', '3', 'o1'),
      L(60_000, 'order_release', 'in', 'USDT', '8', 'o1'),
    ]);
    expect(groups.map((group) => group.kind)).toEqual(['cancelled']);
  });

  it('set aside and returned but not the same amount: every line is its own row, nothing netted', () => {
    const groups = rowsOf([L(0, 'order_hold', 'out', 'USDT', '5', 'o1'), L(60_000, 'order_release', 'in', 'USDT', '4', 'o1')]);
    expect(groups.map((group) => [group.kind, group.main.kind, group.main.amount])).toEqual([
      ['line', 'order_release', '4'],
      ['line', 'order_hold', '5'],
    ]);
  });

  it('a hold alone is an open order: one row "Set aside"', () => {
    const groups = rowsOf([L(0, 'order_hold', 'out', 'USDT', '50', 'o1')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('open');
    expect(titleOf(groups[0]!.main, t, withHandle)).toBe('Set aside for an order');
    expect(groups[0]!.main).toMatchObject({ kind: 'order_hold', direction: 'out', amount: '50' });
  });

  it('an open order that was amended is one row with the holds added up', () => {
    const groups = rowsOf([L(0, 'order_hold', 'out', 'USDT', '50', 'o1'), L(10, 'order_hold', 'out', 'USDT', '25', 'o1')]);
    expect(groups.map((group) => group.kind)).toEqual(['open']);
    expect(groups[0]!.main.amount).toBe('75');
  });

  it('a line with no orderId next to a trade stays its own row, with its real amount', () => {
    const lines = [
      L(0, 'deposit', 'in', 'USDT', '200'),
      L(5, 'order_hold', 'out', 'USDT', '100', 'o1'),
      L(10, 'trade', 'in', 'BTC', '0.001', 'o1'),
      L(15, 'other', 'in', 'USDT', '12.5'),
      L(20, 'fee', 'out', 'USDT', '0.1'),
      L(25, 'transfer_out', 'out', 'USDT', '30'),
    ];
    const groups = rowsOf(lines);
    expect(groups).toHaveLength(5);
    expect(groups.filter((group) => group.kind === 'trade')).toHaveLength(1);
    expect(groups.filter((group) => group.kind === 'line').map((group) => [group.main.kind, group.main.amount])).toEqual([
      ['transfer_out', '30'],
      ['fee', '0.1'],
      ['other', '12.5'],
      ['deposit', '200'],
    ]);
  });

  it("review case 1: another order's cancel (+50 USDT) and a hold next to a market fill are all shown", () => {
    const groups = rowsOf([
      L(0, 'order_release', 'in', 'USDT', '50', 'o-other'),
      L(300, 'order_hold', 'out', 'USDT', '10.05', 'o2'),
      L(316, 'trade', 'in', 'BTC', '0.00015', 'o2'),
      L(332, 'order_release', 'in', 'USDT', '0.05', 'o2'),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.main.amount)).toEqual(['0.00015', '50']);
    expect(groups[1]!.kind).toBe('line');
  });

  it('review case 2: a cancel of 5 then a crossing buy of 100 never shows "Paid 95"', () => {
    const groups = rowsOf([
      L(0, 'order_release', 'in', 'USDT', '5', 'o-cancelled'),
      L(300, 'order_hold', 'out', 'USDT', '100', 'o2'),
      L(320, 'trade', 'in', 'BTC', '0.0015', 'o2'),
    ]);
    const trade = groups.find((group) => group.kind === 'trade')!;
    expect(trade.counter).toBeNull();
    expect(trade.notes).toEqual([money('out', 'USDT', '100')]);
    expect(groups.some((group) => group.main.amount === '5')).toBe(true);
  });

  it('review case 3: a hold and a fill of two different orders in the same instant stay apart', () => {
    const groups = rowsOf([L(0, 'order_hold', 'out', 'USDT', '100', 'o1'), L(1, 'trade', 'in', 'BTC', '0.001', 'o2')]);
    expect(groups.map((group) => group.kind)).toEqual(['trade', 'open']);
  });

  it('a fill leg in a second asset, a fee, and a stray other line of the same order never go missing', () => {
    const groups = rowsOf([
      L(0, 'trade', 'in', 'BTC', '0.01', 'o1'),
      L(1, 'trade', 'out', 'USDT', '600', 'o1'),
      L(2, 'trade', 'out', 'ETH', '0.2', 'o1'),
      L(3, 'other', 'in', 'USDT', '1', 'o1'),
    ]);
    expect(groups.filter((group) => group.kind === 'trade')).toHaveLength(1);
    expect(groups.reduce((count, group) => count + group.lines.length, 0)).toBe(4);
  });

  it('lines from a server that sends no orderId are every one its own row, however close in time', () => {
    const lines = [
      L(0, 'other', 'out', 'USDT', '6.54'),
      L(10, 'trade', 'in', 'BTC', '0.0001'),
      L(20, 'other', 'in', 'USDT', '0.03'),
      L(25, 'trade', 'in', 'BTC', '0.0002'),
    ];
    const groups = rowsOf(lines);
    expect(groups).toHaveLength(4);
    expect(groups.every((group) => group.kind === 'line' && group.counter === null && group.notes.length === 0)).toBe(true);
  });

  it('shares nothing between a txId and a group: lines of one txId without an orderId stay apart', () => {
    const lines = [
      item({ id: '1', kind: 'trade', asset: 'BTC', amount: '0.001', txId: 'same' }),
      item({ id: '2', kind: 'other', direction: 'out', asset: 'USDT', amount: '61', txId: 'same' }),
    ];
    expect(rowsOf(lines)).toHaveLength(2);
  });

  it('keeps two orders apart, newest first', () => {
    const groups = rowsOf([L(0, 'trade', 'in', 'BTC', '0.1', 'o1'), L(5000, 'trade', 'in', 'BTC', '0.2', 'o2')]);
    expect(groups.map((group) => group.main.amount)).toEqual(['0.2', '0.1']);
  });

  it('shows holds the server labels, and never a plain Completed -5 USDT', () => {
    expect(titleOf(item({ kind: 'order_hold' }), t, withHandle)).toBe('Set aside for an order');
    expect(titleOf(item({ kind: 'order_release' }), t, withHandle)).toBe('Returned from an order');
  });

  it('lists newest first and keeps deposits and transfers as their own rows', () => {
    const rows = [
      item({ id: 'd', kind: 'deposit', postedAt: '2026-10-01T00:00:00.000Z', txId: 'd' }),
      item({ id: 'p', kind: 'transfer_in', postedAt: '2026-10-02T00:00:00.000Z', txId: 'p' }),
    ];
    expect(groupActivity(rows).groups.map((group) => group.id)).toEqual(['p', 'd']);
  });

  it('lists oldest first when the person asked for it', () => {
    const rows = [
      item({ id: 'd', kind: 'deposit', postedAt: '2026-10-01T00:00:00.000Z', txId: 'd' }),
      item({ id: 'p', kind: 'transfer_in', postedAt: '2026-10-02T00:00:00.000Z', txId: 'p' }),
    ];
    expect(groupActivity(rows, 'asc').groups.map((group) => group.id)).toEqual(['d', 'p']);
  });

  it('gives every row a different id', () => {
    const groups = rowsOf([
      L(0, 'trade', 'in', 'BTC', '0.1', 'o1'),
      L(1, 'trade', 'in', 'ETH', '1', 'o1'),
      L(2, 'trade', 'in', 'SOL', '1', 'o1'),
      L(3, 'deposit', 'in', 'USDT', '1'),
    ]);
    expect(new Set(groups.map((group) => group.id)).size).toBe(groups.length);
  });
});

describe('groupInAsset: a coin keeps whole orders', () => {
  it('includes an order when any of its lines is in the coin, with all its lines, and plain lines only by their own coin', () => {
    const { groups } = groupActivity([
      L(0, 'trade', 'out', 'USDT', '100', 'o1'),
      L(0, 'trade', 'in', 'BTC', '0.002', 'o1'),
      L(0, 'fee', 'out', 'USDT', '0.1', 'o1'),
      L(1000, 'deposit', 'in', 'USDT', '5'),
      L(2000, 'other', 'in', 'ETH', '1'),
    ]);
    const inBtc = groups.filter((group) => groupInAsset(group, 'BTC'));
    expect(inBtc).toHaveLength(1);
    expect(inBtc[0]!.lines.map((line) => line.asset).sort()).toEqual(['BTC', 'USDT', 'USDT']);
    expect(groups.filter((group) => groupInAsset(group, 'USDT'))).toHaveLength(2);
    expect(groups.filter((group) => groupInAsset(group, 'ETH'))).toHaveLength(1);
    expect(groups.filter((group) => groupInAsset(group, 'ZZZ'))).toHaveLength(0);
  });
});

describe('titleOf', () => {
  it('names the other person when known', () => {
    expect(titleOf(item({ kind: 'transfer_in', counterparty: { handle: 'maya' } }), t, withHandle)).toBe('Received from @maya');
    expect(titleOf(item({ kind: 'transfer_in' }), t, withHandle)).toBe('Received');
    expect(titleOf(item({ kind: 'transfer_out', counterparty: { handle: 'ola' } }), t, withHandle)).toBe('Sent to @ola');
    expect(titleOf(item({ kind: 'transfer_out' }), t, withHandle)).toBe('Sent');
  });
  it('uses plain words for every other kind', () => {
    expect(titleOf(item({ kind: 'welcome_funds' }), t, withHandle)).toBe('Welcome test funds');
    expect(titleOf(item({ kind: 'payment', direction: 'in' }), t, withHandle)).toBe('Payment received');
    expect(titleOf(item({ kind: 'payment', direction: 'out' }), t, withHandle)).toBe('Payment sent');
    expect(titleOf(item({ kind: 'space_move' }), t, withHandle)).toBe('Moved between your accounts');
    expect(titleOf(item({ kind: 'other' }), t, withHandle)).toBe('Other activity');
  });
});

describe('empty states never claim there is nothing while older history may match', () => {
  it('a coin filter or a narrow tab with more pages to read says "not found yet" and keeps Load more', () => {
    expect(ledgerEmpty('all', 'BTC', true)).toBe('more');
    expect(ledgerEmpty('deposits', null, true)).toBe('more');
    expect(ledgerEmpty('transfers', 'BTC', true)).toBe('more');
  });
  it('once every page is read, the filter or tab can honestly say there is none', () => {
    expect(ledgerEmpty('all', 'BTC', false)).toBe('asset');
    expect(ledgerEmpty('deposits', null, false)).toBe('tab');
    expect(ledgerEmpty('all', null, false)).toBe('all');
  });
  it('an unfiltered All with more pages is not a filtered search', () => {
    expect(ledgerEmpty('all', null, true)).toBe('all');
  });
  it('Trades: a filter matching nothing in a full page of fills says "latest"; below a full page it says none', () => {
    expect(tradesEmpty('BTC', FILLS_PAGE)).toBe('asset-latest');
    expect(tradesEmpty('BTC', FILLS_PAGE + 5)).toBe('asset-latest');
    expect(tradesEmpty('BTC', FILLS_PAGE - 1)).toBe('asset');
    expect(tradesEmpty('BTC', 0)).toBe('none');
    expect(tradesEmpty(null, 0)).toBe('none');
  });
});

describe('Fees and Ledger tabs', () => {
  const lines = [
    item({ id: 'a', kind: 'deposit' }),
    item({ id: 'b', kind: 'fee', direction: 'out', amount: '0.1', orderId: 'o1' }),
    item({ id: 'c', kind: 'trade', orderId: 'o1' }),
    item({ id: 'd', kind: 'trade', direction: 'out', asset: 'BTC', orderId: 'o1' }),
  ];
  it('Fees lists every fee line, even one a trade row folds into itself', () => {
    expect(groupActivity(lines).groups.some((group) => group.main.id === 'b')).toBe(false);
    expect(lineGroups(lines, 'fees').map((group) => group.main.id)).toEqual(['b']);
  });
  it('Ledger lists every line once, ungrouped, in the order sent', () => {
    expect(lineGroups(lines, 'ledger').map((group) => group.main.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(lineGroups([], 'ledger')).toEqual([]);
  });
});
