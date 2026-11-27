/**
 * The saved-layout contract for a free-form desk: a versioned list of panels, each with a type from an open
 * registry, its own settings and a grid position and size; named layouts per person; a default layout per desk; and
 * today's (v1) layouts read into it by one migration, tested both ways.
 */
import { describe, expect, it } from 'vitest';
import {
  DESK_GRID_COLUMNS,
  DESK_PANELS_HARD_MAX,
  defaultLayoutFor,
  deskLayoutsValueSchema,
  deskWorkspaceV2Schema,
  isKnownPanelType,
  legacyDeskOf,
  readDeskWorkspace,
  type DeskLayoutsValue,
  type DeskWorkspaceV1,
  type DeskWorkspaceV2,
} from './desk-layouts-preferences.js';

const SAVED_AT = '2026-11-27T08:00:00.000Z';

/** Ten panels tiling a 24-column grid, one of a type no screen knows yet. */
const TEN_PANELS: DeskWorkspaceV2 = {
  v: 2,
  columns: DESK_GRID_COLUMNS,
  panels: [
    {
      id: 'chart-1',
      type: 'chart',
      settings: { symbol: 'BTC/USDT', interval: '15m', studies: ['ema', 'rsi'] },
      grid: { x: 0, y: 0, w: 12, h: 16 },
    },
    { id: 'ticket', type: 'order-entry', settings: { side: 'buy', kind: 'limit' }, grid: { x: 12, y: 0, w: 6, h: 16 } },
    { id: 'book', type: 'depth', settings: { levels: 20, grouping: '0.1' }, grid: { x: 18, y: 0, w: 6, h: 8 } },
    { id: 'tape', type: 'tape', settings: {}, grid: { x: 18, y: 8, w: 6, h: 8 } },
    { id: 'positions', type: 'positions', settings: { columns: ['symbol', 'size', 'pnl'] }, grid: { x: 0, y: 16, w: 12, h: 8 } },
    { id: 'orders', type: 'orders', settings: { show: 'open' }, grid: { x: 12, y: 16, w: 12, h: 8 } },
    { id: 'watch', type: 'watchlist', settings: { list: 'majors' }, grid: { x: 0, y: 24, w: 6, h: 10 } },
    { id: 'news', type: 'news', settings: { sources: [] }, grid: { x: 6, y: 24, w: 6, h: 10 } },
    {
      id: 'chart-2',
      type: 'chart',
      settings: { symbol: 'ETH/USDT', interval: '1h', nested: { log: true, scale: null } },
      grid: { x: 12, y: 24, w: 8, h: 10 },
    },
    { id: 'heatmap', type: 'liquidity-heatmap', settings: { from: 'a later screen' }, grid: { x: 20, y: 24, w: 4, h: 10 } },
  ],
};

const V1_CLASSIC: DeskWorkspaceV1 = { v: 1, preset: 'classic', order: ['markets', 'chart', 'book'], widths: { markets: 13.5, book: 16.5 } };
const V1_ADVANCED_MOVED: DeskWorkspaceV1 = {
  v: 1,
  preset: 'advanced',
  order: ['trades', 'chart', 'markets', 'book'],
  widths: { markets: 10, book: 22.25, trades: 18 },
};

const layout = (id: string, desk: unknown, name = id) => ({ id, name, symbol: 'BTC/USDT', interval: '15m', desk, savedAt: SAVED_AT });

