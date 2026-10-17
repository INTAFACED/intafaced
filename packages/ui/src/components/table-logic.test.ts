import { describe, expect, it, vi } from 'vitest';
import { sizes } from '../theme/tokens.js';
import {
  allSelectedState,
  ariaSortOf,
  compareDecimal,
  compareValues,
  HEAD_PX,
  nextSort,
  PAGE_STEP,
  ROW_PX,
  rowKeyAction,
  sortRows,
  toggleAll,
  toggleSelection,
  type SortableColumn,
} from './table-logic.js';

describe('compareDecimal is exact', () => {
  it('orders 0.1 and 0.2 and ties 0.10 with 0.1', () => {
    expect(compareDecimal('0.1', '0.2')).toBe(-1);
    expect(compareDecimal('0.2', '0.1')).toBe(1);
    expect(compareDecimal('0.10', '0.1')).toBe(0);
  });

  it('tells apart 18-decimal values a float would merge', () => {
    // As JavaScript numbers these two are the same value; as decimals they are one unit in the 18th place apart.
    expect(compareDecimal('1.000000000000000001', '1.000000000000000002')).toBe(-1);
    expect(compareDecimal('1.000000000000000001', '1')).toBe(1);
    expect(compareDecimal('0.000000000000000001', '0')).toBe(1);
  });

  it('handles values past 2^53 and negatives', () => {
    expect(compareDecimal('9007199254740993', '9007199254740992')).toBe(1);
    expect(compareDecimal('123456789012345678901234567890.5', '123456789012345678901234567890.4')).toBe(1);
    expect(compareDecimal('-1.5', '-1.25')).toBe(-1);
    expect(compareDecimal('-0.0', '0')).toBe(0);
    expect(compareDecimal('-2', '1')).toBe(-1);
  });

  it('refuses text that is not a plain decimal', () => {
    expect(() => compareDecimal('1e5', '2')).toThrow();
    expect(() => compareDecimal('', '2')).toThrow();
  });
});

describe('compareValues', () => {
  it('sends null, empty and unparseable money to the end', () => {
    expect(compareValues(null, '1', 'decimal')).toEqual({ order: 1, missing: true });
    expect(compareValues('1', null, 'decimal')).toEqual({ order: -1, missing: true });
    expect(compareValues('', '1', 'decimal').missing).toBe(true);
    expect(compareValues('abc', '1', 'decimal').missing).toBe(true);
    expect(compareValues(null, null, 'decimal')).toEqual({ order: 0, missing: true });
  });

  it('sorts text naturally, numbers inside text by value', () => {
    expect(compareValues('BTC-2', 'BTC-10', 'text').order).toBeLessThan(0);
    expect(compareValues('apple', 'Banana', 'text').order).toBeLessThan(0);
  });
});

interface Row {
  id: string;
  name: string;
  amount: string | null;
}
const columns: SortableColumn<Row>[] = [
  { id: 'name', sortValue: (r) => r.name },
  { id: 'amount', sortType: 'decimal', sortValue: (r) => r.amount },
  { id: 'none' },
  { id: 'shown', sortType: 'decimal', value: (r) => r.amount },
];
const rows: Row[] = [
  { id: 'a', name: 'b', amount: '0.2' },
  { id: 'b', name: 'a', amount: '0.1' },
  { id: 'c', name: 'c', amount: null },
  { id: 'd', name: 'd', amount: '0.3' },
  { id: 'e', name: 'e', amount: '0.10' },
];
const ids = (list: readonly Row[]) => list.map((r) => r.id).join('');

describe('sortRows', () => {
  it('sorts money ascending and descending with unknown always last, ties keep their order', () => {
    expect(ids(sortRows(rows, columns, { columnId: 'amount', direction: 'asc' }))).toBe('beadc');
    expect(ids(sortRows(rows, columns, { columnId: 'amount', direction: 'desc' }))).toBe('dabec');
  });

  it('falls back to the cell value when a column has no sortValue', () => {
    expect(ids(sortRows(rows, columns, { columnId: 'shown', direction: 'asc' }))).toBe('beadc');
  });

  it('sorts text and returns a copy', () => {
    const out = sortRows(rows, columns, { columnId: 'name', direction: 'asc' });
    expect(ids(out)).toBe('bacde');
    expect(out).not.toBe(rows);
  });

  it('does nothing without a sort, an unknown column or a column with no sortValue', () => {
    expect(ids(sortRows(rows, columns, null))).toBe('abcde');
    expect(ids(sortRows(rows, columns, { columnId: 'missing', direction: 'asc' }))).toBe('abcde');
    expect(ids(sortRows(rows, columns, { columnId: 'none', direction: 'asc' }))).toBe('abcde');
  });

  it('keeps 18-decimal neighbours in the right order', () => {
    const fine: Row[] = [
      { id: 'x', name: 'x', amount: '1.000000000000000002' },
      { id: 'y', name: 'y', amount: '1.000000000000000001' },
    ];
    expect(ids(sortRows(fine, columns, { columnId: 'amount', direction: 'asc' }))).toBe('yx');
  });
});

