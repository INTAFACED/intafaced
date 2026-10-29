import { describe, expect, it } from 'vitest';
import {
  cellOfRow,
  displayCell,
  formatBps,
  formatCell,
  formatDuration,
  inputFor,
  readData,
  rowCountText,
  tableCells,
  withNames,
} from './model';
import { DESKS, allReads } from './catalog';
import { listToCsv } from './csv';
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
  it('shows a text field in its column’s words, keeps the raw value, and refuses a value the words do not list', () => {
    const spec: ReadSpec = { ...listSpec, columns: [{ key: 'id', label: 'Id', kind: 'text', words: { a: 'The first', b: 'The second' } }] };
    const data = readData(spec, [{ id: 'a' }]);
    if (data?.shape !== 'list') throw new Error('list expected');
    const cell = tableCells(data.rows[0]!)[0]!;
    expect(cell.value).toBe('a');
    expect(displayCell(cell)).toBe('The first');
    expect(readData(spec, [{ id: 'c' }])).toBeNull();
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

describe('what the screen prints', () => {
  const cell = (kind: 'text' | 'time', value: string) => ({ key: 'k', label: 'L', kind, detail: false, value });
  it('prints a service code in words and a time in the shared UTC form, while the CSV keeps the exact value', () => {
    expect(displayCell(cell('text', 'p2p.moderation_unprobed'))).toMatch(/^Moderators are configured/);
    expect(displayCell(cell('time', '2026-10-15T10:02:03.000Z'))).toBe('15 Oct 2026, 10:02:03 UTC');
    expect(displayCell(cell('text', 'USD'))).toBe('USD');
    expect(formatCell(cell('text', 'p2p.moderation_unprobed'))).toBe('p2p.moderation_unprobed');
    expect(formatCell(cell('time', '2026-10-15T10:02:03.000Z'))).toBe('2026-10-15T10:02:03.000Z');
  });
});

describe('money totals per asset', () => {
  const spec: ReadSpec = {
    ...base,
    shape: 'record',
    columns: [{ key: 'outstandingPrincipal', label: 'Outstanding', kind: 'assetAmounts' }],
  };
  it('reads each total exactly as given and prints them together; none is none, not zero', () => {
    const data = readData(spec, {
      outstandingPrincipal: [
        { assetId: 'USDC', amount: '1000.000000000000000001' },
        { assetId: 'BTC', amount: '0.5' },
      ],
    });
    if (data?.shape !== 'record') throw new Error('record expected');
    expect(formatCell(data.cells[0]!)).toBe('1000.000000000000000001 USDC, 0.5 BTC');
    const empty = readData(spec, { outstandingPrincipal: [] });
    if (empty?.shape !== 'record') throw new Error('record expected');
    expect(formatCell(empty.cells[0]!)).toBe('none');
  });
  it('a total that is a number, or an entry missing its asset, makes the whole read unreadable', () => {
    expect(readData(spec, { outstandingPrincipal: [{ assetId: 'USDC', amount: 1000 }] })).toBeNull();
    expect(readData(spec, { outstandingPrincipal: [{ amount: '1' }] })).toBeNull();
    expect(readData(spec, { outstandingPrincipal: 'none' })).toBeNull();
  });
});

describe('a read with a time window', () => {
  const NOW = new Date('2026-10-18T01:00:00.000Z');
  const spec: ReadSpec = {
    ...base,
    shape: 'list',
    anonymousRows: true,
    windowDays: 30,
    input: { limit: 50 },
    columns: [{ key: 'a', label: 'A', kind: 'text' }],
  };
  it('asks for the last N whole days up to now, keeping the rest of its input', () => {
    expect(inputFor(spec, NOW)).toEqual({ limit: 50, from: '2026-09-18T01:00:00.000Z', to: '2026-10-18T01:00:00.000Z' });
  });
  it('a read without a window sends exactly its own input', () => {
    expect(inputFor({ ...spec, windowDays: undefined }, NOW)).toEqual({ limit: 50 });
    // A service that takes whole UTC days gets the N calendar days ending today, today included.
    expect(inputFor({ ...spec, windowDays: 3, windowInUtcDays: true }, new Date('2026-10-23T15:00:00Z'))).toEqual({
      limit: 50,
      from: '2026-10-21',
      to: '2026-10-23',
    });
    const { windowDays: _w, input: _i, ...bare } = spec;
    expect(inputFor(bare, NOW)).toBeUndefined();
    expect(inputFor({ ...bare, sendEmptyInput: true }, NOW)).toEqual({});
  });
  it('rows without an id are shown by position, and two identical rows are two rows', () => {
    const data = readData(spec, { rows: [{ a: 'x' }] });
    expect(data).toBeNull();
    const list = readData({ ...spec, rowsKey: 'rows' }, { rows: [{ a: 'x' }, { a: 'x' }] });
    if (list?.shape !== 'list') throw new Error('list expected');
    expect(list.rows.map((r) => r.id)).toEqual(['0', '1']);
  });
});

describe('a field the service promises is always null', () => {
  const spec: ReadSpec = {
    ...base,
    shape: 'record',
    columns: [{ key: 'rate', label: 'Rate', kind: 'text', nullable: true, alwaysNull: true }],
  };
  it('reads null as a dash', () => {
    const data = readData(spec, { rate: null });
    if (data?.shape !== 'record') throw new Error('record expected');
    expect(formatCell(data.cells[0]!)).toBe('—');
  });
  it('any other value, including a zero, makes the whole read unreadable instead of being printed', () => {
    for (const rate of ['0', '0.5', '', 0]) expect(readData(spec, { rate }), String(rate)).toBeNull();
    expect(readData(spec, {})).toBeNull();
  });
});

describe('durations', () => {
  it('shows whole seconds as the two largest units, from integers only', () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(303)).toBe('5 min 3 s');
    expect(formatDuration(11_520)).toBe('3 h 12 min');
    expect(formatDuration(604_000)).toBe('6 d 23 h');
    expect(formatDuration(86_400)).toBe('1 d 0 h');
  });
  it('a seconds cell reads as an integer and prints as a duration; a dash when the service gave none', () => {
    const spec: ReadSpec = { ...base, shape: 'record', columns: [{ key: 'age', label: 'Age', kind: 'seconds', nullable: true }] };
    const read = (age: unknown) => {
      const data = readData(spec, { age });
      return data?.shape === 'record' ? displayCell(data.cells[0]!) : null;
    };
    expect(read(11_520)).toBe('3 h 12 min');
    expect(read(null)).toBe('—');
    expect(read(1.5)).toBeNull();
    expect(read('90')).toBeNull();
  });
});

