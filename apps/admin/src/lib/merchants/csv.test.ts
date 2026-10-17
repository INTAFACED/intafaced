import { describe, expect, it } from 'vitest';
import { buildCsv, csvCell } from './csv';
import { rowsToCsv, type MerchantRow } from './table-model';

describe('csv', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('x\ny')).toBe('"x\ny"');
    expect(csvCell('plain')).toBe('plain');
  });

  it('defuses spreadsheet formulas', () => {
    for (const bad of ['=1+1', '+SUM(A1)', '-2', '@cmd', '\tx']) expect(csvCell(bad).replace(/^"/, '')).toMatch(/^'/);
  });

  it('writes generated-at and as-of first', () => {
    const out = buildCsv({ header: ['a'], rows: [['1']], generatedAt: '2026-10-15T00:00:00.000Z', asOf: null });
    expect(out.split('\r\n').slice(0, 2)).toEqual(['# Generated at 2026-10-15T00:00:00.000Z', '# Data as of unknown']);
  });

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
