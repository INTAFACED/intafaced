import { describe, expect, it } from 'vitest';
import type { ActivityItem } from '../../data/activity';
import { NO_FILTERS } from './activity-filter';
import {
  fillParts,
  keepLine,
  oneList,
  orderLines,
  partnerLines,
  product,
  typeOf,
  unanswerable,
  venueLines,
  walletLines,
  type SourceLine,
  type VenueOrderRead,
} from './activity-sources';

const ME = '0x00000000000000000000000000000000000000aa';
const OTHER = '0x00000000000000000000000000000000000000bb';
const USD = { address: '0x000000000000000000000000000000000000d011', symbol: 'USD', decimals: 6 };

describe('walletLines', () => {
  it('lists each token transfer in or out once, with the network named, and leaves out self-moves and gas-only calls', () => {
    const lines = walletLines(
      [
        {
          hash: '0xA1',
          timestamp: 1_700_000_000,
          from: OTHER,
          to: ME,
          status: 'success',
          transfers: [{ token: USD, amount: '100000000', direction: 'in' }],
        },
        {
          hash: '0xA2',
          timestamp: 1_700_000_100,
          from: ME,
          to: OTHER,
          status: 'success',
          transfers: [{ token: USD, amount: '25500000', direction: 'out' }],
        },
        {
          hash: '0xA3',
          timestamp: 1_700_000_200,
          from: ME,
          to: ME,
          status: 'success',
          transfers: [{ token: USD, amount: '1', direction: 'self' }],
        },
        { hash: '0xA4', timestamp: 1_700_000_300, from: ME, to: OTHER, status: 'success', transfers: [] },
      ],
      'TEST network',
    );
    expect(lines.map((l) => [l.kind, l.direction, l.amount, l.asset, l.sourceName, l.ref])).toEqual([
      ['transfer_in', 'in', '100', 'USD', 'TEST network', '0xa1'],
      ['transfer_out', 'out', '25.5', 'USD', 'TEST network', '0xa2'],
    ]);
    expect(lines[0]!.at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(lines[0]!.detail).toBeNull();
  });

  it('shows a failed transaction as failed, never as completed', () => {
    const [line] = walletLines(
      [
        {
          hash: '0xB1',
          timestamp: 1,
          from: ME,
          to: OTHER,
          status: 'failed',
          transfers: [{ token: USD, amount: '1000000', direction: 'out' }],
        },
      ],
      'n',
    );
    expect(line!.state).toBe('failed');
  });
});

describe('venueLines', () => {
  it('a fill is one trade line with what was paid and the fee, as the venue records them', () => {
    const [line] = venueLines(
      [
        {
          fillId: 'f1',
          symbol: 'BTC-USDC',
          side: 'buy',
          price: '60000',
          amount: '0.001',
          venueFee: '0.03',
          builderFee: '0.012',
          feeAsset: 'USDC',
          filledAt: '2026-11-14T00:00:00.000Z',
        },
      ],
      [],
      'TEST venue',
    );
    expect(line).toMatchObject({
      source: 'venue',
      kind: 'trade',
      direction: 'in',
      asset: 'BTC',
      amount: '0.001',
      ref: 'f1',
      state: 'completed',
    });
    expect(line!.detail).toEqual({
      kind: 'trade',
      side: 'buy',
      order: null,
      convert: null,
      quote: { asset: 'USDC', amount: '60' },
      fee: { asset: 'USDC', amount: '0.042', rebate: false },
    });
  });

  it('a fill of an order a conversion placed is a convert, filed under convert, with what it converted from and to', () => {
    const fill = {
      symbol: 'BTC-USDC',
      side: 'buy' as const,
      price: '60000',
      amount: '0.0001',
      venueFee: '0',
      builderFee: '0',
      feeAsset: 'USDC',
      filledAt: '2026-11-14T00:00:00.000Z',
    };
    const lines = venueLines(
      [
        { ...fill, fillId: 'c1', venueClientOrderId: '0xconvert' },
        { ...fill, fillId: 't1', venueClientOrderId: '0xtrade' },
      ],
      [],
      'TEST venue',
      [{ venueClientOrderId: '0xconvert', from: 'USDC', to: 'BTC' }],
    );
    expect(lines.map((l) => [l.ref, l.kind, typeOf(l.kind)])).toEqual([
      ['c1', 'convert', 'convert'],
      ['t1', 'trade', 'trade'],
    ]);
    expect(lines[0]!.detail).toMatchObject({ kind: 'trade', order: '0xconvert', convert: { from: 'USDC', to: 'BTC' } });
    expect(lines[1]!.detail).toMatchObject({ order: '0xtrade', convert: null });
  });

  it('every kind is filed under one of the six types the list names', () => {
    expect(
      (['trade', 'convert', 'deposit', 'withdrawal', 'transfer_in', 'transfer_out', 'space_move', 'fee', 'earn', 'other'] as const).map(
        typeOf,
      ),
    ).toEqual(['trade', 'convert', 'deposit', 'withdrawal', 'transfer', 'transfer', 'transfer', 'other', 'other', 'other']);
  });

  it('a maker rebate larger than the builder fee reads as a rebate', () => {
    const [line] = venueLines(
      [
        {
          fillId: 'f2',
          symbol: 'BTC-USDC',
          side: 'sell',
          price: '1',
          amount: '1',
          venueFee: '-0.5',
          builderFee: '0.1',
          feeAsset: 'USDC',
          filledAt: '2026-11-14T00:00:00.000Z',
        },
      ],
      [],
      'v',
    );
    expect(line!.direction).toBe('out');
    expect(line!.detail).toMatchObject({ fee: { amount: '0.4', rebate: true } });
  });

  it('a deposit still confirming, or not credited, is never shown as completed', () => {
    const base = {
      txHash: `0x${'1'.repeat(64)}`,
      asset: 'USDC',
      amount: '5',
      confirmations: 1,
      required: 3,
      seenAt: '2026-11-14T00:00:00.000Z',
    };
    const lines = venueLines(
      [],
      [
        { ...base, depositRef: 'd1', status: 'confirming' },
        { ...base, depositRef: 'd2', status: 'not_credited' },
        { ...base, depositRef: 'd3', status: 'credited' },
      ],
      'v',
    );
    expect(lines.map((l) => l.state)).toEqual(['confirming', 'not_credited', 'completed']);
    expect(lines[0]!.detail).toEqual({ kind: 'confirming', confirmations: 1, required: 3 });
  });
});

describe('partnerLines', () => {
  const item = (over: Partial<ActivityItem>): ActivityItem => ({
    id: 'm1.in',
    kind: 'deposit',
    direction: 'in',
    asset: 'USDT',
    amount: '20',
    postedAt: '2026-11-14T00:00:00.000Z',
    txId: 'm1',
    counterparty: null,
    spaceName: null,
    ...over,
  });
  it('keeps only the lines that carry the partner’s own name; a line of our own ledger is not a source', () => {
    const lines = partnerLines([item({ heldAt: { label: 'TEST partner' } }), item({ id: 'ledger-1' })]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ source: 'partner', sourceName: 'TEST partner', kind: 'deposit', ref: 'm1' });
  });
});

