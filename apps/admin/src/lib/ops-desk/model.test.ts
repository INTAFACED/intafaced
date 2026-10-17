import { describe, expect, it } from 'vitest';
import { cellOfRow, formatBps, formatCell, readData, rowCountText, tableCells } from './model';
import type { ReadSpec } from './types';

const base = {
  id: 't',
  title: 't',
  note: 'n',
  module: 'bank',
  procedure: 'x',
  emptyText: 'empty',
  forbiddenText: 'no',
} as const;

const listSpec: ReadSpec = {
  ...base,
  shape: 'list',
  idKey: 'id',
  page: 2,
  columns: [
    { key: 'id', label: 'Id', kind: 'text' },
    { key: 'aprBps', label: 'APR', kind: 'bps' },
    { key: 'termDays', label: 'Term', kind: 'int', nullable: true },
    { key: 'at', label: 'At', kind: 'time', detail: true },
  ],
};
const row = (over: Record<string, unknown> = {}) => ({ id: 'a', aprBps: 1250, termDays: null, at: '2026-10-17T03:00:00.000Z', ...over });

describe('list reader', () => {
  it('reads rows with typed cells, keeps ids, and flags a full page', () => {
    const data = readData(listSpec, [row(), row({ id: 'b', termDays: 30 })]);
    expect(data).toMatchObject({ shape: 'list', pageFull: true });
    if (data?.shape !== 'list') throw new Error('list expected');
    expect(data.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(cellOfRow(data.rows[1]!, 'termDays')).toBe(30);
    expect(tableCells(data.rows[0]!).map((c) => c.key)).toEqual(['id', 'aprBps', 'termDays']);
  });
  it('a short page is not flagged full, and an empty list is empty, not unreadable', () => {
    expect(readData(listSpec, [row()])).toMatchObject({ pageFull: false });
    expect(readData(listSpec, [])).toEqual({ shape: 'list', rows: [], pageFull: false });
  });
  it('refuses the whole read when any row is the wrong shape: no partial table, no invented zero', () => {
    for (const bad of [
      row({ aprBps: '1250' }),
      row({ aprBps: 12.5 }),
      row({ termDays: undefined }),
      row({ termDays: 'x' }),
      row({ at: 'not a time' }),
      row({ id: '' }),
      null,
      'row',
    ]) {
      expect(readData(listSpec, [row(), bad])).toBeNull();
    }
    expect(readData(listSpec, { rows: [] })).toBeNull();
    expect(readData(listSpec, 'nope')).toBeNull();
  });
  it('a missing key is invalid even when the column is nullable', () => {
    const { termDays: _omit, ...without } = row();
    expect(readData(listSpec, [without])).toBeNull();
  });
  it('refuses two rows with one id, since one would be unreachable', () => {
    expect(readData(listSpec, [row(), row()])).toBeNull();
  });
  it('reads rows from a named property of an object answer', () => {
    const spec: ReadSpec = { ...listSpec, rowsKey: 'disputes' };
    expect(readData(spec, { disputes: [row()], nextCursor: null })).toMatchObject({ shape: 'list' });
    expect(readData(spec, [row()])).toBeNull();
  });
});

describe('record reader', () => {
  const spec: ReadSpec = {
    ...base,
    shape: 'record',
    columns: [
      { key: 'spine.total', label: 'Total', kind: 'int' },
      { key: 'ok', label: 'Ok', kind: 'bool' },
      { key: 'roles', label: 'Roles', kind: 'list' },
      { key: 'rail', label: 'Rail', kind: 'text', nullable: true },
    ],
  };
  it('reads dotted paths, booleans and string lists', () => {
    const data = readData(spec, { spine: { total: 40 }, ok: true, roles: ['a', 'b'], rail: null });
    expect(data).toMatchObject({ shape: 'record' });
    if (data?.shape !== 'record') throw new Error('record expected');
    expect(data.cells.map(formatCell)).toEqual(['40', 'yes', 'a, b', '—']);
  });
  it('refuses a wrong type, a non-string list item, a missing path and a non-object', () => {
    const good = { spine: { total: 40 }, ok: true, roles: [], rail: 'x' };
    expect(readData(spec, good)).not.toBeNull();
    for (const bad of [
      { ...good, ok: 'yes' },
      { ...good, roles: [1] },
      { ...good, spine: {} },
      { ...good, spine: { total: '40' } },
      [],
      null,
    ]) {
      expect(readData(spec, bad)).toBeNull();
    }
  });
});

describe('formatting', () => {
  it('shows basis points exactly, with integers only', () => {
    expect(formatBps(1250)).toBe('12.50%');
    expect(formatBps(5)).toBe('0.05%');
    expect(formatBps(0)).toBe('0.00%');
    expect(formatBps(10_000)).toBe('100.00%');
    expect(formatBps(-250)).toBe('-2.50%');
  });
  it('shows an empty list as "none" and null as a dash, never as zero', () => {
    expect(formatCell({ key: 'k', label: 'l', kind: 'list', detail: false, value: [] })).toBe('none');
    expect(formatCell({ key: 'k', label: 'l', kind: 'int', detail: false, value: null })).toBe('—');
    expect(formatCell({ key: 'k', label: 'l', kind: 'bool', detail: false, value: false })).toBe('no');
    expect(formatCell({ key: 'k', label: 'l', kind: 'amount', detail: false, value: '0.10000000' })).toBe('0.10000000');
  });
  it('says a full page is not a total', () => {
    expect(rowCountText(1, false, 50)).toBe('1 row');
    expect(rowCountText(50, true, 50)).toContain('not a total');
    expect(rowCountText(3, true, undefined)).toBe('3 rows');
  });
});
