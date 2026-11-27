import { describe, expect, it } from 'vitest';
import type { DeskWorkspaceV2 } from '@intafaced/contracts/desk-layouts-preferences';
import {
  checkDeskLayoutGrowth,
  DESK_LAYOUT_CAP_EXCEEDED,
  DESK_LAYOUT_CAP_UNSET,
  DESK_LAYOUT_RESTORE_EXPIRED,
  DESK_LAYOUT_RESTORE_FULL,
  DESK_LAYOUT_RESTORE_UNSET,
  NO_DESK_LAYOUT_LIMITS,
  parseDeskLayoutsShape,
  type DeskLayoutsValue,
} from './desk-layouts.js';

const desk = {
  v: 1 as const,
  preset: 'classic' as const,
  order: ['markets', 'chart', 'book'] as const,
  widths: { markets: 13.5, book: 16.5 },
};
const layout = (id: string, name = id) => ({
  id,
  name,
  symbol: 'BTC/USDT',
  interval: '15m' as const,
  desk: { ...desk, order: [...desk.order] },
  savedAt: '2026-11-07T08:00:00.000Z',
});
/** A free-form workspace: two panels, one of a type no screen knows yet. */
const freeForm: DeskWorkspaceV2 = {
  v: 2,
  columns: 24,
  panels: [
    { id: 'chart', type: 'chart', settings: { symbol: 'ETH/USDT' }, grid: { x: 0, y: 0, w: 16, h: 12 } },
    { id: 'later', type: 'liquidity-heatmap', settings: { depth: 3 }, grid: { x: 16, y: 0, w: 8, h: 12 } },
  ],
};
const freeLayout = (id: string, name = id) => ({ ...layout(id, name), desk: freeForm });
const value = (over: Partial<DeskLayoutsValue> = {}): DeskLayoutsValue =>
  parseDeskLayoutsShape({ layouts: [], active: null, deleted: [], ...over });
const LIMITS = { layoutCap: 2, restoreCap: 1, restoreDays: 7 };
const NOW = new Date('2026-11-07T09:00:00.000Z');
const codeOf = (fn: () => void) => {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code;
  }
};

describe('saved desk layouts: shape', () => {
  it('takes a named layout with its symbol, interval and desk', () => {
    expect(value({ layouts: [layout('scalp', 'Scalp')], active: 'scalp' }).layouts[0]?.name).toBe('Scalp');
  });

  it('refuses two layouts with one name, an active that names none, and an unknown field', () => {
    expect(codeOf(() => value({ layouts: [layout('a', 'Scalp'), layout('b', 'scalp')] }))).toBe('identity.preferences_value_invalid');
    expect(codeOf(() => value({ layouts: [layout('a')], active: 'b' }))).toBe('identity.preferences_value_invalid');
    expect(codeOf(() => parseDeskLayoutsShape({ layouts: [], active: null, deleted: [], extra: 1 }))).toBe(
      'identity.preferences_value_invalid',
    );
  });
});

describe('saved desk layouts: the free-form workspace', () => {
  it('stores a free-form layout beside a v1 one, with a default per desk, and keeps an unknown panel type', () => {
    const stored = value({ layouts: [layout('a'), freeLayout('b')], active: 'b', defaults: { spot: 'a', perps: 'b' } });
    expect(stored.layouts[1]?.desk).toEqual(freeForm);
    expect(stored.defaults).toEqual({ spot: 'a', perps: 'b' });
  });

  it('refuses two panels on one cell, as invalid', () => {
    const clash = { ...freeForm, panels: [freeForm.panels[0]!, { ...freeForm.panels[1]!, grid: { x: 10, y: 0, w: 8, h: 12 } }] };
    expect(codeOf(() => value({ layouts: [{ ...layout('a'), desk: clash }] }))).toBe('identity.preferences_value_invalid');
  });

  it('meets the same owner limits as a v1 layout', () => {
    expect(codeOf(() => checkDeskLayoutGrowth(value({ layouts: [freeLayout('a')] }), null, NO_DESK_LAYOUT_LIMITS, NOW))).toBe(
      DESK_LAYOUT_CAP_UNSET,
    );
    const two = value({ layouts: [freeLayout('a'), freeLayout('b')] });
    const three = value({ layouts: [freeLayout('a'), freeLayout('b'), freeLayout('c')] });
    expect(codeOf(() => checkDeskLayoutGrowth(three, two, LIMITS, NOW))).toBe(DESK_LAYOUT_CAP_EXCEEDED);
    const deleted = value({ layouts: [freeLayout('b')], deleted: [{ ...freeLayout('a'), deletedAt: NOW.toISOString() }] });
    expect(codeOf(() => checkDeskLayoutGrowth(deleted, two, NO_DESK_LAYOUT_LIMITS, NOW))).toBe(DESK_LAYOUT_RESTORE_UNSET);
    expect(codeOf(() => checkDeskLayoutGrowth(deleted, two, LIMITS, NOW))).toBeNull();
  });
});

