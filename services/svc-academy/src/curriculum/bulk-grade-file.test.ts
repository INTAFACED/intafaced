import { describe, expect, it } from 'vitest';
import { readBulkGradeFile } from './bulk-grade-file.js';

const H = 'learner,score,comment,reason';

describe('the bulk grade file (AC-assignments-02)', () => {
  it('reads quoted fields with commas, doubled quotes and line breaks, CRLF or LF, and a byte-order mark', () => {
    const text = `﻿${H}\r\nLearner 1,7.5,"Good, ""clear"" work",\r\n3, 10, "Two\nlines",\r\n`;
    expect(readBulkGradeFile(text)).toEqual({
      rows: [
        { line: 2, alias: 1, score: '7.5', comment: 'Good, "clear" work', reason: null },
        { line: 3, alias: 3, score: '10', comment: 'Two\nlines', reason: null },
      ],
      bad: [],
    });
  });

  it('lists each bad row by line and keeps the good ones', () => {
    const { rows, bad } = readBulkGradeFile(
      [H, 'Learner 0,5,,', 'Learner 2,5.123,,', 'Learner 2,abc,,', 'Learner 2,6,,', 'Learner 2,7,,', '4,5', ''].join('\n'),
    );
    expect(rows).toEqual([{ line: 5, alias: 2, score: '6', comment: null, reason: null }]);
    expect(bad.map((b) => [b.line, b.alias, b.code])).toEqual([
      [2, null, 'academy.bulk_row_invalid'],
      [3, 2, 'academy.grade_invalid'],
      [4, 2, 'academy.grade_invalid'],
      [6, 2, 'academy.bulk_row_invalid'],
      [7, 4, 'academy.bulk_row_invalid'],
    ]);
  });

  it('refuses a file with another header, no rows or an open quote', () => {
    for (const text of ['', 'learner,score\n1,5', `${H}\n`, `${H}\n1,"5,,`])
      expect(() => readBulkGradeFile(text)).toThrow(expect.objectContaining({ code: 'academy.bulk_file_invalid' }));
  });
});
