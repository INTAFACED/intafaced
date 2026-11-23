import { describe, expect, it } from 'vitest';
import { buildCsv, csvCell } from './csv';

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
});