describe('oneList and filters', () => {
  const wallet = walletLines(
    [
      {
        hash: '0xC1',
        timestamp: 1_700_000_000,
        from: OTHER,
        to: ME,
        status: 'success',
        transfers: [{ token: USD, amount: '1000000', direction: 'in' }],
      },
    ],
    'n',
  );
  const venue = venueLines(
    [
      {
        fillId: 'f',
        symbol: 'BTC-USDC',
        side: 'buy',
        price: '2',
        amount: '3',
        venueFee: '0',
        builderFee: '0',
        feeAsset: 'USDC',
        filledAt: '2023-11-14T22:20:00.000Z',
      },
    ],
    [],
    'v',
  );
  it('merges every source newest first, or oldest first when asked', () => {
    expect(oneList([...wallet, ...venue]).map((l) => l.source)).toEqual(['venue', 'wallet']);
    expect(oneList([...wallet, ...venue], 'asc').map((l) => l.source)).toEqual(['wallet', 'venue']);
  });
  it('narrows by direction, words and coin (a trade matches its quote coin too)', () => {
    expect(keepLine(venue[0]!, { ...NO_FILTERS, dir: 'out' }, 'UTC', null, 'Bought BTC')).toBe(false);
    expect(keepLine(venue[0]!, NO_FILTERS, 'UTC', 'USDC', 'Bought BTC')).toBe(true);
    expect(keepLine(wallet[0]!, NO_FILTERS, 'UTC', 'BTC', 'Received')).toBe(false);
    expect(keepLine(wallet[0]!, { ...NO_FILTERS, q: 'received' }, 'UTC', null, 'Received in your wallet')).toBe(true);
  });
  it('names the filters no source can answer', () => {
    expect(unanswerable({ ...NO_FILTERS, hasNote: true, year: '2026' })).toEqual(['note', 'year']);
    expect(unanswerable(NO_FILTERS)).toEqual([]);
  });
  it('multiplies decimals exactly', () => {
    expect(product('60000.5', '0.001')).toBe('60.0005');
  });
});