describe('a list whose service gives a page marker', () => {
  const spec: ReadSpec = { ...listSpec, page: 2, cursorKey: 'nextCursor', rowsKey: 'items' };
  it('knows exactly whether more rows exist: a marker means yes, and a full page with no marker means no', () => {
    expect(readData(spec, { items: [row(), row({ id: 'b' })], nextCursor: 'abc' })).toMatchObject({ pageFull: true, nextCursor: 'abc' });
    expect(readData(spec, { items: [row(), row({ id: 'b' })], nextCursor: null })).toMatchObject({ pageFull: false, nextCursor: null });
  });
  it('an answer without the marker, or with one that is not a string or null, is unreadable', () => {
    expect(readData(spec, { items: [row()] })).toBeNull();
    expect(readData(spec, { items: [row()], nextCursor: 5 })).toBeNull();
  });
  it('the count line is exact about it', () => {
    expect(rowCountText(2, true, 2, true)).toContain('more rows exist');
    expect(rowCountText(2, false, 2, true)).toBe('2 rows (that is all of them)');
    expect(rowCountText(2, true, 2)).toContain('more may exist');
  });
});

describe('pool names from the earn pools read', () => {
  const totals = allReads(DESKS.bank).find((r) => r.id === 'bank.pool-totals')!;
  const pools = allReads(DESKS.bank).find((r) => r.id === 'bank.pools')!;
  const POOL_ID = '0b5f6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
  const OTHER_ID = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';
  const total = (poolId: string) => ({
    poolId,
    assetId: 'USDT',
    amountHeld: '260.00',
    amountReason: null,
    depositorCount: 1,
    utilisationReason: 'svc-bank does not record utilisation',
  });
  const data = readData(totals, { asOf: '2026-10-18T04:00:00.000Z', pools: [total(POOL_ID), total(OTHER_ID)] });
  const named = {
    id: 'bank.pools',
    asOf: '2026-10-18T04:00:00.000Z',
    part: {
      kind: 'ok' as const,
      data: readData(pools, [
        { id: POOL_ID, assetId: 'USDT', kind: 'flexible', name: 'Flexible USDT', aprBps: 300, termDays: null, minDeposit: '1.00' },
      ])!,
    },
  };
  if (!data || data.shape !== 'list') throw new Error('fixture does not read');

  it('puts the pool name first and moves the UUID into the detail', () => {
    const out = withNames(totals, data, named);
    const first = tableCells(out.rows[0]!);
    expect(first[0]).toMatchObject({ label: 'Pool', value: 'Flexible USDT' });
    expect(first.some((c) => c.value === POOL_ID)).toBe(false);
    expect(out.rows[0]!.cells.find((c) => c.key === 'poolId')).toMatchObject({ detail: true, value: POOL_ID });
  });
  it('a pool the pools list does not name says so instead of guessing', () => {
    expect(cellOfRow(withNames(totals, data, named).rows[1]!, '_name')).toBe('Not in the earn pools list above');
  });
  it('a failed or missing pools read says no name could be read, and keeps every row', () => {
    const failed = {
      id: 'bank.pools',
      asOf: named.asOf,
      part: { kind: 'failed' as const, message: 'x', code: null, notBuilt: false, forbidden: false },
    };
    for (const source of [failed, undefined]) {
      const out = withNames(totals, data, source);
      expect(out.rows).toHaveLength(2);
      expect(cellOfRow(out.rows[0]!, '_name')).toBe('No name: the earn pools list above was not read');
    }
  });
  it('the CSV header follows the cells, so the name column lines up', () => {
    const csv = listToCsv(totals, withNames(totals, data, named));
    const [header, row] = csv.split('\r\n');
    expect(header!.split(',')[0]).toBe('Pool');
    expect(row!.split(',')[0]).toBe('Flexible USDT');
    expect(header!.split(',')).toHaveLength(row!.split(',').length);
  });
});
