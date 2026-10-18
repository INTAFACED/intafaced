import { formatWhen } from '@/lib/as-of';
import { formatCell } from './model';
import type { CellKind, ReadData, ReadSpec } from './types';

/**
 * CSV for the rows a desk list is SHOWING, built in the browser from what the console already read.
 *
 * Nothing is fetched again and nothing is added: the file holds the rows on screen, in the order shown, so it can
 * never disagree with the page. When the read was capped at its page size the file is just as capped, and the page and
 * the filename say "rows shown" so nobody takes it for the whole table.
 *
 * Cells are text a service returned, and a spreadsheet will run a cell that starts with = + - @ (or a tab or carriage
 * return) as a formula. Every such cell gets a single quote in front so it opens as text. The one exception is a
 * number the console itself formatted (a negative amount like -5.00), which cannot run anything and should stay a number.
 */

const FORMULA_START = /^[=+\-@\t\r]/;
/** Only a leading minus and plain digits: no letters, brackets or operators, so a spreadsheet reads a number and nothing else. */
const PLAIN_NEGATIVE_NUMBER = /^-\d+(\.\d+)?%?$/;
const NUMERIC_KINDS: readonly CellKind[] = ['int', 'amount', 'bps'];

/** One cell as safe CSV text: formula-guarded, then quoted when it holds a comma, quote, line break or edge spaces. */
export function csvField(text: string, kind: CellKind = 'text'): string {
  const plainNumber = NUMERIC_KINDS.includes(kind) && PLAIN_NEGATIVE_NUMBER.test(text);
  const guarded = FORMULA_START.test(text) && !plainNumber ? `'${text}` : text;
  return /[",\r\n]/.test(guarded) || guarded !== guarded.trim() ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export const CSV_NEWLINE = '\r\n';

/** The header row, then one line per row shown. A cell the service sent as null is left empty, not "—". */
export function listToCsv(spec: ReadSpec, data: Extract<ReadData, { shape: 'list' }>): string {
  // The rows' own cells, so a column the desk adds (a name from another read, see withNames) keeps its header.
  const labels = data.rows[0]?.cells.map((c) => c.label) ?? spec.columns.map((c) => c.label);
  const header = labels.map((label) => csvField(label)).join(',');
  const lines = data.rows.map((row) =>
    row.cells.map((cell) => (cell.value === null ? '' : csvField(formatCell(cell), cell.kind))).join(','),
  );
  return [header, ...lines].join(CSV_NEWLINE) + CSV_NEWLINE;
}

function stamp(asOf: string): string {
  const ms = Date.parse(asOf);
  if (!Number.isFinite(ms)) return 'time-unknown';
  return `${new Date(ms).toISOString().slice(0, 19).replace(/:/g, '-')}Z`;
}

/** `academy-ambassadors_rows-shown_as-of_2026-10-17T03-00-00Z.csv`: what it is, that it is the rows shown, and when it was read. */
export function csvFilename(readId: string, asOf: string): string {
  const slug =
    readId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'desk';
  return `${slug}_rows-shown_as-of_${stamp(asOf)}.csv`;
}

/** What the page says next to the button, so the file is never mistaken for the whole table. */
export function exportNote(rows: number, pageFull: boolean, page: number | undefined, asOf: string, exact = false): string {
  const noun = rows === 1 ? 'row' : 'rows';
  const base = `Exports the ${rows} ${noun} shown above (not a full table export), as read at ${formatWhen(asOf)}.`;
  if (exact) return pageFull ? `${base} More rows exist that are not in the file until “Next 50” has read them.` : base;
  return pageFull && page !== undefined
    ? `${base} This read is capped at ${page} rows and the page is full, so more rows may exist that are not in the file.`
    : base;
}