describe('saved desk layouts: panel link groups', () => {
  const btc = { symbol: 'BTC/USDT', venue: 'test-venue', kind: 'spot' as const };
  const withLinks = (links: unknown) => {
    const one = layout('linked', 'Linked');
    return { ...one, desk: { ...one.desk, links } };
  };

  it("stores each panel's colour group and the symbol, venue and market kind the group carries", () => {
    const links = { members: { markets: 'red', chart: 'red', book: 'blue' }, groups: { red: btc, blue: { ...btc, symbol: 'ETH/USDT' } } };
    const stored = value({ layouts: [withLinks(links)] as DeskLayoutsValue['layouts'] });
    expect(stored.layouts[0]?.desk.links).toEqual(links);
  });

  it('refuses a member whose group carries nothing, a group with no member, a panel not on the desk, and an unknown colour', () => {
    const refused = (links: unknown) => codeOf(() => value({ layouts: [withLinks(links)] as DeskLayoutsValue['layouts'] }));
    expect(refused({ members: { chart: 'red' }, groups: {} })).toBe('identity.preferences_value_invalid');
    expect(refused({ members: { chart: 'red' }, groups: { red: btc, blue: btc } })).toBe('identity.preferences_value_invalid');
    expect(refused({ members: { trades: 'red' }, groups: { red: btc } })).toBe('identity.preferences_value_invalid');
    expect(refused({ members: { chart: 'mauve' }, groups: { mauve: btc } })).toBe('identity.preferences_value_invalid');
  });
});

describe('saved desk layouts: the owner limits', () => {
  it('a new layout needs the cap set, and stops at it', () => {
    expect(codeOf(() => checkDeskLayoutGrowth(value({ layouts: [layout('a')] }), null, NO_DESK_LAYOUT_LIMITS, NOW))).toBe(
      DESK_LAYOUT_CAP_UNSET,
    );
    expect(codeOf(() => checkDeskLayoutGrowth(value({ layouts: [layout('a')] }), null, LIMITS, NOW))).toBeNull();
    const two = value({ layouts: [layout('a'), layout('b')] });
    expect(codeOf(() => checkDeskLayoutGrowth(value({ layouts: [layout('a'), layout('b'), layout('c')] }), two, LIMITS, NOW))).toBe(
      DESK_LAYOUT_CAP_EXCEEDED,
    );
  });

  it('an autosave or rename adds nothing and passes with every limit blank', () => {
    const stored = value({ layouts: [layout('a')], active: 'a' });
    const renamed = value({ layouts: [{ ...layout('a'), name: 'Swing' }], active: 'a' });
    expect(codeOf(() => checkDeskLayoutGrowth(renamed, stored, NO_DESK_LAYOUT_LIMITS, NOW))).toBeNull();
  });

  it('a delete keeps the layout for restoring, within the restore list, and needs both restore limits', () => {
    const stored = value({ layouts: [layout('a'), layout('b')] });
    const deleted = value({ layouts: [layout('b')], deleted: [{ ...layout('a'), deletedAt: NOW.toISOString() }] });
    expect(codeOf(() => checkDeskLayoutGrowth(deleted, stored, NO_DESK_LAYOUT_LIMITS, NOW))).toBe(DESK_LAYOUT_RESTORE_UNSET);
    expect(codeOf(() => checkDeskLayoutGrowth(deleted, stored, LIMITS, NOW))).toBeNull();
    const both = value({
      layouts: [],
      deleted: [
        { ...layout('a'), deletedAt: NOW.toISOString() },
        { ...layout('b'), deletedAt: NOW.toISOString() },
      ],
    });
    expect(codeOf(() => checkDeskLayoutGrowth(both, deleted, LIMITS, NOW))).toBe(DESK_LAYOUT_RESTORE_FULL);
  });

  it('a restore comes back only inside the days', () => {
    const recent = value({ deleted: [{ ...layout('a'), deletedAt: '2026-11-06T09:00:00.000Z' }] });
    const old = value({ deleted: [{ ...layout('a'), deletedAt: '2026-10-01T09:00:00.000Z' }] });
    const restored = value({ layouts: [layout('a')] });
    expect(codeOf(() => checkDeskLayoutGrowth(restored, recent, LIMITS, NOW))).toBeNull();
    expect(codeOf(() => checkDeskLayoutGrowth(restored, old, LIMITS, NOW))).toBe(DESK_LAYOUT_RESTORE_EXPIRED);
    expect(codeOf(() => checkDeskLayoutGrowth(restored, recent, { ...LIMITS, restoreDays: null }, NOW))).toBe(DESK_LAYOUT_RESTORE_UNSET);
  });
});
