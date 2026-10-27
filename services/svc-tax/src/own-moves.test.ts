import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import type { AccountLine, InflowLine } from './ledger-reads.js';
import { pairOwnMoves } from './own-moves.js';

// TEST lines only. SPACE is one of the customer's own named spaces.
const SPACE = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const at = (n: number) => new Date(Date.UTC(2026, 9, n));
const line = (txId: string, direction: 'debit' | 'credit', qty: string, reason = 'bank.transfer.manual', day = 5): AccountLine => ({
  txId,
  postedAt: at(day),
  assetId: 'BTC',
  amount: amt(qty),
  reason,
  direction,
});
const inflow = (txId: string, qty: string, reason = 'bank.transfer.manual', day = 5): InflowLine => ({
  txId,
  postedAt: at(day),
  assetId: 'BTC',
  amount: amt(qty),
  reason,
});

describe('pairOwnMoves', () => {
  it('pairs a credit on main and a debit on a space in one transaction as a move from main to the space', () => {
    const got = pairOwnMoves({
      mainInflows: [],
      mainOutflows: [line('m1', 'credit', '1')],
      spaceLines: [{ ...line('m1', 'debit', '1'), spaceId: SPACE }],
    });
    expect(got.moves).toEqual([{ txId: 'm1', postedAt: at(5), assetId: 'BTC', amount: amt('1'), from: null, to: SPACE }]);
    expect(got.spaceInflows).toEqual([]);
  });

  it('pairs a move back to main and drops it from the main arrivals, so it is not a new lot', () => {
    const got = pairOwnMoves({
      mainInflows: [inflow('m2', '0.4'), inflow('dep', '2', 'deposit.credited')],
      mainOutflows: [],
      spaceLines: [{ ...line('m2', 'credit', '0.4'), spaceId: SPACE }],
    });
    expect(got.moves).toEqual([{ txId: 'm2', postedAt: at(5), assetId: 'BTC', amount: amt('0.4'), from: SPACE, to: null }]);
    expect(got.mainInflows.map((l) => l.txId)).toEqual(['dep']);
  });

  it('pairs a move between two spaces', () => {
    const got = pairOwnMoves({
      mainInflows: [],
      mainOutflows: [],
      spaceLines: [
        { ...line('m3', 'credit', '1'), spaceId: SPACE },
        { ...line('m3', 'debit', '1'), spaceId: OTHER },
      ],
    });
    expect(got.moves).toEqual([{ txId: 'm3', postedAt: at(5), assetId: 'BTC', amount: amt('1'), from: SPACE, to: OTHER }]);
  });

  it('never pairs a withdrawal from main and an arrival in a space in two transactions', () => {
    const got = pairOwnMoves({
      mainInflows: [],
      mainOutflows: [line('wd', 'credit', '1', 'withdraw.sent', 4)],
      spaceLines: [{ ...line('in', 'debit', '1', 'bank.transfer.manual', 6), spaceId: SPACE }],
    });
    expect(got.moves).toEqual([]);
    expect(got.spaceInflows).toEqual([
      { txId: 'in', postedAt: at(6), assetId: 'BTC', amount: amt('1'), reason: 'bank.transfer.manual', spaceId: SPACE },
    ]);
  });

  it('does not pair legs of different amounts, or a transaction with more than one leg each way', () => {
    const uneven = pairOwnMoves({
      mainInflows: [],
      mainOutflows: [line('m4', 'credit', '1')],
      spaceLines: [{ ...line('m4', 'debit', '0.9'), spaceId: SPACE }],
    });
    expect(uneven.moves).toEqual([]);
    expect(uneven.spaceInflows.map((l) => l.txId)).toEqual(['m4']);
    const split = pairOwnMoves({
      mainInflows: [],
      mainOutflows: [line('m5', 'credit', '1')],
      spaceLines: [
        { ...line('m5', 'debit', '0.5'), spaceId: SPACE },
        { ...line('m5', 'debit', '0.5'), spaceId: OTHER },
      ],
    });
    expect(split.moves).toEqual([]);
  });

  it('leaves what left a space for someone else unfollowed, and main lines with no space in their transaction alone', () => {
    const got = pairOwnMoves({
      mainInflows: [inflow('dep', '1', 'deposit.credited')],
      mainOutflows: [line('hold', 'credit', '1', 'order.hold.placed')],
      spaceLines: [{ ...line('gift', 'credit', '0.1'), spaceId: SPACE }],
    });
    expect(got).toEqual({ moves: [], mainInflows: [inflow('dep', '1', 'deposit.credited')], spaceInflows: [] });
  });
});
