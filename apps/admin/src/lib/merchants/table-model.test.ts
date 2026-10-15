import { describe, expect, it } from 'vitest';
import { assetsIn, filterRows, sortRows, type MerchantRow } from './table-model';

const row = (id: string, status: string, volume: string | null, extra: Partial<MerchantRow> = {}): MerchantRow => ({
  merchantId: id,
  displayName: null,
  status,
  tierId: null,
  kybStatus: 'approved',
  volume: volume === null ? [] : [{ assetCode: 'USDT', amount: volume }],
  revenue: [],
  openFlags: 0,
  ...extra,
});

const rows = [row('c', 'active', '10'), row('a', 'suspended', '9.99'), row('b', 'active', null), row('d', 'active', '100')];

describe('merchant table model', () => {
  it('filters the loaded rows on id, status and KYB text', () => {
    expect(filterRows(rows, 'susp').map((r) => r.merchantId)).toEqual(['a']);
    expect(filterRows(rows, '  ').length).toBe(4);
    expect(filterRows(rows, 'zzz')).toEqual([]);
  });

  it('sorts money exactly and puts "no payments" last in both directions', () => {
    expect(sortRows(rows, 'volume', 'asc', 'USDT').map((r) => r.merchantId)).toEqual(['a', 'c', 'd', 'b']);
    expect(sortRows(rows, 'volume', 'desc', 'USDT').map((r) => r.merchantId)).toEqual(['d', 'c', 'a', 'b']);
  });

  it('sorts text columns with the id as a stable tiebreak', () => {
    expect(sortRows(rows, 'status', 'asc', null).map((r) => r.merchantId)).toEqual(['b', 'c', 'd', 'a']);
    expect(sortRows(rows, 'merchantId', 'desc', null).map((r) => r.merchantId)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('finds a merchant by name, ignoring case, as well as by id', () => {
    const named = [
      row('a', 'active', '1', { displayName: 'Acme Shop' }),
      row('b', 'active', '1', { displayName: 'Zed Ltd' }),
      row('c', 'active', '1'),
    ];
    expect(filterRows(named, 'acme').map((r) => r.merchantId)).toEqual(['a']);
    expect(filterRows(named, 'ZED').map((r) => r.merchantId)).toEqual(['b']);
    expect(filterRows(named, 'b').map((r) => r.merchantId)).toEqual(['b']);
  });

  it('sorts by name with unnamed merchants last in both directions and the id as the tiebreak', () => {
    const named = [
      row('d', 'active', '1'),
      row('b', 'active', '1', { displayName: 'beta' }),
      row('c', 'active', '1', { displayName: 'Alpha' }),
      row('a', 'active', '1', { displayName: 'alpha' }),
      row('e', 'active', '1'),
    ];
    expect(sortRows(named, 'displayName', 'asc', null).map((r) => r.merchantId)).toEqual(['a', 'c', 'b', 'd', 'e']);
    expect(sortRows(named, 'displayName', 'desc', null).map((r) => r.merchantId)).toEqual(['b', 'a', 'c', 'd', 'e']);
  });

  it('lists the assets on the page', () => {
    expect(assetsIn([row('a', 'active', '1'), row('b', 'active', null, { revenue: [{ assetCode: 'USD', amount: '1' }] })])).toEqual([
      'USD',
      'USDT',
    ]);
  });
});
