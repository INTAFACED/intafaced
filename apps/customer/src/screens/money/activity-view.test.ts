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
const T0 = Date.parse('2026-10-14T10:00:00.000Z');
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
    const { groups } = groupActivity(buy);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.main.kind).toBe('trade');
    expect(groups[0]!.lines).toHaveLength(3);
    // 6.540908 set aside - 0.032542 returned = 6.508366 paid
    expect(tradeDetail(groups[0]!)).toEqual({ counter: { direction: 'out', asset: 'USDT', amount: '6.508366' }, fees: [] });
  });

  it('groups lines that share a txId, and puts a fee line in the detail', () => {
    const lines = [
      item({ id: '1', kind: 'trade', asset: 'BTC', amount: '0.001', txId: 'same' }),
      item({ id: '2', kind: 'other', direction: 'out', asset: 'USDT', amount: '61', txId: 'same' }),
      item({ id: '2b', kind: 'other', direction: 'in', asset: 'USDT', amount: '1', txId: 'same' }),
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

  it('keeps two fills of the same coin apart when they are further apart than the window', () => {
    const fills = [0, 2000].map((ms, i) =>
      item({
        id: `${i}`,
        kind: 'trade',
        direction: 'in',
        asset: 'BTC',
        amount: '0.01',
        postedAt: new Date(T0 + ms).toISOString(),
        txId: `${i}`,
      }),
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

  it('lists a hold and a release of resting orders as rows of their own, with their real amounts', () => {
    const { groups } = groupActivity([...hold, ...buy]);
    expect(groups.map((group) => group.main.kind)).toEqual(['other', 'other', 'trade']);
    expect(groups.map((group) => [group.main.direction, group.main.amount])).toEqual([
      ['in', '5'],
      ['out', '5'],
      ['in', '0.0000999'],
    ]);
  });

  it('shows holds the server labels, and never a plain Completed -5 USDT', () => {
    const labelled = [item({ id: 'o', kind: 'order_hold', direction: 'out', amount: '5', txId: 'o' })];
    const { groups } = groupActivity(labelled);
    expect(groups).toHaveLength(1);
    expect(titleOf(groups[0]!.main, t, withHandle)).toBe('Set aside for an order');
    expect(titleOf(item({ kind: 'order_release' }), t, withHandle)).toBe('Returned from an order');
  });

  it('puts a labelled hold and release inside the trade they belong to, with the same Paid', () => {
    const labelled = buy.map((line) =>
      line.kind === 'other' ? { ...line, kind: line.direction === 'out' ? ('order_hold' as const) : ('order_release' as const) } : line,
    );
    const { groups } = groupActivity(labelled);
    expect(groups).toHaveLength(1);
    expect(tradeDetail(groups[0]!).counter).toEqual({ direction: 'out', asset: 'USDT', amount: '6.508366' });
  });

  // The cases the round-2 critic ran (grouping-sim.txt): wrong numbers must become no number.
  describe('the 500 ms window never shows a wrong amount', () => {
    let n = 0;
    const L = (ms: number, kind: ActivityItem['kind'], direction: 'in' | 'out', asset: string, amount: string) =>
      item({ id: `i${++n}`, txId: `t${n}`, kind, direction, asset, amount, postedAt: new Date(T0 + ms).toISOString() });
    const detailOf = (lines: ActivityItem[]) => {
      const { groups } = groupActivity(lines);
      return groups.map((group) => ({
        kind: group.main.kind,
        direction: group.main.direction,
        asset: group.main.asset,
        amount: group.main.amount,
        counter: group.main.kind === 'trade' ? tradeDetail(group).counter : undefined,
      }));
    };

    it('A: a market buy that sweeps two makers is one row, and Paid is the hold minus the release', () => {
      // hold 100.5 out, fills 0.0008 + 0.0007 BTC, release 2.1 in
      const rows = detailOf([
        L(0, 'other', 'out', 'USDT', '100.5'),
        L(16, 'trade', 'in', 'BTC', '0.0008'),
        L(20, 'trade', 'in', 'BTC', '0.0007'),
        L(32, 'other', 'in', 'USDT', '2.1'),
      ]);
      expect(rows).toEqual([
        { kind: 'trade', direction: 'in', asset: 'BTC', amount: '0.0015', counter: { direction: 'out', asset: 'USDT', amount: '98.4' } },
      ]);
    });

    it('B: a crossing limit buy that half fills and rests shows no Paid (a hold alone proves no price)', () => {
      const rows = detailOf([L(0, 'order_hold', 'out', 'USDT', '100'), L(15, 'trade', 'in', 'BTC', '0.00077')]);
      expect(rows).toEqual([{ kind: 'trade', direction: 'in', asset: 'BTC', amount: '0.00077', counter: null }]);
    });

    it('C: a resting limit buy that fills an hour later is a trade with no number and a hold row of its own', () => {
      const rows = detailOf([L(0, 'other', 'out', 'USDT', '50'), L(3_600_000, 'trade', 'in', 'BTC', '0.00077')]);
      expect(rows).toEqual([
        { kind: 'trade', direction: 'in', asset: 'BTC', amount: '0.00077', counter: null },
        { kind: 'other', direction: 'out', asset: 'USDT', amount: '50', counter: undefined },
      ]);
    });

    it('D: another order cancelled 300 ms before a market fill never turns the buy into "Got 40"', () => {
      const rows = detailOf([
        L(0, 'other', 'in', 'USDT', '50'),
        L(300, 'other', 'out', 'USDT', '10.05'),
        L(316, 'trade', 'in', 'BTC', '0.00015'),
        L(332, 'other', 'in', 'USDT', '0.05'),
      ]);
      expect(rows).toEqual([{ kind: 'trade', direction: 'in', asset: 'BTC', amount: '0.00015', counter: null }]);
    });

    it('E: other lines with no trade near them are all listed, with their real amounts', () => {
      const rows = detailOf([L(0, 'other', 'in', 'USDT', '12.5'), L(5000, 'other', 'out', 'USDT', '300')]);
      expect(rows).toEqual([
        { kind: 'other', direction: 'out', asset: 'USDT', amount: '300', counter: undefined },
        { kind: 'other', direction: 'in', asset: 'USDT', amount: '12.5', counter: undefined },
      ]);
    });

    it('sums fills as exact decimals, with no float noise', () => {
      const rows = detailOf([L(0, 'trade', 'in', 'BTC', '0.1'), L(10, 'trade', 'in', 'BTC', '0.2')]);
      expect(rows[0]!.amount).toBe('0.3');
    });

    it('does not join fills of different coins, or a buy with a sell', () => {
      expect(detailOf([L(0, 'trade', 'in', 'BTC', '0.1'), L(10, 'trade', 'in', 'ETH', '0.2')])).toHaveLength(2);
      expect(detailOf([L(0, 'trade', 'in', 'BTC', '0.1'), L(10, 'trade', 'out', 'BTC', '0.2')])).toHaveLength(2);
    });

    it('does not take an unrelated line in the coin the trade moved', () => {
      const rows = detailOf([L(0, 'trade', 'in', 'BTC', '0.1'), L(10, 'other', 'in', 'BTC', '0.01')]);
      expect(rows).toHaveLength(2);
    });

    it('shows no Got/Paid when two coins would both qualify', () => {
      const { groups } = groupActivity([
        L(0, 'order_hold', 'out', 'USDT', '10'),
        L(5, 'order_hold', 'out', 'USDC', '10'),
        L(10, 'trade', 'in', 'BTC', '0.001'),
        L(15, 'order_release', 'in', 'USDT', '1'),
        L(20, 'order_release', 'in', 'USDC', '1'),
      ]);
      expect(tradeDetail(groups[0]!).counter).toBeNull();
    });

    it('never reports a counter that runs the same way as the main line', () => {
      const { groups } = groupActivity([L(0, 'trade', 'in', 'BTC', '0.001'), L(5, 'trade', 'in', 'USDT', '9')]);
      expect(groups).toHaveLength(2);
      expect(groups.every((group) => tradeDetail(group).counter === null)).toBe(true);
    });
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
