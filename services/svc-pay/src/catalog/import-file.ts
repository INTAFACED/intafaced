import {
  PRODUCT_IMPORT_COLUMNS,
  PRODUCT_IMPORT_MAX_ROWS,
  PRODUCT_TYPES,
  productCreateInputSchema,
  productEventSchema,
  productKeySchema,
  type ProductCreateInput,
  type ProductImportColumn,
  type ProductImportProblem,
} from '@intafaced/contracts';
import { z } from 'zod';
import { MerchantOpsError } from '../merchant-ops/errors.js';

/**
 * Reading and checking a file of products (J-merchant-03 step 5). Pure: nothing here reads or writes the catalogue,
 * so the one check that needs it (a chosen id already taken) is in `import.ts`.
 */

export type ImportedProduct = Omit<ProductCreateInput, 'requestId'>;

export interface CheckedFile {
  /** Product lines in the file (blank lines are not counted). */
  rows: number;
  /** Every problem the file has on its own, in line and column order. */
  problems: ProductImportProblem[];
  /** The products of the lines without a problem, in file order. */
  products: Array<{ line: number; input: ImportedProduct }>;
}

interface CsvRecord {
  line: number;
  cells: string[];
}

/**
 * RFC 4180 CSV: comma-separated cells, a cell in double quotes may hold commas, line breaks and `""` for a quote. Lines
 * end in CRLF, LF or CR. A record's line is the file line it starts on. A byte order mark before the header is dropped.
 */
export function parseCsv(text: string): { records: CsvRecord[]; unclosedAt: number | null } {
  const records: CsvRecord[] = [];
  let line = 1;
  let start = 1;
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRecord = () => {
    cells.push(cell);
    records.push({ line: start, cells });
    cells = [];
    cell = '';
  };
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      start = line;
    } else cell += ch;
  }
  if (quoted) return { records, unclosedAt: start };
  if (cell !== '' || cells.length > 0) endRecord();
  return { records, unclosedAt: null };
}

// Each cell is checked with the schema products.create checks the same field with, so the two never drift apart.
const FIELD = productCreateInputSchema.shape;
const SCHEMAS: Record<Exclude<ProductImportColumn, 'type'>, z.ZodType> = {
  name: FIELD.name,
  product_id: productKeySchema,
  unit_label: FIELD.unitLabel.unwrap(),
  statement_descriptor: FIELD.statementDescriptor.unwrap(),
  event_starts_at: productEventSchema.shape.startsAt,
  event_location: productEventSchema.shape.location,
};

/**
 * Check a whole file. An empty file, or one with no product line, is refused (`pay.product_import_empty`), and so is one
 * with more than `PRODUCT_IMPORT_MAX_ROWS` product lines (`pay.product_import_too_many_rows`); anything else is
 * answered line by line.
 */
export function checkImportFile(text: string): CheckedFile {
  const { records, unclosedAt } = parseCsv(text);
  const problems: ProductImportProblem[] = [];
  const header = records[0];
  // A quote opened in the header and never closed swallows the whole file: that is the problem to name.
  if (!header && unclosedAt !== null)
    return { rows: 0, problems: [{ line: unclosedAt, column: null, problem: 'quote_unclosed' }], products: [] };
  if (!header) throw new MerchantOpsError('pay.product_import_empty', 'bad_request');
  const body = records.slice(1).filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (body.length === 0 && unclosedAt === null) throw new MerchantOpsError('pay.product_import_empty', 'bad_request');
  if (body.length > PRODUCT_IMPORT_MAX_ROWS) throw new MerchantOpsError('pay.product_import_too_many_rows', 'bad_request');

  const at = new Map<ProductImportColumn, number>();
  header.cells.forEach((raw, index) => {
    const name = raw.trim().toLowerCase();
    const known = (PRODUCT_IMPORT_COLUMNS as readonly string[]).includes(name);
    if (!known) problems.push({ line: header.line, column: raw.trim() || null, problem: 'column_unknown' });
    else if (at.has(name as ProductImportColumn)) problems.push({ line: header.line, column: name, problem: 'column_repeated' });
    else at.set(name as ProductImportColumn, index);
  });
  for (const required of ['name', 'type'] as const)
    if (!at.has(required)) problems.push({ line: header.line, column: required, problem: 'column_missing' });

  const products: CheckedFile['products'] = [];
  const firstLineOfKey = new Map<string, number>();
  for (const record of body) {
    if (record.cells.length !== header.cells.length) {
      problems.push({ line: record.line, column: null, problem: 'row_width' });
      continue;
    }
    const own: ProductImportProblem[] = [];
    const flag = (column: ProductImportColumn, problem: ProductImportProblem['problem']) =>
      own.push({ line: record.line, column, problem });
    const cell = (column: ProductImportColumn) => {
      const index = at.get(column);
      const v = index === undefined ? '' : record.cells[index]!.trim();
      return v === '' ? undefined : v;
    };
    /** The cell's value as its schema reads it; undefined when blank or when the schema refuses it (flagged). */
    const value = (column: Exclude<ProductImportColumn, 'type'>): string | undefined => {
      const v = cell(column);
      if (v === undefined) return undefined;
      const read = SCHEMAS[column].safeParse(v);
      if (read.success) return read.data as string;
      flag(column, read.error.issues.some((i) => i.code === 'too_big') ? 'value_too_long' : 'value_invalid');
      return undefined;
    };

    const name = value('name');
    if (at.has('name') && cell('name') === undefined) flag('name', 'value_required');
    const typeText = cell('type')?.toLowerCase();
    const type = PRODUCT_TYPES.find((t) => t === typeText);
    if (at.has('type') && typeText === undefined) flag('type', 'value_required');
    else if (typeText !== undefined && !type) flag('type', 'value_invalid');

    const key = value('product_id');
    if (key !== undefined) {
      if (firstLineOfKey.has(key)) flag('product_id', 'id_repeated');
      else firstLineOfKey.set(key, record.line);
    }
    const unitLabel = value('unit_label');
    const descriptor = value('statement_descriptor');
    const startsAt = value('event_starts_at');
    const location = value('event_location');
    if (type === 'event') {
      if (cell('event_starts_at') === undefined) flag('event_starts_at', 'event_details_required');
      if (cell('event_location') === undefined) flag('event_location', 'event_details_required');
    } else if (type) {
      if (cell('event_starts_at') !== undefined) flag('event_starts_at', 'event_details_not_event');
      if (cell('event_location') !== undefined) flag('event_location', 'event_details_not_event');
    }

    if (own.length) {
      problems.push(...own);
      continue;
    }
    if (name === undefined || !type) continue; // the header lacks the column, which is its own problem
    products.push({
      line: record.line,
      input: {
        name,
        type,
        ...(key !== undefined ? { productKey: key } : {}),
        ...(unitLabel !== undefined ? { unitLabel } : {}),
        ...(descriptor !== undefined ? { statementDescriptor: descriptor } : {}),
        ...(type === 'event' ? { event: { startsAt: startsAt!, location: location! } } : {}),
      },
    });
  }
  if (unclosedAt !== null) problems.push({ line: unclosedAt, column: null, problem: 'quote_unclosed' });
  return { rows: body.length + (unclosedAt === null ? 0 : 1), problems: sortProblems(problems), products };
}

const columnOrder = (column: string | null) => {
  const index = (PRODUCT_IMPORT_COLUMNS as readonly string[]).indexOf(column ?? '');
  return index < 0 ? -1 : index;
};

export const sortProblems = (problems: ProductImportProblem[]) =>
  [...problems].sort((a, b) => a.line - b.line || columnOrder(a.column) - columnOrder(b.column));
