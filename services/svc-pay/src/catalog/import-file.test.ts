import { describe, expect, it } from 'vitest';
import { PRODUCT_IMPORT_MAX_ROWS } from '@intafaced/contracts';
import { checkImportFile, parseCsv } from './import-file.js';

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  throw new Error('expected a refusal');
};

describe('reading a CSV file (J-merchant-03 step 5)', () => {
  it('splits cells and records, keeps quoted commas, quotes and line breaks, and numbers records by their first line', () => {
    const { records, unclosedAt } = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n"two\nlines",z\rlast,1');
    expect(unclosedAt).toBeNull();
    expect(records).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['x, y', 'say "hi"'] },
      { line: 3, cells: ['two\nlines', 'z'] },
      { line: 5, cells: ['last', '1'] },
    ]);
  });

  it('a trailing line break makes no empty record, and an unclosed quote names the line its record starts on', () => {
    expect(parseCsv('a\nb\n').records).toEqual([
      { line: 1, cells: ['a'] },
      { line: 2, cells: ['b'] },
    ]);
    expect(parseCsv('a\nb\n"open\nstill').unclosedAt).toBe(3);
  });
});

describe('checking a file of products (J-merchant-03 step 5)', () => {
  it('a good file lists its products in file order, blank cells left out and blank lines skipped', () => {
    const file = checkImportFile(
      'Name,Type,product_id,unit_label,statement_descriptor,event_starts_at,event_location\n' +
        'TEST Mug,physical,test-mug,mug,TEST MUG SHOP,,\n' +
        '\n' +
        'TEST Talk,Event,,,,2026-12-01T19:00:00Z,TEST Hall\n',
    );
    expect(file.problems).toEqual([]);
    expect(file.rows).toBe(2);
    expect(file.products).toEqual([
      {
        line: 2,
        input: { name: 'TEST Mug', type: 'physical', productKey: 'test-mug', unitLabel: 'mug', statementDescriptor: 'TEST MUG SHOP' },
      },
      { line: 4, input: { name: 'TEST Talk', type: 'event', event: { startsAt: '2026-12-01T19:00:00Z', location: 'TEST Hall' } } },
    ]);
  });

  it('every bad line is named with its line and column, and only good lines become products', () => {
    const file = checkImportFile(
      'name,type,product_id,event_starts_at,event_location\n' +
        ',physical,,,\n' +
        'TEST A,toy,,,\n' +
        'TEST B,service,Bad Id,,\n' +
        'TEST C,service,test-c,,\n' +
        'TEST D,digital,test-c,,\n' +
        'TEST E,event,,soon,\n' +
        'TEST F,digital,,,TEST Hall\n' +
        'TEST G,digital\n' +
        `${'x'.repeat(251)},digital,,,\n`,
    );
    expect(file.problems).toEqual([
      { line: 2, column: 'name', problem: 'value_required' },
      { line: 3, column: 'type', problem: 'value_invalid' },
      { line: 4, column: 'product_id', problem: 'value_invalid' },
      { line: 6, column: 'product_id', problem: 'id_repeated' },
      { line: 7, column: 'event_starts_at', problem: 'value_invalid' },
      { line: 7, column: 'event_location', problem: 'event_details_required' },
      { line: 8, column: 'event_location', problem: 'event_details_not_event' },
      { line: 9, column: null, problem: 'row_width' },
      { line: 10, column: 'name', problem: 'value_too_long' },
    ]);
    expect(file.rows).toBe(9);
    expect(file.products.map((p) => p.line)).toEqual([5]);
  });

  it('a header with an unknown, repeated or missing column says so on line 1 and makes no product', () => {
    const file = checkImportFile('name,colour,name\nTEST Mug,red,TEST Mug\n');
    expect(file.problems).toEqual([
      { line: 1, column: 'colour', problem: 'column_unknown' },
      { line: 1, column: 'name', problem: 'column_repeated' },
      { line: 1, column: 'type', problem: 'column_missing' },
    ]);
    expect(file.products).toEqual([]);
  });

  it('a statement descriptor breaking the card rule is invalid, and one over 22 characters is too long', () => {
    const file = checkImportFile('name,type,statement_descriptor\nTEST A,digital,12345\nTEST B,digital,TEST A VERY LONG SHOP NAME\n');
    expect(file.problems).toEqual([
      { line: 2, column: 'statement_descriptor', problem: 'value_invalid' },
      { line: 3, column: 'statement_descriptor', problem: 'value_too_long' },
    ]);
  });

  it('an unclosed quote is a problem on its line, the header line included', () => {
    expect(checkImportFile('name,type\nTEST A,digital\n"TEST B,digital\n').problems).toEqual([
      { line: 3, column: null, problem: 'quote_unclosed' },
    ]);
    expect(checkImportFile('"name,type\nTEST A,digital\n')).toEqual({
      rows: 0,
      problems: [{ line: 1, column: null, problem: 'quote_unclosed' }],
      products: [],
    });
  });

  it('refuses a file with no product line, and one with more lines than the limit', () => {
    expect(refusal(() => checkImportFile('name,type\n\n'))).toBe('pay.product_import_empty');
    expect(refusal(() => checkImportFile('\n'))).toBe('pay.product_import_empty');
    const long = `name,type\n${Array.from({ length: PRODUCT_IMPORT_MAX_ROWS + 1 }, (_, i) => `TEST ${i},digital`).join('\n')}`;
    expect(refusal(() => checkImportFile(long))).toBe('pay.product_import_too_many_rows');
  });
});