describe('the free-form layout contract', () => {
  it('round-trips a 10-panel layout through JSON unchanged', () => {
    const value = { layouts: [layout('ten', TEN_PANELS, 'Ten panels')], active: 'ten', deleted: [], defaults: { spot: 'ten' } };
    const parsed = deskLayoutsValueSchema.parse(JSON.parse(JSON.stringify(value)));
    expect(parsed).toEqual(value);
    expect(deskLayoutsValueSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(value);
    expect((parsed.layouts[0]!.desk as DeskWorkspaceV2).panels).toHaveLength(10);
  });

  it('keeps a panel of an unknown type, with its settings, rather than dropping it', () => {
    const parsed = deskWorkspaceV2Schema.parse(TEN_PANELS);
    const unknown = parsed.panels.find((panel) => panel.id === 'heatmap');
    expect(unknown).toEqual(TEN_PANELS.panels[9]);
    expect(isKnownPanelType('liquidity-heatmap')).toBe(false);
    expect(isKnownPanelType('chart')).toBe(true);
    expect(readDeskWorkspace(TEN_PANELS).panels.map((panel) => panel.type)).toContain('liquidity-heatmap');
  });

  it('refuses a panel outside the grid, two panels on one cell, one id twice, and a runaway panel count', () => {
    const at = (grid: { x: number; y: number; w: number; h: number }) => ({ ...TEN_PANELS, panels: [{ ...TEN_PANELS.panels[0]!, grid }] });
    expect(deskWorkspaceV2Schema.safeParse(at({ x: 20, y: 0, w: 6, h: 4 })).success).toBe(false);
    expect(deskWorkspaceV2Schema.safeParse(at({ x: 0, y: 0, w: 0, h: 4 })).success).toBe(false);
    expect(deskWorkspaceV2Schema.safeParse(at({ x: 0.5, y: 0, w: 4, h: 4 })).success).toBe(false);
    const overlap = { ...TEN_PANELS, panels: [TEN_PANELS.panels[0]!, { ...TEN_PANELS.panels[1]!, grid: { x: 11, y: 0, w: 6, h: 4 } }] };
    expect(deskWorkspaceV2Schema.safeParse(overlap).success).toBe(false);
    const twice = { ...TEN_PANELS, panels: [TEN_PANELS.panels[0]!, { ...TEN_PANELS.panels[1]!, id: 'chart-1' }] };
    expect(deskWorkspaceV2Schema.safeParse(twice).success).toBe(false);
    const many = {
      ...TEN_PANELS,
      panels: Array.from({ length: DESK_PANELS_HARD_MAX + 1 }, (_, i) => ({
        id: `p${i}`,
        type: 'news',
        settings: {},
        grid: { x: 0, y: i, w: 1, h: 1 },
      })),
    };
    expect(deskWorkspaceV2Schema.safeParse(many).success).toBe(false);
  });

  it('keeps a default layout per desk; a default naming no layout reads as none', () => {
    const value: DeskLayoutsValue = deskLayoutsValueSchema.parse({
      layouts: [layout('ten', TEN_PANELS), layout('classic', V1_CLASSIC)],
      active: null,
      deleted: [],
      defaults: { spot: 'classic', perps: 'ten', options: 'gone' },
    });
    expect(defaultLayoutFor(value, 'spot')?.id).toBe('classic');
    expect(defaultLayoutFor(value, 'perps')?.id).toBe('ten');
    expect(defaultLayoutFor(value, 'options')).toBeNull();
    expect(defaultLayoutFor(value, 'margin')).toBeNull();
  });
});

describe("today's layouts", () => {
  it('a stored v1 value parses exactly as it was stored, with no defaults added', () => {
    const stored = { layouts: [layout('classic', V1_CLASSIC), layout('moved', V1_ADVANCED_MOVED)], active: 'moved', deleted: [] };
    expect(deskLayoutsValueSchema.parse(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it('migrate to panels and back gives the same v1 desk (both presets, moved and resized)', () => {
    for (const v1 of [V1_CLASSIC, V1_ADVANCED_MOVED]) {
      const v2 = readDeskWorkspace(v1);
      expect(deskWorkspaceV2Schema.parse(v2)).toEqual(v2);
      expect(legacyDeskOf(v2)).toEqual(v1);
    }
  });

  it('the migration lays the v1 widgets out left to right in their order, chart taking the rest', () => {
    const v2 = readDeskWorkspace(V1_CLASSIC);
    expect(v2.panels.map((panel) => panel.type)).toEqual(['watchlist', 'chart', 'depth']);
    expect(v2.panels.map((panel) => panel.grid.x)).toEqual([0, v2.panels[0]!.grid.w, v2.panels[0]!.grid.w + v2.panels[1]!.grid.w]);
    expect(v2.panels.reduce((sum, panel) => sum + panel.grid.w, 0)).toBe(DESK_GRID_COLUMNS);
    expect(new Set(v2.panels.map((panel) => panel.grid.y))).toEqual(new Set([0]));
  });

  it('a v1 desk’s link groups carry over to its panels and back', () => {
    const btc = { symbol: 'BTC/USDT', venue: 'test-venue', kind: 'spot' as const };
    const linked: DeskWorkspaceV1 = {
      ...V1_CLASSIC,
      links: { members: { markets: 'red', chart: 'red', book: 'blue' }, groups: { red: btc, blue: btc } },
    };
    const v2 = readDeskWorkspace(linked);
    expect(deskWorkspaceV2Schema.parse(v2).links).toEqual({
      members: { markets: 'red', chart: 'red', book: 'blue' },
      groups: { red: btc, blue: btc },
    });
    expect(legacyDeskOf(v2)).toEqual(linked);
  });

  it('a free-form link names a panel on the desk, and its group carries a market', () => {
    const btc = { symbol: 'BTC/USDT', venue: 'test-venue', kind: 'spot' as const };
    const ok = { ...TEN_PANELS, links: { members: { 'chart-1': 'green', heatmap: 'green' }, groups: { green: btc } } };
    expect(deskWorkspaceV2Schema.parse(ok)).toEqual(ok);
    expect(deskWorkspaceV2Schema.safeParse({ ...ok, links: { members: { gone: 'green' }, groups: { green: btc } } }).success).toBe(false);
    expect(deskWorkspaceV2Schema.safeParse({ ...ok, links: { members: { 'chart-1': 'red' }, groups: { green: btc } } }).success).toBe(
      false,
    );
  });

  it('a v2 workspace already is one: read returns it as is', () => {
    expect(readDeskWorkspace(TEN_PANELS)).toBe(TEN_PANELS);
  });

  it('a free-form layout today’s desk cannot draw has no v1 form', () => {
    expect(legacyDeskOf(TEN_PANELS)).toBeNull();
    const v2 = readDeskWorkspace(V1_CLASSIC);
    const stacked = { ...v2, panels: v2.panels.map((panel, i) => (i === 2 ? { ...panel, grid: { ...panel.grid, y: 20 } } : panel)) };
    expect(legacyDeskOf(stacked)).toBeNull();
  });
});
