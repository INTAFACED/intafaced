import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSV_NEWLINE, csvField, csvFilename, exportNote, listToCsv } from './csv';
import { downloadCsv } from './csv-browser';
import { readData } from './model';
import type { ReadSpec } from './types';

const spec: ReadSpec = {
  id: 'academy.ambassadors',
  title: 'Ambassadors',
  note: 'n',
  module: 'academy',
  procedure: 'ambassadors',
  shape: 'list',
  idKey: 'id',
  page: 2,
  emptyText: 'none',
  forbiddenText: 'refused',
  columns: [
    { key: 'id', label: 'Id', kind: 'text' },
    { key: 'name', label: 'Name, full', kind: 'text', detail: true },
    { key: 'rate', label: 'Rate', kind: 'bps' },
    { key: 'net', label: 'Net', kind: 'amount' },
    { key: 'live', label: 'Live', kind: 'bool' },
    { key: 'tags', label: 'Tags', kind: 'list' },
    { key: 'note', label: 'Note', kind: 'text', nullable: true },
  ],
};
const item = (over: Record<string, unknown> = {}) => ({
  id: 'a',
  name: 'Ada',
  rate: 1250,
  net: '12.50',
  live: true,
  tags: ['x', 'y'],
  note: null,
  ...over,
});
function csvOf(rows: unknown[]): string {
  const data = readData(spec, rows);
  if (data?.shape !== 'list') throw new Error('list expected');
  return listToCsv(spec, data);
}

describe('csvField escaping', () => {
  it('leaves plain text alone', () => {
    expect(csvField('hello world')).toBe('hello world');
    expect(csvField('')).toBe('');
  });
  it('quotes a comma, a quote, a newline and a carriage return, and doubles inner quotes', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
    expect(csvField('line1\r\nline2')).toBe('"line1\r\nline2"');
    expect(csvField(' padded ')).toBe('" padded "');
  });
  it('puts a single quote in front of anything that starts with = + - @ so a spreadsheet reads it as text', () => {
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField('+44 20 7946 0000')).toBe("'+44 20 7946 0000");
    expect(csvField('-2+3')).toBe("'-2+3");
    expect(csvField('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
    expect(csvField('-')).toBe("'-");
  });
  it('also guards a leading tab or carriage return, which spreadsheets treat the same way', () => {
    expect(csvField('\t=1+1')).toBe("'\t=1+1");
    expect(csvField('\r=1+1')).toBe(`"'\r=1+1"`);
  });
  it('guards first and then quotes, so a formula with commas and quotes stays inert', () => {
    expect(csvField('=HYPERLINK("http://evil.example","click")')).toBe(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
  });
  it('does not guard a formula that is not at the start', () => {
    expect(csvField('total =1+1')).toBe('total =1+1');
  });
  it('keeps a plain negative number a number only for numeric columns', () => {
    expect(csvField('-5.00', 'amount')).toBe('-5.00');
    expect(csvField('-3', 'int')).toBe('-3');
    expect(csvField('-1.25%', 'bps')).toBe('-1.25%');
    // Text that merely looks like one is still guarded, and anything that is not a bare number is guarded in any column.
    expect(csvField('-5.00', 'text')).toBe("'-5.00");
    expect(csvField('-5+cmd', 'amount')).toBe("'-5+cmd");
    expect(csvField('-1e3', 'amount')).toBe("'-1e3");
    expect(csvField('+5', 'int')).toBe("'+5");
  });
});

describe('listToCsv', () => {
  it('starts with a header row of every column label and holds exactly the rows given, in order', () => {
    const text = csvOf([item(), item({ id: 'b' })]);
    const lines = text.split(CSV_NEWLINE);
    expect(lines).toHaveLength(4); // header, two rows, and the empty piece after the final newline
    expect(lines[0]).toBe('Id,"Name, full",Rate,Net,Live,Tags,Note');
    expect(lines[1]).toBe('a,Ada,12.50%,12.50,yes,"x, y",');
    expect(lines[2]!.startsWith('b,')).toBe(true);
    expect(lines[3]).toBe('');
  });
  it('writes a null the service sent as an empty cell, not a dash', () => {
    expect(
      csvOf([item({ note: null })])
        .split(CSV_NEWLINE)[1]!
        .endsWith(','),
    ).toBe(true);
  });
  it('neutralises formulas a service returned, in the text it shows', () => {
    const text = csvOf([item({ id: 'a', name: '=cmd|"/c calc"!A1', note: '@evil' })]);
    expect(text).toContain(`"'=cmd|""/c calc""!A1"`);
    expect(text).toContain(",'@evil");
  });
  it('keeps a negative amount numeric', () => {
    expect(csvOf([item({ net: '-5.00' })]).split(CSV_NEWLINE)[1]).toContain(',-5.00,');
  });
  it('a value with a newline stays one record', () => {
    const text = csvOf([item({ name: 'two\nlines' })]);
    expect(text).toContain('"two\nlines"');
  });
});

describe('filename and note', () => {
  it('carries the read, the words "rows shown" and the as-of time, and no characters a file system dislikes', () => {
    expect(csvFilename('academy.ambassadors', '2026-10-17T03:00:00.123Z')).toBe(
      'academy-ambassadors_rows-shown_as-of_2026-10-17T03-00-00Z.csv',
    );
    expect(csvFilename('../x y', 'not a time')).toBe('x-y_rows-shown_as-of_time-unknown.csv');
  });
  it('says rows shown, and says so loudly when the read was capped', () => {
    expect(exportNote(5, false, 50, 'T')).toBe('Exports the 5 rows shown above (not a full table export), as read at T.');
    expect(exportNote(1, false, undefined, 'T')).toContain('1 row shown');
    const capped = exportNote(2, true, 2, 'T');
    expect(capped).toContain('capped at 2 rows');
    expect(capped).toContain('more rows may exist');
  });
});

describe('downloadCsv', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('hands the browser a UTF-8 file with a byte order mark and the given name, and cleans up', () => {
    const link = { href: '', download: '', rel: '', click: vi.fn(), remove: vi.fn() };
    const blobs: Blob[] = [];
    vi.stubGlobal('document', { createElement: vi.fn(() => link), body: { append: vi.fn() } });
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return 'blob:x';
      }),
      revokeObjectURL: vi.fn(),
    });
    expect(downloadCsv('f.csv', 'a,b\r\n')).toBe(true);
    expect(link.download).toBe('f.csv');
    expect(link.href).toBe('blob:x');
    expect(link.click).toHaveBeenCalledTimes(1);
    expect(link.remove).toHaveBeenCalledTimes(1);
    expect(blobs[0]!.type).toBe('text/csv;charset=utf-8');
  });
  it('says false instead of throwing when the browser refuses', () => {
    vi.stubGlobal('document', {
      createElement: () => {
        throw new Error('blocked');
      },
    });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: vi.fn() });
    expect(downloadCsv('f.csv', 'a')).toBe(false);
  });
});
