import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './depth-csv';

describe('depth CSV export', () => {
  it('quotes separators and doubles quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('');
    expect(csvCell(12)).toBe('12');
  });
  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@cmd')).toBe("'@cmd");
  });
  it('writes a header and CRLF rows', () => {
    expect(toCsv(['a', 'b'], [[1, 'x,y']])).toBe('a,b\r\n1,"x,y"\r\n');
  });
});
