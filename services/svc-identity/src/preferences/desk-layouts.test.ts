import { describe, expect, it } from 'vitest';
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
