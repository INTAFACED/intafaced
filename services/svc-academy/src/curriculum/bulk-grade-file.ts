/**
 * AC-assignments-02 — the bulk grade file, read before anything applies.
 *
 * A CSV file (RFC 4180: quoted fields may hold commas, quotes doubled, CRLF or LF line ends) with the header
 * `learner,score,comment,reason` and one row per learner by the alias graders see ("Learner 3" or "3"). A row is read
 * here as far as its own text allows: an alias that is not one, a score that is not a decimal with at most two places, or
 * an alias named twice is a bad row with its line. Whether the alias, the score against the points, the lease and an
 * override's reason hold is checked against the queue when the file applies. A header that is not this one, a broken
 * quote, or a file with no rows refuses the whole file `academy.bulk_file_invalid`. Pure: no I/O.
 */
import { ACADEMY_SCORE } from '@intafaced/contracts';
import { AcademyError } from '../errors.js';

export const BULK_GRADE_HEADER = ['learner', 'score', 'comment', 'reason'] as const;

export type BulkGradeRow = { line: number; alias: number; score: string; comment: string | null; reason: string | null };
/** A bad row's code: a refusal code, or `academy.bulk_row_invalid` for a row that does not read as one (never thrown). */
export type BulkGradeBadRow = { line: number; alias: number | null; code: string; message: string };

/** Records of a CSV text, each with the line it starts on. Throws on a quote left open. */
function records(text: string): Array<{ line: number; fields: string[] }> {
  const out: Array<{ line: number; fields: string[] }> = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  let touched = false;
  const end = () => {
    fields.push(field);
    if (touched || fields.length > 1 || field !== '') out.push({ line: start, fields });
    fields = [];
    field = '';
    touched = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    // A quote after spaces only still opens a quoted field (`Learner 1, 7, "Good, clear",`).
    if (ch === '"' && field.trim() === '') {
      field = '';
      quoted = true;
      touched = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
      touched = true;
    } else if (ch === '\r' && text[i + 1] === '\n') continue;
    else if (ch === '\n') {
      end();
      line++;
      start = line;
    } else field += ch;
  }
  if (quoted) throw new AcademyError(`a quote opened on line ${start} is never closed`, 'academy.bulk_file_invalid');
  end();
  return out;
}

const ALIAS = /^(?:learner\s+)?([1-9][0-9]{0,8})$/i;

/** The file's rows: good ones to check against the queue, bad ones with their line. */
export function readBulkGradeFile(text: string): { rows: BulkGradeRow[]; bad: BulkGradeBadRow[] } {
  const all = records(text.startsWith('﻿') ? text.slice(1) : text);
  const header = all.shift();
  const names = header?.fields.map((f) => f.trim().toLowerCase()) ?? [];
  if (names.length !== BULK_GRADE_HEADER.length || BULK_GRADE_HEADER.some((name, i) => names[i] !== name))
    throw new AcademyError(`the first line must be the header ${BULK_GRADE_HEADER.join(',')}`, 'academy.bulk_file_invalid');
  if (all.length === 0) throw new AcademyError('the file has a header and no rows', 'academy.bulk_file_invalid');
  const rows: BulkGradeRow[] = [];
  const bad: BulkGradeBadRow[] = [];
  const seen = new Set<number>();
  for (const { line, fields } of all) {
    const match = ALIAS.exec((fields[0] ?? '').trim());
    const alias = match ? Number(match[1]) : null;
    const refuse = (code: string, message: string) => bad.push({ line, alias, code, message });
    if (fields.length !== BULK_GRADE_HEADER.length) {
      refuse('academy.bulk_row_invalid', `line ${line} has ${fields.length} fields, not ${BULK_GRADE_HEADER.length}`);
      continue;
    }
    if (alias === null) {
      refuse('academy.bulk_row_invalid', `"${fields[0]!.trim().slice(0, 40)}" is not a learner alias such as "Learner 3"`);
      continue;
    }
    const score = fields[1]!.trim();
    if (!ACADEMY_SCORE.test(score)) {
      refuse('academy.grade_invalid', `"${score.slice(0, 40)}" is not a score: a number from 0 with at most two decimals`);
      continue;
    }
    const comment = fields[2]!.trim();
    const reason = fields[3]!.trim();
    if (comment.length > 5000 || reason.length > 500) {
      refuse('academy.bulk_row_invalid', 'a comment runs to 5,000 characters and a reason to 500');
      continue;
    }
    if (seen.has(alias)) {
      refuse('academy.bulk_row_invalid', `Learner ${alias} is named on an earlier line of this file`);
      continue;
    }
    seen.add(alias);
    rows.push({ line, alias, score, comment: comment || null, reason: reason || null });
  }
  return { rows, bad };
}
