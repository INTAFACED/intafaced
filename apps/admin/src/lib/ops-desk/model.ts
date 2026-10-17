import type { Cell, CellValue, Column, ReadData, ReadSpec, Row } from './types';

/**
 * Strict reader for one service answer, driven by the read's declared columns, and the pure formatting the desk uses.
 *
 * Strict means: if the answer is not the declared shape (a row that is not an object, a column of the wrong type, a
 * missing key) the WHOLE read is invalid and the desk says the service answered in a shape it does not understand.
 * It never shows a partial table, a "0" for a field it could not read, or a guess.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

/** `a.b.c` into an object. `found` is false when any step is missing, so a missing key is never read as null. */
function pick(source: Record<string, unknown>, path: string, nullThrough = false): { found: boolean; value: unknown } {
  let current: unknown = source;
  for (const part of path.split('.')) {
    // A column that says its parent object may be null reads as null there; any other missing step is "not found".
    if (current === null && nullThrough) return { found: true, value: null };
    if (!isRecord(current) || !Object.hasOwn(current, part)) return { found: false, value: undefined };
    current = current[part];
  }
  return { found: true, value: current };
}

function cellOf(column: Column, source: Record<string, unknown>): Cell | null {
  const { found, value } = pick(source, column.key, column.parentNullable === true && column.nullable === true);
  if (!found) return null;
  const make = (v: CellValue): Cell => ({
    key: column.key,
    label: column.label,
    kind: column.kind,
    detail: column.detail === true,
    value: v,
  });
  if (value === null) return column.nullable ? make(null) : null;
  if (column.mustBe !== undefined && value !== column.mustBe) return null;
  switch (column.kind) {
    case 'text':
    case 'amount':
      return typeof value === 'string' ? make(value) : null;
    case 'int':
    case 'bps':
      return typeof value === 'number' && Number.isInteger(value) ? make(value) : null;
    case 'bool':
      return typeof value === 'boolean' ? make(value) : null;
    case 'time':
      return isIso(value) ? make(value) : null;
    case 'list':
      return Array.isArray(value) && value.every((v) => typeof v === 'string') ? make([...(value as string[])]) : null;
  }
}

function cellsOf(columns: readonly Column[], source: unknown): Cell[] | null {
  if (!isRecord(source)) return null;
  const cells: Cell[] = [];
  for (const column of columns) {
    const cell = cellOf(column, source);
    if (cell === null) return null;
    cells.push(cell);
  }
  return cells;
}

export function readData(spec: ReadSpec, raw: unknown): ReadData | null {
  if (spec.shape === 'record') {
    const cells = cellsOf(spec.columns, raw);
    return cells === null ? null : { shape: 'record', cells };
  }
  const list = spec.rowsKey === undefined ? raw : isRecord(raw) ? raw[spec.rowsKey] : undefined;
  if (!Array.isArray(list)) return null;
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const [index, item] of list.entries()) {
    const cells = cellsOf(spec.columns, item);
    if (cells === null) return null;
    let id = String(index);
    if (spec.idKey !== undefined) {
      const found = isRecord(item) ? pick(item, spec.idKey) : { found: false, value: undefined };
      if (!found.found || typeof found.value !== 'string' || found.value === '') return null;
      id = found.value;
    }
    // Two rows with one id would make one of them unreachable to a per-row action. Refuse the read instead.
    if (seen.has(id)) return null;
    seen.add(id);
    rows.push({ id, cells });
  }
  return { shape: 'list', rows, pageFull: spec.page !== undefined && rows.length >= spec.page };
}

/** Whole basis points as a percent with two decimals, using integers only: 1250 is "12.50%". */
export function formatBps(bps: number): string {
  const sign = bps < 0 ? '-' : '';
  const abs = Math.abs(bps);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}%`;
}

export function formatCell(cell: Cell): string {
  const v = cell.value;
  if (v === null) return '—';
  if (cell.kind === 'bool') return v === true ? 'yes' : 'no';
  if (cell.kind === 'bps' && typeof v === 'number') return formatBps(v);
  if (cell.kind === 'list') return Array.isArray(v) ? (v.length === 0 ? 'none' : v.join(', ')) : '—';
  return String(v);
}

export function tableCells(row: Row): readonly Cell[] {
  return row.cells.filter((c) => !c.detail);
}

export function cellOfRow(row: Row, key: string): CellValue | undefined {
  return row.cells.find((c) => c.key === key)?.value;
}

/** `5 rows`, with the honest caveat when the page was full (more may exist) and the page size is known. */
export function rowCountText(rows: number, pageFull: boolean, page: number | undefined): string {
  const noun = rows === 1 ? 'row' : 'rows';
  if (pageFull && page !== undefined) return `${rows} ${noun} (the page is full at ${page}; more may exist, so this is not a total)`;
  return `${rows} ${noun}`;
}