describe('fillParts', () => {
  const fill = (fillId: string, side: 'buy' | 'sell', amount: string, venueFee = '0') => ({
    fillId,
    venueClientOrderId: '0xorder',
    symbol: 'BTC-USDC',
    side,
    price: '60000',
    amount,
    venueFee,
    builderFee: '0',
    feeAsset: 'USDC',
    filledAt: '2026-11-14T00:00:00.000Z',
  });
  const order = (patch: Partial<VenueOrderRead>): VenueOrderRead => ({
    side: 'buy',
    price: '60000',
    amount: '0.002',
    remaining: '0.001',
    status: 'partially_filled',
    locked: '60',
    lockedAsset: 'USDC',
    ...patch,
  });
  const parts = (lines: SourceLine[], o: VenueOrderRead | null) =>
    fillParts(lines, o).map((p) => [p.part, p.up, p.amount, p.asset, p.fill, ...(p.fromHold ? ['from hold'] : [])]);

  it('an order the venue never kept lists each fill’s two legs and its fee', () => {
    const lines = venueLines([fill('f1', 'buy', '0.001', '0.03')], [], 'TEST venue');
    expect(parts(lines, order({ status: 'filled', remaining: '0', locked: '0' }))).toEqual([
      ['received', true, '0.001', 'BTC', 'f1'],
      ['paid', false, '60', 'USDC', 'f1'],
      ['fee', false, '0.03', 'USDC', 'f1'],
    ]);
    expect(parts(lines, null)).toEqual([
      ['received', true, '0.001', 'BTC', 'f1'],
      ['paid', false, '60', 'USDC', 'f1'],
      ['fee', false, '0.03', 'USDC', 'f1'],
    ]);
  });

  it('a resting buy: both legs of its fill, the payment marked as spent from the quote held for the whole order', () => {
    const lines = venueLines([fill('f1', 'buy', '0.001')], [], 'TEST venue');
    expect(parts(lines, order({}))).toEqual([
      ['received', true, '0.001', 'BTC', 'f1'],
      ['paid', false, '60', 'USDC', 'f1', 'from hold'],
      ['held', false, '120', 'USDC', null],
    ]);
  });

  it('a cancelled buy: the hold and what came back for the unfilled rest', () => {
    const lines = venueLines([fill('f1', 'buy', '0.001')], [], 'TEST venue');
    expect(parts(lines, order({ status: 'canceled', locked: '0' }))).toEqual([
      ['received', true, '0.001', 'BTC', 'f1'],
      ['paid', false, '60', 'USDC', 'f1', 'from hold'],
      ['held', false, '120', 'USDC', null],
      ['released', true, '60', 'USDC', null],
    ]);
  });

  it('a cancelled sell holds its base: the base sold from the hold, the quote it got, the base held and released', () => {
    const lines = venueLines([fill('f1', 'sell', '0.001')], [], 'TEST venue');
    expect(parts(lines, order({ side: 'sell', status: 'canceled', locked: '0', lockedAsset: 'BTC' }))).toEqual([
      ['sold', false, '0.001', 'BTC', 'f1', 'from hold'],
      ['got', true, '60', 'USDC', 'f1'],
      ['held', false, '0.002', 'BTC', null],
      ['released', true, '0.001', 'BTC', null],
    ]);
  });

  it('orderLines groups the venue trade lines of one order', () => {
    const lines = venueLines(
      [fill('f1', 'buy', '0.001'), fill('f2', 'buy', '0.001'), { ...fill('f3', 'buy', '1'), venueClientOrderId: '0xother' }],
      [],
      'v',
    );
    expect(orderLines(lines, lines[0]!).map((l) => l.ref)).toEqual(['f1', 'f2']);
  });
});

