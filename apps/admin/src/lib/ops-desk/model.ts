import type { Cell, CellValue, Column, ReadData, ReadOutcome, ReadSpec, Row } from './types';
import { formatWhen } from '@/lib/as-of';
import { codeWords } from '@/lib/desk/words';

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
  if (column.alwaysNull === true && value !== null) return null;
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
      if (typeof value !== 'string') return null;
      if (!column.words) return make(value);
      return Object.hasOwn(column.words, value) ? { ...make(value), words: column.words[value]! } : null;
    case 'amount':
      return typeof value === 'string' ? make(value) : null;
    case 'int':
    case 'bps':
    case 'seconds':
      return typeof value === 'number' && Number.isInteger(value) ? make(value) : null;
    case 'bool':
      return typeof value === 'boolean' ? make(value) : null;
    case 'time':
      return isIso(value) ? make(value) : null;
    case 'list':
      return Array.isArray(value) && value.every((v) => typeof v === 'string') ? make([...(value as string[])]) : null;
    case 'assetAmounts': {
      if (!Array.isArray(value)) return null;
      const parts: string[] = [];
      for (const item of value) {
        if (!isRecord(item) || typeof item.assetId !== 'string' || typeof item.amount !== 'string') return null;
        parts.push(`${item.amount} ${item.assetId}`);
      }
      return make(parts);
    }
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

const DAY_MS = 86_400_000;

/**
 * What goes to the service for a read. A read with `windowDays` gets `from` and `to` (ISO instants): the last N whole days up
 * to `now`. Nothing else is added, so a window is always one the founder can read off the read's title.
 */
export function inputFor(spec: ReadSpec, now: Date): Readonly<Record<string, unknown>> | undefined {
  if (spec.windowDays === undefined) return spec.input ?? (spec.sendEmptyInput === true ? {} : undefined);
  if (spec.windowInUtcDays) {
    const day = (t: number) => new Date(t).toISOString().slice(0, 10);
    return { ...spec.input, from: day(now.getTime() - (spec.windowDays - 1) * DAY_MS), to: day(now.getTime()) };
  }
  return { ...spec.input, from: new Date(now.getTime() - spec.windowDays * DAY_MS).toISOString(), to: now.toISOString() };
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
  if (spec.cursorKey !== undefined) {
    // The service's own page marker: a string when more rows exist, null on the last page. Anything else is an unreadable answer.
    const marker = isRecord(raw) && Object.hasOwn(raw, spec.cursorKey) ? raw[spec.cursorKey] : undefined;
    if (marker !== null && typeof marker !== 'string') return null;
    return { shape: 'list', rows, pageFull: marker !== null, nextCursor: marker };
  }
  return { shape: 'list', rows, pageFull: spec.page !== undefined && rows.length >= spec.page };
}

/**
 * A whole number of seconds as the two largest units, from integers only: 11520 is "3 h 12 min", 604000 is "6 d 23 h", 45 is "45 s".
 * Display only; the service's number is unchanged in the record.
 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.trunc(seconds));
  const d = Math.trunc(s / 86_400);
  const h = Math.trunc((s % 86_400) / 3_600);
  const m = Math.trunc((s % 3_600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${s % 60} s`;
  return `${s} s`;
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
  if (cell.kind === 'seconds' && typeof v === 'number') return formatDuration(v);
  if (cell.kind === 'list' || cell.kind === 'assetAmounts') return Array.isArray(v) ? (v.length === 0 ? 'none' : v.join(', ')) : '—';
  return String(v);
}

/** What the screen prints for a cell: formatCell, with a time in the shared UTC form and a service code in words. The CSV export keeps formatCell's exact values. */
export function displayCell(cell: Cell): string {
  if (cell.kind === 'time' && typeof cell.value === 'string') return formatWhen(cell.value);
  if (cell.kind === 'text' && cell.words !== undefined) return cell.words;
  if (cell.kind === 'text' && typeof cell.value === 'string') return codeWords(cell.value);
  return formatCell(cell);
}

/**
 * Puts a name in front of each row of a list that only has ids, from the desk's own read that lists the same things by name
 * (`ReadSpec.namesFrom`). The id cell moves to the detail. When the naming read failed, was not read, or does not list a row's id,
 * that row's name cell says why in words. Never invents a name and never drops a row.
 */
export function withNames(spec: ReadSpec, data: Extract<ReadData, { shape: 'list' }>, source: ReadOutcome | undefined): typeof data {
  const by = spec.namesFrom;
  if (!by) return data;
  const names = new Map<string, string>();
  const sourceData = source?.part.kind === 'ok' ? source.part.data : null;
  if (sourceData?.shape === 'list') {
    for (const r of sourceData.rows) {
      const id = cellOfRow(r, by.idKey);
      const name = cellOfRow(r, by.nameKey);
      if (typeof id === 'string' && typeof name === 'string' && name.trim() !== '') names.set(id, name);
    }
  }
  const unread = sourceData?.shape !== 'list';
  return {
    ...data,
    rows: data.rows.map((row) => {
      const name = names.get(row.id);
      const nameCell: Cell = {
        key: '_name',
        label: by.label,
        kind: 'text',
        detail: false,
        value: name ?? (unread ? `No name: ${by.missing} was not read` : `Not in ${by.missing}`),
      };
      const cells = row.cells.map((c) => (c.key === spec.idKey ? { ...c, detail: true } : c));
      return { ...row, cells: [nameCell, ...cells] };
    }),
  };
}

export function tableCells(row: Row): readonly Cell[] {
  return row.cells.filter((c) => !c.detail);
}

export function cellOfRow(row: Row, key: string): CellValue | undefined {
  return row.cells.find((c) => c.key === key)?.value;
}

/**
 * `5 rows`, with the honest caveat when the page was full (more may exist) and the page size is known. `exact` is for a list whose
 * service gives a page marker: then a full page means more rows DO exist, and exactly 50 rows with no marker means there are no more.
 */
export function rowCountText(rows: number, pageFull: boolean, page: number | undefined, exact = false): string {
  const noun = rows === 1 ? 'row' : 'rows';
  if (exact) {
    return pageFull
      ? `${rows} ${noun} so far (more rows exist; “Next ${page ?? 'page'}” reads them)`
      : `${rows} ${noun} (that is all of them)`;
  }
  if (pageFull && page !== undefined) return `${rows} ${noun} (the page is full at ${page}; more may exist, so this is not a total)`;
  return `${rows} ${noun}`;
}
