/**
 * Pure logic behind Table: sorting (money-safe), selection and keyboard row navigation.
 * No React here, so every rule can be unit-tested without a DOM.
 *
 * Money is a decimal STRING. Sorting a money column compares scaled bigints, never floats, so
 * "0.1" and "0.10" tie and an 18-decimal value is never rounded into its neighbour.
 */
import type { Density } from './density.js';

export type SortDirection = 'asc' | 'desc';
export interface SortState {
  columnId: string;
  direction: SortDirection;
}

/** How a sortable column compares its values. `decimal` is for money and quantities. */
export type SortType = 'text' | 'decimal';

/** Row heights in px that the virtualiser needs. tokens.test-style check in table.test.tsx keeps these equal to the --if-table-row-h tokens. */
export const ROW_PX: Record<Density, number> = { dense: 32, comfortable: 44 };
export const HEAD_PX: Record<Density, number> = { dense: 28, comfortable: 39 };

interface ParsedDecimal {
  negative: boolean;
  int: string;
  frac: string;
}

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/;

function parseDecimal(value: string): ParsedDecimal | null {
  const m = DECIMAL.exec(value.trim());
  if (!m) return null;
  return { negative: m[1] === '-', int: m[2] ?? '0', frac: m[3] ?? '' };
}

/**
 * Compares two decimal strings exactly. Returns a negative, zero or positive integer.
 * Both must be plain decimals ("-12.50", "0.000000000000000001"); anything else is the caller's job
 * to filter out first (see compareValues, which sends unparseable text to the end).
 */
export function compareDecimal(a: string, b: string): number {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  if (!pa || !pb) throw new Error('compareDecimal needs plain decimal strings');
  const scale = Math.max(pa.frac.length, pb.frac.length);
  const toBig = (p: ParsedDecimal): bigint => {
    const n = BigInt(`${p.int}${p.frac.padEnd(scale, '0')}`);
    return p.negative ? -n : n;
  };
  const x = toBig(pa);
  const y = toBig(pb);
  return x < y ? -1 : x > y ? 1 : 0;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Compares two cell values for sorting. `null`, empty and unparseable money always sort LAST,
 * whichever direction is asked for: an unknown value is never "the smallest" and never "zero".
 * Returns the comparison for ascending order plus whether either side was missing, so the caller
 * can keep missing values at the end for descending order too.
 */
export function compareValues(a: string | null, b: string | null, type: SortType): { order: number; missing: boolean } {
  const aMissing = a == null || a === '' || (type === 'decimal' && parseDecimal(a) === null);
  const bMissing = b == null || b === '' || (type === 'decimal' && parseDecimal(b) === null);
  if (aMissing || bMissing) {
    return { order: aMissing && bMissing ? 0 : aMissing ? 1 : -1, missing: true };
  }
  return { order: type === 'decimal' ? compareDecimal(a, b) : collator.compare(a, b), missing: false };
}

export interface SortableColumn<Row> {
  id: string;
  sortType?: SortType;
  /** The value to sort by. Defaults to `value`, the text the cell shows. */
  sortValue?: (row: Row) => string | null;
  value?: (row: Row) => string | null;
}

const warned = new Set<string>();

/**
 * A decimal column whose text is not a plain decimal ("1,000.00", "$12", "+1.5%") would be sorted to the end as if
 * unknown, which looks like a sort bug and hides real values. Say so once per column. The fix is on the screen:
 * give the column a plain-decimal `value` or `sortValue` and put the formatting in `cell`.
 */
function warnUnparseable<Row>(rows: readonly Row[], read: (row: Row) => string | null, columnId: string): void {
  if (warned.has(columnId)) return;
  for (const row of rows) {
    const v = read(row);
    if (v != null && v !== '' && parseDecimal(v) === null) {
      warned.add(columnId);
      console.error(
        `Table column "${columnId}" is a decimal column but "${v}" is not a plain decimal, so it sorts as unknown. Use sortValue with a plain decimal string and format in cell.`,
      );
      return;
    }
  }
}

/** Returns a new array sorted by the active column. Stable. Missing values stay at the end in both directions. */
export function sortRows<Row>(rows: readonly Row[], columns: readonly SortableColumn<Row>[], sort: SortState | null): Row[] {
  if (!sort) return [...rows];
  const column = columns.find((c) => c.id === sort.columnId);
  const read = column?.sortValue ?? column?.value;
  if (!column || !read) return [...rows];
  const type = column.sortType ?? 'text';
  const sign = sort.direction === 'asc' ? 1 : -1;
  if (type === 'decimal') warnUnparseable(rows, read, column.id);
  return rows
    .map((row, index) => ({ row, index, value: read(row) }))
    .sort((x, y) => {
      const { order, missing } = compareValues(x.value, y.value, type);
      if (order !== 0) return missing ? order : order * sign;
      return x.index - y.index;
    })
    .map((entry) => entry.row);
}

/**
 * What a click on a sortable header does. A new column starts in its natural direction
 * (money and figures: largest first; text: A to Z). Clicking the active column flips it.
 */
export function nextSort(current: SortState | null, columnId: string, type: SortType = 'text'): SortState {
  if (current && current.columnId === columnId) {
    return { columnId, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { columnId, direction: type === 'decimal' ? 'desc' : 'asc' };
}

export function ariaSortOf(sort: SortState | null, columnId: string): 'ascending' | 'descending' | 'none' {
  if (!sort || sort.columnId !== columnId) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

/** Toggle one id in a selection. `single` replaces the selection; `multiple` adds or removes. */
export function toggleSelection(selected: ReadonlySet<string>, id: string, mode: 'single' | 'multiple'): Set<string> {
  if (mode === 'single') return selected.has(id) && selected.size === 1 ? new Set() : new Set([id]);
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** State of the header "select all" box for the rows currently loaded. */
export function allSelectedState(selected: ReadonlySet<string>, ids: readonly string[]): 'all' | 'some' | 'none' {
  if (ids.length === 0) return 'none';
  let count = 0;
  for (const id of ids) if (selected.has(id)) count += 1;
  return count === 0 ? 'none' : count === ids.length ? 'all' : 'some';
}

export function toggleAll(selected: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  return allSelectedState(selected, ids) === 'all'
    ? new Set([...selected].filter((id) => !ids.includes(id)))
    : new Set([...selected, ...ids]);
}

/** Rows moved by PageUp and PageDown. */
export const PAGE_STEP = 10;

/**
 * Keyboard model for a focused row. Returns the index to focus, `'activate'` for Enter (open the row),
 * `'toggle'` for Space (select or unselect it), or null when the key is not ours.
 * Home and End jump to the first and last row.
 */
export function rowKeyAction(key: string, index: number, count: number): number | 'activate' | 'toggle' | null {
  if (count <= 0) return null;
  const clamp = (n: number) => Math.min(count - 1, Math.max(0, n));
  switch (key) {
    case 'ArrowDown':
      return clamp(index + 1);
    case 'ArrowUp':
      return clamp(index - 1);
    case 'PageDown':
      return clamp(index + PAGE_STEP);
    case 'PageUp':
      return clamp(index - PAGE_STEP);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'Enter':
      return 'activate';
    case ' ':
      return 'toggle';
    default:
      return null;
  }
}
