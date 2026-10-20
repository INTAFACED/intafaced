import { describe, expect, it } from 'vitest';
import { OPS_COST_CATEGORIES } from '@intafaced/contracts';
import {
  COST_CATEGORIES,
  csvCell,
  currentPeriod,
  entryProblem,
  normaliseCostAmount,
  periodFromQuery,
  venueCostsCsv,
  venueCostsFilename,
  type CostLineView,
} from './model';

const entry = (version: number, amount: string, note = 'TEST invoice') => ({
  key: `venue-cost:2026-10:custody:${version}`,
  version,
  amount,
  asset: 'USD',
  sourceNote: note,
  enteredBy: 'u1',
  approverId: 'u2',
  enteredAt: '2026-10-20T01:00:00.000Z',
});

describe('venue economics model', () => {
  it('repeats the contracts category list exactly (the contracts root is not a browser entry)', () => {
    expect([...COST_CATEGORIES]).toEqual([...OPS_COST_CATEGORIES]);
  });

  it('opens on the current UTC month and accepts only a month in the query', () => {
    expect(currentPeriod(new Date('2026-10-20T23:59:00Z'))).toBe('2026-10');
    expect(currentPeriod(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01');
    expect(periodFromQuery('2026-09')).toBe('2026-09');
    expect(periodFromQuery('2026-9')).toBeNull();
    expect(periodFromQuery(['2026-09'])).toBeNull();
    expect(periodFromQuery(undefined)).toBeNull();
  });

  it('names why the form cannot send, and refuses a negative or non-number amount', () => {
    const ok = { period: '2026-10', category: 'custody', amount: '12.5', asset: 'USD' };
    expect(entryProblem(ok)).toBeNull();
    expect(entryProblem({ ...ok, category: 'rent' })).toMatch(/seven cost lines/);
    expect(entryProblem({ ...ok, amount: '' })).toMatch(/Enter the amount/);
    expect(entryProblem({ ...ok, amount: '-5' })).toMatch(/no minus sign/);
    expect(entryProblem({ ...ok, amount: '1,000' })).toMatch(/plain number/);
    expect(entryProblem({ ...ok, asset: 'usd' })).toMatch(/capitals/);
    expect(entryProblem({ ...ok, period: '2026-13' })).toMatch(/month/);
  });

  it('writes amounts the way svc-ops stores them', () => {
    expect(normaliseCostAmount('1250.50')).toBe('1250.5');
    expect(normaliseCostAmount('10.00')).toBe('10');
    expect(normaliseCostAmount('0.0')).toBe('0');
    expect(normaliseCostAmount('100')).toBe('100');
  });

  it('guards spreadsheet formulas in CSV cells and quotes commas', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('exports every version, marks the current one, and never writes a zero for a missing line', () => {
    const lines: CostLineView[] = [
      { status: 'entered', category: 'custody', current: entry(2, '90'), history: [entry(1, '100.5'), entry(2, '90', '=cmd')] },
      { status: 'not_entered', category: 'data' },
    ];
    const rows = venueCostsCsv('2026-10', lines).trimEnd().split('\r\n');
    expect(rows[0]).toBe('period,category,status,version,amount,asset,source_note,entered_by,approved_by,entered_at,is_current');
    expect(rows[1]).toBe('2026-10,custody,entered,1,100.5,USD,TEST invoice,u1,u2,2026-10-20T01:00:00.000Z,no');
    expect(rows[2]).toBe("2026-10,custody,entered,2,90,USD,'=cmd,u1,u2,2026-10-20T01:00:00.000Z,yes");
    expect(rows[3]).toBe('2026-10,data,not_entered,,,,,,,,');
    expect(rows).toHaveLength(4);
  });

  it('names the file by month and read time', () => {
    expect(venueCostsFilename('2026-10', '2026-10-20T10:00:00.000Z')).toBe('venue-costs_2026-10_as-of_2026-10-20T10-00-00Z.csv');
    expect(venueCostsFilename('2026-10', 'nope')).toBe('venue-costs_2026-10_as-of_time-unknown.csv');
  });
});
