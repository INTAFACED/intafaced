import { describe, expect, it } from 'vitest';
import { depositAssets, depositHistory, depositTotal, type DepositItem } from './deposit-model';

const row = (over: Partial<DepositItem>): DepositItem => ({
  id: 'a',
  kind: 'deposit',
  direction: 'in',
  asset: 'USDT',
  amount: '1',
  postedAt: '2026-10-01T00:00:00Z',
  ...over,
});

describe('deposit assets', () => {
  it('lists held assets first and every asset once', () => {
    expect(depositAssets(['USDT', 'BTC'], ['ETH', 'btc', 'ADA', ' '])).toEqual(['USDT', 'BTC', 'ADA', 'ETH']);
  });
  it('is empty when nothing is held or listed', () => {
    expect(depositAssets([], [])).toEqual([]);
  });
});

describe('deposit history', () => {
  const items = [
    row({ id: '1', postedAt: '2026-10-01T00:00:00Z' }),
    row({ id: '2', kind: 'welcome_funds', postedAt: '2026-10-03T00:00:00Z' }),
    row({ id: '3', kind: 'transfer_in', postedAt: '2026-10-04T00:00:00Z' }),
    row({ id: '4', direction: 'out', postedAt: '2026-10-05T00:00:00Z' }),
    row({ id: '5', asset: 'BTC', postedAt: '2026-10-02T00:00:00Z' }),
  ];
  it('keeps only incoming deposits, newest first', () => {
    expect(depositHistory(items, null).map((r) => r.id)).toEqual(['2', '5', '1']);
  });
  it('narrows to one asset', () => {
    expect(depositHistory(items, 'BTC').map((r) => r.id)).toEqual(['5']);
  });
});

describe('deposit total', () => {
  it('adds exactly in one asset', () => {
    expect(depositTotal([row({ amount: '0.1' }), row({ amount: '0.2' })])).toEqual({ asset: 'USDT', amount: 300000000000000000n });
  });
  it('refuses to add different assets', () => {
    expect(depositTotal([row({}), row({ asset: 'BTC' })])).toBeNull();
    expect(depositTotal([])).toBeNull();
  });
});
