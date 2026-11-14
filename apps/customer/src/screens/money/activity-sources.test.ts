import { describe, expect, it } from 'vitest';
import type { ActivityItem } from '../../data/activity';
import { NO_FILTERS } from './activity-filter';
import { keepLine, oneList, partnerLines, product, unanswerable, venueLines, walletLines } from './activity-sources';

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
      quote: { asset: 'USDC', amount: '60' },
      fee: { asset: 'USDC', amount: '0.042', rebate: false },
    });
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
