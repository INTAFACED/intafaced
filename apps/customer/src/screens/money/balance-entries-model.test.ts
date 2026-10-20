import { describe, expect, it } from 'vitest';
import { accountFromSearch, assetFromPath, balanceEntriesHref, balanceEntriesSchema, shownSum, signedOf } from './balance-entries-model';

const row = (direction: 'debit' | 'credit', amount: string) => ({
  entryId: null,
  txId: 't',
  accountId: 'main',
  reason: 'x',
  direction,
  amount,
  postedAt: '2026-10-01T00:00:00.000Z',
});

describe('balance entries model', () => {
  it('adds money in and takes away money out, exactly', () => {
    expect(shownSum([row('debit', '0.1'), row('debit', '0.2'), row('credit', '0.3')])).toBe('0');
    expect(shownSum([row('debit', '1.000000000000000001'), row('credit', '0.5')])).toBe('0.500000000000000001');
    expect(signedOf(row('credit', '2'))).toBe(-2000000000000000000n);
  });
  it('never turns an amount that does not parse into zero', () => {
    expect(shownSum([row('debit', '1'), row('debit', 'abc')])).toBeNull();
    expect(signedOf(row('debit', 'abc'))).toBeNull();
  });
  it('reads the coin and the account from the address, and ignores anything else', () => {
    expect(assetFromPath('btc')).toBe('BTC');
    expect(assetFromPath('%E0%A4%A')).toBe('');
    expect(accountFromSearch('?account=main')).toBe('main');
    expect(accountFromSearch('?account=44444444-4444-4444-8444-444444444444')).toBe('44444444-4444-4444-8444-444444444444');
    expect(accountFromSearch('?account=../x')).toBeNull();
    expect(balanceEntriesHref('BTC')).toBe('/money/balance/BTC');
    expect(balanceEntriesHref('BTC', 'main')).toBe('/money/balance/BTC?account=main');
  });
  it('accepts the bank answer and refuses one without a passed check', () => {
    const ok = {
      assetId: 'BTC',
      entries: [row('debit', '1')],
      nextCursor: null,
      sumCheck: { ok: true, entriesSum: '1', balance: '1', entryCount: 1 },
    };
    expect(balanceEntriesSchema.safeParse(ok).success).toBe(true);
    expect(balanceEntriesSchema.safeParse({ ...ok, sumCheck: { ...ok.sumCheck, ok: false } }).success).toBe(false);
  });
});
