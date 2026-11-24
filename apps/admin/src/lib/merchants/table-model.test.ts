import { describe, expect, it } from 'vitest';
import { assetsIn, filterRows, rowsToCsv, sortRows, type MerchantRow } from './table-model';

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

describe('the merchant list as CSV', () => {
  it('exports the visible merchant rows with amounts as the original decimal strings', () => {
    const rows: MerchantRow[] = [
      {
        merchantId: '11111111-1111-4111-8111-111111111111',
        displayName: 'Acme Shop',
        status: 'active',
        tierId: null,
        kybStatus: 'approved',
        volume: [{ assetCode: 'USDT', amount: '1234.500000000000000001' }],
        revenue: [],
        openFlags: 2,
      },
    ];
    const csv = rowsToCsv(rows, '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00Z', 'No filters.');
    expect(csv).toContain('1234.500000000000000001 USDT');
    expect(csv).toContain('# Data as of 2026-10-15T00:00:00Z');
    expect(csv).toContain('merchant_id,merchant_name,status,kyb_status,tier,lifetime_volume,lifetime_revenue,open_flags');
    expect(csv.trim().split('\r\n').at(-1)).toBe(
      '11111111-1111-4111-8111-111111111111,Acme Shop,active,approved,,1234.500000000000000001 USDT,,2',
    );
  });

  it('neutralises a merchant-supplied name that would run as a spreadsheet formula, and leaves an unnamed merchant blank', () => {
    const base = { status: 'active', tierId: null, kybStatus: 'approved', volume: [], revenue: [], openFlags: 0 } as const;
    const csv = rowsToCsv(
      [
        { ...base, merchantId: 'a', displayName: '=HYPERLINK("http://evil.example","x")' },
        { ...base, merchantId: 'b', displayName: null },
        { ...base, merchantId: 'c', displayName: 'Smith, Jones & Co' },
      ],
      '2026-10-15T00:00:00.000Z',
      null,
      'No filters.',
    );
    const lines = csv.trim().split('\r\n');
    expect(lines.at(-3)).toBe('a,"\'=HYPERLINK(""http://evil.example"",""x"")",active,approved,,,,0');
    expect(lines.at(-2)).toBe('b,,active,approved,,,,0');
    expect(lines.at(-1)).toBe('c,"Smith, Jones & Co",active,approved,,,,0');
  });
});
