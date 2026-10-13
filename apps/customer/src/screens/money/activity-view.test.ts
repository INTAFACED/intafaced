import { describe, expect, it } from 'vitest';
import { groupActivity, inTab, isLedgerTab, TABS, tabFromSearch, tabHref, titleOf, tradeDetail } from './activity-view';
import type { ActivityItem } from './deps';

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
const t = (key: string) => key;
const withHandle = (key: string, handle: string) => key.replace('{handle}', `@${handle}`);

describe('tabs', () => {
  it('reads ?tab=, and nothing or anything unknown as Trades (the first tab)', () => {
    expect(tabFromSearch('?tab=deposits')).toBe('deposits');
    expect(tabFromSearch('?tab=orders&x=1')).toBe('orders');
    expect(tabFromSearch('?tab=all')).toBe('all');
    expect(tabFromSearch('?tab=nope')).toBe('trades');
    expect(tabFromSearch('')).toBe('trades');
    expect(tabHref('trades')).toBe('/money/activity');
    expect(tabHref('orders')).toBe('/money/activity?tab=orders');
    expect(tabHref('transfers')).toBe('/money/activity?tab=transfers');
  });

  it('puts the ledger tabs and only them on the ledger', () => {
    expect(TABS).toEqual(['trades', 'orders', 'all', 'deposits', 'transfers']);
    expect(TABS.filter(isLedgerTab)).toEqual(['all', 'deposits', 'transfers']);
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

// A real buy as the server sent it (critic round 1, p4.json): each leg has its own id and txId, a few ms apart.
const buy = [
  item({
    id: 'c:USDT:in',
    kind: 'other',
    direction: 'in',
    asset: 'USDT',
    amount: '0.032542',
    postedAt: '2026-10-13T17:29:14.115Z',
    txId: 'c',
  }),
  item({
    id: 'b:BTC:in',
    kind: 'trade',
    direction: 'in',
    asset: 'BTC',
    amount: '0.0000999',
    postedAt: '2026-10-13T17:29:14.093Z',
    txId: 'b',
  }),
  item({
    id: 'a:USDT:out',
    kind: 'other',
    direction: 'out',
    asset: 'USDT',
    amount: '6.540908',
    postedAt: '2026-10-13T17:29:14.072Z',
    txId: 'a',
  }),
];
// A resting limit order and its cancel, minutes apart.
const hold = [
  item({ id: 'r', kind: 'other', direction: 'in', asset: 'USDT', amount: '5', postedAt: '2026-10-13T18:17:56.967Z', txId: 'r' }),
  item({ id: 'h', kind: 'other', direction: 'out', asset: 'USDT', amount: '5', postedAt: '2026-10-13T18:17:50.533Z', txId: 'h' }),
];

describe('groupActivity', () => {
  it('turns the legs of one buy into a single Trade row with what was paid', () => {
    const { groups, holdLines } = groupActivity(buy);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.main.kind).toBe('trade');
    expect(groups[0]!.lines).toHaveLength(3);
    expect(holdLines).toBe(0);
    // 6.540908 set aside - 0.032542 returned = 6.508366 paid
    expect(tradeDetail(groups[0]!)).toEqual({ counter: { direction: 'out', asset: 'USDT', amount: '6.508366' }, fees: [] });
  });

  it('groups lines that share a txId, and puts a fee line in the detail', () => {
    const lines = [
      item({ id: '1', kind: 'trade', asset: 'BTC', amount: '0.001', txId: 'same' }),
      item({ id: '2', kind: 'other', direction: 'out', asset: 'USDT', amount: '60', txId: 'same' }),
      item({ id: '3', kind: 'fee', direction: 'out', asset: 'USDT', amount: '0.06', txId: 'same' }),
    ];
    const { groups } = groupActivity(lines);
    expect(groups).toHaveLength(1);
    expect(tradeDetail(groups[0]!)).toEqual({
      counter: { direction: 'out', asset: 'USDT', amount: '60' },
      fees: [{ asset: 'USDT', amount: '0.06' }],
    });
  });

  it('joins the two legs of one fill, when both are trade lines', () => {
    const legs = [
      item({ id: 'g', kind: 'trade', direction: 'in', asset: 'BTC', amount: '0.01', postedAt: '2026-10-14T08:02:00.010Z', txId: 'g' }),
      item({ id: 'p', kind: 'trade', direction: 'out', asset: 'USDT', amount: '678.124', postedAt: '2026-10-14T08:02:00.000Z', txId: 'p' }),
      item({ id: 'f', kind: 'fee', direction: 'out', asset: 'USDT', amount: '0.6781', postedAt: '2026-10-14T08:02:00.000Z', txId: 'f' }),
    ];
    const { groups } = groupActivity(legs);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.main.asset).toBe('BTC');
    expect(tradeDetail(groups[0]!)).toEqual({
      counter: { direction: 'out', asset: 'USDT', amount: '678.124' },
      fees: [{ asset: 'USDT', amount: '0.6781' }],
    });
  });

  it('keeps two fills of the same coin apart', () => {
    const fills = ['1', '2'].map((n, i) =>
      item({ id: n, kind: 'trade', direction: 'in', asset: 'BTC', amount: '0.01', postedAt: `2026-10-14T08:02:00.00${i}Z`, txId: n }),
    );
    expect(groupActivity(fills).groups).toHaveLength(2);
  });

  it('keeps two trades apart and gives each its own legs', () => {
    const second = buy.map((line) => ({
      ...line,
      id: `s${line.id}`,
      txId: `s${line.txId}`,
      postedAt: line.postedAt.replace('17:29:14', '17:22:57'),
    }));
    const { groups } = groupActivity([...buy, ...second]);
    expect(groups.map((group) => group.lines.length)).toEqual([3, 3]);
  });

  it('leaves out holds and releases of resting orders and counts them', () => {
    const { groups, holdLines } = groupActivity([...hold, ...buy]);
    expect(groups.map((group) => group.main.kind)).toEqual(['trade']);
    expect(holdLines).toBe(2);
  });

  it('shows holds the server labels, and never a plain Completed -5 USDT', () => {
    const labelled = [item({ id: 'o', kind: 'order_hold', direction: 'out', amount: '5', txId: 'o' })];
    const { groups, holdLines } = groupActivity(labelled);
    expect(groups).toHaveLength(1);
    expect(holdLines).toBe(0);
    expect(titleOf(groups[0]!.main, t, withHandle)).toBe('On hold for an open order');
    expect(titleOf(item({ kind: 'order_release' }), t, withHandle)).toBe('Returned from an order');
  });

  it('lists newest first and keeps deposits and transfers as their own rows', () => {
    const rows = [
      item({ id: 'd', kind: 'deposit', postedAt: '2026-10-01T00:00:00.000Z', txId: 'd' }),
      item({ id: 'p', kind: 'transfer_in', postedAt: '2026-10-02T00:00:00.000Z', txId: 'p' }),
    ];
    expect(groupActivity(rows).groups.map((group) => group.id)).toEqual(['p', 'd']);
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
