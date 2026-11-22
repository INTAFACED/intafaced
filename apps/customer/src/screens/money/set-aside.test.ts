import { describe, expect, it } from 'vitest';
import { lockSplits } from './portfolio-source';
import { setAsideLines, setAsideSum, setAsideWhat, shortId } from './set-aside';
import { setAsideRef } from './SetAside';

/** W-balances-01 (J-wallet-01 #2): each lock on a coin, named as the bank names it, and the sum back to the balance. */

const answer = {
  assets: [
    {
      assetId: 'USDT',
      total: '500',
      available: '362.942',
      locked: [
        {
          kind: 'hold',
          amount: '137.058',
          claims: [
            { purpose: 'order:b0419840-3bf1-87ee-9650-5f4ca5d3a992', amount: '117.058' },
            { purpose: 'withdraw:wd-77', amount: '20' },
          ],
        },
      ],
    },
  ],
};

describe('what a lock is for', () => {
  it('names an open order and a withdrawal by their ids', () => {
    expect(setAsideWhat('hold', 'order:abc-1')).toEqual({ kind: 'order', id: 'abc-1' });
    expect(setAsideWhat('hold', 'withdraw:wd-77')).toEqual({ kind: 'withdrawal', id: 'wd-77' });
  });

  it('keeps the bank purpose for every other claim, and an unknown lock kind as it is', () => {
    expect(setAsideWhat('hold', 'pay:recv:h1')).toEqual({ kind: 'hold', purpose: 'pay:recv:h1' });
    expect(setAsideWhat('escrow', 'p2p:t1')).toEqual({ kind: 'escrow', purpose: 'p2p:t1' });
    expect(setAsideWhat('stake', 'earn:pool-1')).toEqual({ kind: 'stake', purpose: 'earn:pool-1' });
    expect(setAsideWhat('collateral', 'loan:l1')).toEqual({ kind: 'collateral', purpose: 'loan:l1' });
    expect(setAsideWhat('frozen', 'case:9')).toEqual({ kind: 'other', lock: 'frozen', purpose: 'case:9' });
    // An order purpose on a lock that is not a hold is not an open order.
    expect(setAsideWhat('escrow', 'order:abc')).toEqual({ kind: 'escrow', purpose: 'order:abc' });
  });

  it('shortens an id to eight characters for the line', () => {
    expect(shortId('b0419840-3bf1-87ee-9650-5f4ca5d3a992')).toBe('b0419840');
    expect(shortId('wd-77')).toBe('wd-77');
  });
});

describe('the set-aside lines of a coin', () => {
  const split = lockSplits(answer)!.USDT!;

  it('carries the bank total, and lists every claim, largest first, amounts as returned', () => {
    expect(split.total).toBe('500');
    expect(setAsideLines(split)).toEqual([
      { what: { kind: 'order', id: 'b0419840-3bf1-87ee-9650-5f4ca5d3a992' }, amount: '117.058' },
      { what: { kind: 'withdrawal', id: 'wd-77' }, amount: '20' },
    ]);
    expect(setAsideLines(undefined)).toEqual([]);
  });

  it('adds available and every claim back to the total exactly', () => {
    expect(setAsideSum(split, split.total!)).toEqual({ setAside: '137.058', adds: true });
    expect(setAsideSum(split, '500.000000001')).toEqual({ setAside: '137.058', adds: false });
  });

  it('claims no sum when a figure does not parse', () => {
    expect(setAsideSum({ ...split, available: 'n/a' }, '500')).toBeNull();
    expect(setAsideSum(split, '')).toBeNull();
  });

  it('refuses the whole answer when the total does not parse, so no figure is guessed', () => {
    expect(lockSplits({ assets: [{ ...answer.assets[0]!, total: 'lots' }] })).toBeNull();
  });
});

describe('a lock the bank did not itemise in full', () => {
  const split = lockSplits({
    assets: [
      {
        assetId: 'USDT',
        total: '505',
        available: '362.942',
        locked: [
          { kind: 'hold', amount: '137.058', claims: [{ purpose: 'order:abc', amount: '100' }] },
          { kind: 'escrow', amount: '5', claims: [] },
        ],
      },
    ],
  })!.USDT!;

  it('keeps the rest of each lock as its own line, so the lines add up to the In orders and Locked figures', () => {
    expect(split.inOrders).toBe('137.058');
    expect(split.locked).toBe('5');
    expect(setAsideLines(split)).toEqual([
      { what: { kind: 'order', id: 'abc' }, amount: '100' },
      { what: { kind: 'hold', purpose: '' }, amount: '37.058' },
      { what: { kind: 'escrow', purpose: '' }, amount: '5' },
    ]);
    expect(setAsideSum(split, split.total!)).toEqual({ setAside: '142.058', adds: true });
  });
});

describe('the reference behind a line', () => {
  it("is the whole id of an order or withdrawal, the bank's purpose otherwise, and nothing for an unitemised rest", () => {
    expect(setAsideRef({ kind: 'order', id: 'b0419840-3bf1' })).toBe('b0419840-3bf1');
    expect(setAsideRef({ kind: 'escrow', purpose: 'p2p:t1' })).toBe('p2p:t1');
    expect(setAsideRef({ kind: 'other', lock: 'frozen', purpose: 'case:9' })).toBe('frozen case:9');
    expect(setAsideRef({ kind: 'hold', purpose: '' })).toBeUndefined();
  });
});