describe('header sort state', () => {
  it('starts figures largest first and text A to Z, then flips', () => {
    expect(nextSort(null, 'amount', 'decimal')).toEqual({ columnId: 'amount', direction: 'desc' });
    expect(nextSort(null, 'name', 'text')).toEqual({ columnId: 'name', direction: 'asc' });
    expect(nextSort({ columnId: 'amount', direction: 'desc' }, 'amount', 'decimal')).toEqual({ columnId: 'amount', direction: 'asc' });
    expect(nextSort({ columnId: 'name', direction: 'asc' }, 'amount', 'decimal')).toEqual({ columnId: 'amount', direction: 'desc' });
  });

  it('maps to aria-sort', () => {
    expect(ariaSortOf(null, 'a')).toBe('none');
    expect(ariaSortOf({ columnId: 'a', direction: 'asc' }, 'a')).toBe('ascending');
    expect(ariaSortOf({ columnId: 'a', direction: 'desc' }, 'a')).toBe('descending');
    expect(ariaSortOf({ columnId: 'a', direction: 'desc' }, 'b')).toBe('none');
  });
});

describe('selection', () => {
  it('single replaces, and clicking the only selected row clears it', () => {
    expect([...toggleSelection(new Set(['a']), 'b', 'single')]).toEqual(['b']);
    expect([...toggleSelection(new Set(['a']), 'a', 'single')]).toEqual([]);
  });

  it('multiple adds and removes without touching the input set', () => {
    const start = new Set(['a']);
    expect([...toggleSelection(start, 'b', 'multiple')].sort()).toEqual(['a', 'b']);
    expect([...toggleSelection(new Set(['a', 'b']), 'a', 'multiple')]).toEqual(['b']);
    expect([...start]).toEqual(['a']);
  });

  it('reports all, some and none for the header box, and toggles all', () => {
    expect(allSelectedState(new Set(), ['a', 'b'])).toBe('none');
    expect(allSelectedState(new Set(['a']), ['a', 'b'])).toBe('some');
    expect(allSelectedState(new Set(['a', 'b']), ['a', 'b'])).toBe('all');
    expect(allSelectedState(new Set(['a']), [])).toBe('none');
    expect([...toggleAll(new Set(['a']), ['a', 'b'])].sort()).toEqual(['a', 'b']);
    expect([...toggleAll(new Set(['a', 'b', 'z']), ['a', 'b'])]).toEqual(['z']);
  });
});

describe('rowKeyAction', () => {
  it('moves one row, clamps at the ends', () => {
    expect(rowKeyAction('ArrowDown', 0, 3)).toBe(1);
    expect(rowKeyAction('ArrowDown', 2, 3)).toBe(2);
    expect(rowKeyAction('ArrowUp', 0, 3)).toBe(0);
    expect(rowKeyAction('ArrowUp', 2, 3)).toBe(1);
  });

  it('jumps with Home, End, PageUp and PageDown', () => {
    expect(rowKeyAction('Home', 5, 20)).toBe(0);
    expect(rowKeyAction('End', 5, 20)).toBe(19);
    expect(rowKeyAction('PageDown', 5, 100)).toBe(5 + PAGE_STEP);
    expect(rowKeyAction('PageUp', 5, 100)).toBe(0);
  });

  it('Enter opens, Space selects, other keys and empty tables are not ours', () => {
    expect(rowKeyAction('Enter', 0, 3)).toBe('activate');
    expect(rowKeyAction(' ', 0, 3)).toBe('toggle');
    expect(rowKeyAction('a', 0, 3)).toBeNull();
    expect(rowKeyAction('ArrowDown', 0, 0)).toBeNull();
  });
});

describe('row heights match the tokens', () => {
  it('keeps the virtualiser pixel heights equal to the --if-table-* sizes', () => {
    expect(`${ROW_PX.comfortable}px`).toBe(sizes['table-row-h']);
    expect(`${ROW_PX.dense}px`).toBe(sizes['table-row-h-dense']);
    expect(`${HEAD_PX.comfortable}px`).toBe(sizes['table-head-h']);
    expect(`${HEAD_PX.dense}px`).toBe(sizes['table-head-h-dense']);
  });
});

describe('formatted money in a decimal column is reported, not silently buried', () => {
  it('says so once per column when a value is not a plain decimal', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const formatted: Row[] = [
      { id: 'a', name: 'a', amount: '1,000.00' },
      { id: 'b', name: 'b', amount: '5.00' },
    ];
    const cols: SortableColumn<Row>[] = [{ id: 'formatted-demo', sortType: 'decimal', value: (r) => r.amount }];
    sortRows(formatted, cols, { columnId: 'formatted-demo', direction: 'desc' });
    sortRows(formatted, cols, { columnId: 'formatted-demo', direction: 'asc' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toContain('formatted-demo');
    spy.mockRestore();
  });

  it('stays quiet for plain decimals and unknowns', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sortRows(rows, [{ id: 'quiet-demo', sortType: 'decimal', value: (r) => r.amount }], { columnId: 'quiet-demo', direction: 'asc' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