describe('venueLines with includeOrders (J-portfolio-03 #3)', () => {
  const fill = (
    fillId: string,
    venueClientOrderId: string | null,
    amount: string,
    price = '60000',
    filledAt = '2026-11-24T10:00:00.000Z',
  ) => ({
    fillId,
    venueClientOrderId,
    symbol: 'BTC-USDC',
    side: 'buy' as const,
    price,
    amount,
    venueFee: '0.03',
    builderFee: '0.01',
    feeAsset: 'USDC',
    filledAt,
  });

  const orderEntry = (
    patch: Partial<{
      venueClientOrderId: string | null;
      side: 'buy' | 'sell';
      price: string;
      amount: string;
      filled: string;
      remaining: string;
      status: string;
      locked: string;
      lockedAsset: string;
      placedAt: string;
    }> = {},
  ) => ({
    order: {
      venueClientOrderId: patch.venueClientOrderId ?? '0xopen',
      symbol: 'BTC-USDC',
      side: patch.side ?? 'buy',
      price: patch.price ?? '59000',
      amount: patch.amount ?? '0.001',
      filled: patch.filled ?? '0',
      remaining: patch.remaining ?? '0.001',
      status: patch.status ?? 'open',
      locked: patch.locked ?? '59',
      lockedAsset: patch.lockedAsset ?? 'USDC',
    },
    placedAt: patch.placedAt ?? '2026-11-24T09:50:00.000Z',
  });

  it('groups multiple fills of one order into one row, shows a resting order as set_aside, and a cancelled order as one row', () => {
    const lines = venueLines(
      [
        fill('f1', '0xmulti', '0.001', '60000', '2026-11-24T10:00:00.000Z'),
        fill('f2', '0xmulti', '0.002', '60000', '2026-11-24T10:01:00.000Z'),
      ],
      [],
      'TEST venue',
      [],
      [
        orderEntry({ venueClientOrderId: '0xmulti', filled: '0.003', remaining: '0', status: 'filled', locked: '0' }),
        orderEntry({ venueClientOrderId: '0xopen', status: 'open', locked: '59', lockedAsset: 'USDC' }),
        orderEntry({
          venueClientOrderId: '0xcancel',
          status: 'canceled',
          locked: '0',
          lockedAsset: 'USDC',
          price: '58000',
          amount: '0.002',
        }),
        orderEntry({ venueClientOrderId: '0xreject', status: 'rejected', locked: '0', lockedAsset: 'USDC' }),
      ],
      { includeOrders: true },
    );

    expect(lines.map((l) => [l.kind, l.state, l.ref, l.amount, l.asset, typeOf(l.kind)])).toEqual([
      ['trade', 'completed', '0xmulti', '0.003', 'BTC', 'trade'],
      ['order_hold', 'set_aside', '0xopen', '59', 'USDC', 'trade'],
      ['order_cancelled', 'cancelled', '0xcancel', '116', 'USDC', 'trade'],
    ]);
    // Grouped trade row carries both fills' legs, summed quote cost and summed fee, and fillParts expands both fills.
    const multi = lines[0]!;
    expect(multi.detail).toMatchObject({
      kind: 'trade',
      order: '0xmulti',
      quote: { asset: 'USDC', amount: '180' },
      fee: { asset: 'USDC', amount: '0.08', rebate: false },
    });
    expect(fillParts([multi], null).map((p) => [p.part, p.fill, p.amount, p.asset])).toEqual([
      ['received', 'f2', '0.002', 'BTC'],
      ['paid', 'f2', '120', 'USDC'],
      ['fee', 'f2', '0.04', 'USDC'],
      ['received', 'f1', '0.001', 'BTC'],
      ['paid', 'f1', '60', 'USDC'],
      ['fee', 'f1', '0.04', 'USDC'],
    ]);
  });

  it('never duplicates a partially filled or cancelled-after-fill order as a resting or cancelled-nothing-spent row', () => {
    const lines = venueLines(
      [fill('f1', '0xpart', '0.001')],
      [],
      'TEST venue',
      [],
      [
        orderEntry({ venueClientOrderId: '0xpart', status: 'partially_filled', filled: '0.001', remaining: '0.001', locked: '60' }),
        orderEntry({ venueClientOrderId: '0xpart', status: 'canceled', filled: '0.001', remaining: '0.001', locked: '0' }),
      ],
      { includeOrders: true },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'trade', state: 'completed', ref: 'f1' });
  });
});
