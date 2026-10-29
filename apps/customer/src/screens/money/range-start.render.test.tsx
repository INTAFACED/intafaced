// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { savePreferences } from '../../shared/preferences';
import type { LotBook } from './pnl-model';

// The asks each card makes, in order; every read stays loading, so only the range is under test.
const asks = vi.hoisted(() => ({ value: [] as unknown[], pnl: [] as unknown[] }));
vi.mock('./pnl-source', async (original) => ({
  ...(await original<typeof import('./pnl-source')>()),
  useValueOverTime: (ask: unknown) => {
    asks.value.push(ask);
    return { status: 'loading' };
  },
  usePnlOverTime: (ask: unknown) => {
    asks.pnl.push(ask);
    return { status: 'loading' };
  },
}));

import { ValueOverTimeCards } from './ValueOverTime';
import { PnlOverTimeCards } from './PnlOverTime';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
// The clock moves a second at every read, as it does between the value card's first paint and the lot book arriving.
let clock = Date.UTC(2026, 9, 24, 15, 30);
const FIRST = '2026-10-05T03:00:00.000Z';
const EMPTY_BOOK = { lots: [], sales: [] } as unknown as LotBook;
const froms = (list: unknown[]) => new Set(list.map((ask) => (ask as { from: string } | null)?.from ?? null));

beforeEach(() => {
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000));
  savePreferences({ timeZone: 'UTC', timeZoneChosen: true });
  asks.value.length = 0;
  asks.pnl.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const value = (search: string, first: string | null) =>
  act(async () => root.render(<ValueOverTimeCards search={search} first={first} picker={false} hidden={false} />));

describe('a range keeps its start while the page is open', () => {
  it('asks one 1D range for the worth line, before and after the lot book brings the first trade', async () => {
    await value('?range=1D', null);
    await value('?range=1D', FIRST);
    await value('?range=1D', null);
    expect(asks.value.length).toBeGreaterThan(1);
    expect(froms(asks.value).size).toBe(1);
  });

  it('starts All at the first trade once the lot book brings it', async () => {
    await value('?range=all', null);
    await value('?range=all', FIRST);
    expect(asks.value[0]).toBeNull();
    expect(asks.value.at(-1)).toEqual({ from: '2026-10-05T00:00:00.000Z' });
  });

  it('keeps a 1D start for profit over time when the zone changes, and sends the new zone', async () => {
    const pnl = () => act(async () => root.render(<PnlOverTimeCards book={EMPTY_BOOK} search="?range=1D" hidden={false} />));
    await pnl();
    await act(async () => savePreferences({ timeZone: 'UTC+8', timeZoneChosen: true }));
    await pnl();
    expect(froms(asks.pnl).size).toBe(1);
    expect(asks.pnl.at(-1)).toMatchObject({ utcOffsetMinutes: 480 });
  });
});
