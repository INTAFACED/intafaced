import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '../../../features/trade/trade-api';
import { dayStart, ledgerKindKey, sameAmount, sha256Hex, statementRange, sumByAsset, todayEnd } from './ledger';

function entry(currency: string, direction: 'in' | 'out', amount: string): LedgerEntry {
  return {
    id: '1',
    referenceId: 'tx',
    timestamp: 0,
    datetime: '2026-10-01T00:00:00.000Z',
    currency,
    direction,
    amount,
    type: 'trade.fill',
    module: 'trade',
    orderId: null,
  };
}

describe('sumByAsset', () => {
  it('adds money in and takes money out, per asset, exactly', () => {
    const sums = sumByAsset([
      entry('USDT', 'in', '2000'),
      entry('USDT', 'out', '24.5'),
      entry('BTC', 'in', '0.00049'),
      entry('USDT', 'in', '0.1'),
      entry('USDT', 'in', '0.2'),
    ]);
    expect([...sums]).toEqual([
      ['BTC', '0.00049'],
      ['USDT', '1975.8'],
    ]);
  });

  it('reads a sum below zero as negative, never as a balance', () => {
    expect(sumByAsset([entry('ETH', 'out', '1')]).get('ETH')).toBe('-1');
  });

  it('compares amounts, not their spelling', () => {
    expect(sameAmount('1975.80', '1975.8')).toBe(true);
    expect(sameAmount('1975.8', '1975.80000001')).toBe(false);
  });
});

describe('statementRange', () => {
  const now = new Date('2026-10-20T12:34:56.789Z');

  it('covers both days picked, in UTC, and the key is the days themselves', () => {
    expect(statementRange('2026-10-01', '2026-10-19', now)).toEqual({
      ok: true,
      range: {
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-20T00:00:00.000Z',
        requestKey: 'statement:2026-10-01:2026-10-19',
        endsToday: false,
      },
    });
  });

  it('ends a settled minute before it was asked when the last day is today, and that end is in the key', () => {
    expect(statementRange('2026-10-20', '2026-10-20', now)).toEqual({
      ok: true,
      range: {
        from: '2026-10-20T00:00:00.000Z',
        to: '2026-10-20T12:33:00.000Z',
        requestKey: 'statement:2026-10-20:2026-10-20T12:33:00.000Z',
        endsToday: true,
      },
    });
    // The same dialog asking again: the same range and key.
    expect(statementRange('2026-10-20', '2026-10-20', new Date('2026-10-20T12:34:59.999Z'))).toEqual(
      statementRange('2026-10-20', '2026-10-20', now),
    );
  });

  it('refuses a day after today, today’s first minute, days the wrong way round, and a day that is not one', () => {
    expect(statementRange('2026-10-01', '2026-10-21', now)).toEqual({ ok: false, why: 'future' });
    expect(statementRange('2026-10-20', '2026-10-20', new Date('2026-10-20T00:01:30.000Z'))).toEqual({ ok: false, why: 'future' });
    expect(todayEnd(new Date('2026-10-20T00:02:00.000Z')).toISOString()).toBe('2026-10-20T00:01:00.000Z');
    expect(statementRange('2026-10-05', '2026-10-01', now)).toEqual({ ok: false, why: 'order' });
    expect(statementRange('', '2026-10-01', now)).toEqual({ ok: false, why: 'days' });
    expect(dayStart('2026-02-30')).toBeNull();
    expect(dayStart('2026-10-01')?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('sha256Hex', () => {
  it('is the SHA-256 of the text', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('ledgerKindKey', () => {
  it('names every fill kind a fill, a sale to the token buyback included', () => {
    for (const type of ['trade.fill', 'trade.fill.mm_maker', 'trade.fill.buyback'])
      expect(ledgerKindKey({ type })).toBe('Ledger kind fill');
  });

  it('reads deposits and withdrawals by prefix, and anything else as other', () => {
    expect(ledgerKindKey({ type: 'deposit.credited' })).toBe('Ledger kind deposit');
    expect(ledgerKindKey({ type: 'withdraw.settled' })).toBe('Ledger kind withdrawal');
    expect(ledgerKindKey({ type: 'brand.new.reason' })).toBe('Ledger kind other');
  });
});
