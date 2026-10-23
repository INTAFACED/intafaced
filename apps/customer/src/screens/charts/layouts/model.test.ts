// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { layoutSnapshotSchema, type LayoutSnapshot, type LayoutsValue } from '@intafaced/contracts/layouts-preferences';
import {
  cleanName,
  copyLayout,
  deleteLayout,
  deskForPreset,
  EXPORT_FORMAT,
  exportFileName,
  exportText,
  isDeskSetting,
  PRESET_DESK,
  emptyRecentlyDeleted,
  recoverLayout,
  replaceNamed,
  saveNamed,
  withSnapshot,
} from './model';
import { removeTemplate, saveTemplate } from './templates';
import { applyWrites, captureSnapshot, deskKey, planWrites } from './capture';
import { gridKey } from '../grid';
import { settingKey } from '../workbench';
import { drawingsKey } from '../drawings/store';
import { studiesKey } from './capture';

const NOW = '2026-10-23T12:00:00.000Z';
const LATER = '2026-10-23T12:05:00.000Z';

const snapshot = (symbol = 'BTC/USDT', interval = '15m'): LayoutSnapshot =>
  layoutSnapshotSchema.parse({
    symbol,
    interval,
    mode: 'candles',
    scheme: 'standard',
    desk: PRESET_DESK.advanced,
    firstGroup: 'blue',
    grid: {
      layout: 'single',
      sync: { symbol: true, interval: true, crosshair: false, range: false },
      cells: [],
      sizes: { cols: [1, 1], rows: [1, 1] },
    },
    studies: [],
    drawings: null,
  });

const empty: LayoutsValue = { layouts: [], deleted: [] };

describe('desk presets', () => {
  it('Classic has the chart and the watchlist; Advanced adds the studies bar and the drawing tools', () => {
    expect(PRESET_DESK.classic).toEqual({ preset: 'classic', side: 'right', studies: false, drawings: false });
    expect(PRESET_DESK.advanced).toEqual({ preset: 'advanced', side: 'right', studies: true, drawings: true });
  });

  it('a preset keeps the side the watchlist is on', () => {
    expect(deskForPreset('advanced', 'left')).toEqual({ preset: 'advanced', side: 'left', studies: true, drawings: true });
  });

  it('a stored desk that does not read as one is ignored', () => {
    expect(isDeskSetting({ preset: 'pro', side: 'right', studies: true, drawings: true })).toBe(false);
    expect(isDeskSetting(PRESET_DESK.classic)).toBe(true);
  });
});

describe('saving layouts', () => {
  it('saves a new layout under a name', () => {
    const outcome = saveNamed(empty, ' Scalp ', snapshot(), NOW, 'layout-a');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.layout.name).toBe('Scalp');
    expect(outcome.record.layouts.map((l) => l.id)).toEqual(['layout-a']);
  });

  it('refuses a blank name and a name already taken, ignoring case and spacing', () => {
    const first = saveNamed(empty, 'Scalp', snapshot(), NOW, 'layout-a');
    if (!first.ok) throw new Error('setup');
    expect(saveNamed(first.record, '   ', snapshot(), NOW, 'x')).toEqual({ ok: false, why: 'name-needed' });
    expect(saveNamed(first.record, ' scalp ', snapshot(), NOW, 'x')).toEqual({ ok: false, why: 'name-taken' });
  });

  it('replaces the layout that holds the name, keeping its id', () => {
    const first = saveNamed(empty, 'Scalp', snapshot('BTC/USDT', '15m'), NOW, 'layout-a');
    if (!first.ok) throw new Error('setup');
    const replaced = replaceNamed(first.record, 'Scalp', snapshot('ETH/USDT', '1h'), LATER);
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.record.layouts).toHaveLength(1);
    expect(replaced.record.layouts[0]).toMatchObject({ id: 'layout-a', savedAt: LATER });
    expect(replaced.record.layouts[0]!.snapshot.symbol).toBe('ETH/USDT');
  });

  it('copies a layout under its own id and a free name', () => {
    const first = saveNamed(empty, 'Scalp', snapshot(), NOW, 'layout-a');
    if (!first.ok) throw new Error('setup');
    const once = copyLayout(first.record, 'layout-a', 'layout-b', LATER);
    expect(once?.ok && once.layout.name).toBe('Scalp copy');
    if (!once?.ok) return;
    const twice = copyLayout(once.record, 'layout-a', 'layout-c', LATER);
    expect(twice?.ok && twice.layout.name).toBe('Scalp copy 2');
    expect(twice?.ok && twice.layout.snapshot).toEqual(first.layout.snapshot);
  });

  it('autosaves the open layout with the new snapshot', () => {
    const first = saveNamed(empty, 'Scalp', snapshot(), NOW, 'layout-a');
    if (!first.ok) throw new Error('setup');
    const next = withSnapshot(first.record, 'layout-a', snapshot('SOL/USDT', '4h'), LATER);
    expect(next?.layouts[0]?.snapshot.symbol).toBe('SOL/USDT');
    expect(withSnapshot(first.record, 'missing', snapshot(), LATER)).toBeNull();
  });
});

describe('deleting and recovering', () => {
  it('moves a deleted layout to the recovery list and brings it back with its charts', () => {
    const first = saveNamed(empty, 'Scalp', snapshot('BTC/USDT', '5m'), NOW, 'layout-a');
    if (!first.ok) throw new Error('setup');
    const deleted = deleteLayout(first.record, 'layout-a', LATER);
    expect(deleted?.layouts).toEqual([]);
    expect(deleted?.deleted[0]).toMatchObject({ deletedAt: LATER, layout: { id: 'layout-a' } });
    const back = recoverLayout(deleted!, 'layout-a');
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.record.layouts[0]).toEqual(first.layout);
    expect(back.record.deleted).toEqual([]);
  });

  it('refuses a recover when another layout now holds its name', () => {
    const first = saveNamed(empty, 'Scalp', snapshot(), NOW, 'layout-a');
    if (!first.ok) throw new Error('setup');
    const deleted = deleteLayout(first.record, 'layout-a', LATER)!;
    const again = saveNamed(deleted, 'scalp', snapshot('ETH/USDT'), LATER, 'layout-b');
    if (!again.ok) throw new Error('setup');
    expect(recoverLayout(again.record, 'layout-a')).toEqual({ ok: false, why: 'name-taken' });
  });

  it('returns not-found for a layout that is not there, and empties the recovery list without touching layouts', () => {
    expect(deleteLayout(empty, 'nope', NOW)).toBeNull();
    expect(recoverLayout(empty, 'nope')).toEqual({ ok: false, why: 'not-found' });
    const first = saveNamed(empty, 'Scalp', snapshot(), NOW, 'layout-a');
    if (!first.ok) throw new Error('setup');
    const gone = deleteLayout(first.record, 'layout-a', LATER)!;
    expect(emptyRecentlyDeleted(gone)).toEqual({ layouts: [], deleted: [] });
    const kept = emptyRecentlyDeleted({ ...first.record, deleted: [] });
    expect(kept.layouts).toEqual(first.record.layouts);
  });
});

describe('export', () => {
  it('writes the settings of a layout and never candles', () => {
    const first = saveNamed(empty, 'Scalp', snapshot(), NOW, 'layout-a');
    if (!first.ok) throw new Error('setup');
    const text = exportText(first.layout);
    const parsed = JSON.parse(text) as { format: string; name: string; snapshot: Record<string, unknown> };
    expect(parsed.format).toBe(EXPORT_FORMAT);
    expect(parsed.name).toBe('Scalp');
    expect(Object.keys(parsed.snapshot)).not.toContain('candles');
    expect(text).not.toMatch(/candles":\s*\[/);
  });

  it('names the file in lower case with dashes', () => {
    const named = { id: 'x', name: 'My  Scalp #1', savedAt: NOW, snapshot: snapshot() };
    expect(exportFileName(named)).toBe('my-scalp-1.layout.json');
    expect(cleanName('  x  ')).toBe('x');
  });
});

describe('chart templates', () => {
  const body = { symbol: 'BTC/USDT', interval: '1h' as const, mode: 'line', studies: [], drawings: null };

  it('saves a template, refuses a taken name unless replacing, and removes one', () => {
    const first = saveTemplate([], 'RSI desk', body, NOW, 'template-a', false);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(saveTemplate(first.templates, 'rsi desk', body, LATER, 'template-b', false)).toEqual({ ok: false, why: 'name-taken' });
    const replaced = saveTemplate(first.templates, 'rsi desk', { ...body, interval: '4h' }, LATER, 'template-b', true);
    expect(replaced.ok && replaced.templates).toHaveLength(1);
    expect(replaced.ok && replaced.template.id).toBe('template-a');
    expect(removeTemplate(first.templates, 'template-a')).toEqual([]);
  });
});

describe('device side of a layout', () => {
  beforeEach(() => localStorage.clear());

  it('captures the workbench as it is and writes it back so the page shows it again', () => {
    const user = 'u1';
    const shot = snapshot('BTC/USDT', '1h');
    const drawings = { version: 1, drawings: [{ id: 'd1' }], groups: [], hiddenAll: false };
    const studies = { studies: [{ id: 's1', kind: 'sma' }], remembered: {}, legendAlways: false };
    // The workbench as the desk left it.
    localStorage.setItem(settingKey(user, 'main'), JSON.stringify({ interval: '1h', mode: 'line', scheme: 'mono' }));
    localStorage.setItem(
      gridKey(user, 'main'),
      JSON.stringify({ layout: 'single', sync: shot.grid.sync, cells: [], sizes: shot.grid.sizes }),
    );
    localStorage.setItem(deskKey(user, 'main'), JSON.stringify(PRESET_DESK.advanced));
    localStorage.setItem(studiesKey(user, 'main', 0), JSON.stringify(studies));
    localStorage.setItem(drawingsKey(user, 'main', 'BTC/USDT'), JSON.stringify(drawings));

    const captured = captureSnapshot({
      userId: user,
      workbench: 'main',
      symbol: 'BTC/USDT',
      setting: { interval: '1h', mode: 'line', scheme: 'mono' },
      desk: PRESET_DESK.advanced,
    });
    expect(captured.mode).toBe('line');
    expect(captured.scheme).toBe('mono');
    expect(captured.studies[0]).toEqual(studies);
    expect(captured.drawings).toEqual(drawings);
    expect(layoutSnapshotSchema.safeParse(captured).success).toBe(true);

    // Another device: nothing stored yet. Opening the layout writes it all back.
    localStorage.clear();
    expect(applyWrites(planWrites(captured, user, 'main'))).toBe(true);
    expect(JSON.parse(localStorage.getItem(settingKey(user, 'main'))!)).toEqual({ interval: '1h', mode: 'line', scheme: 'mono' });
    expect(JSON.parse(localStorage.getItem(deskKey(user, 'main'))!)).toEqual(PRESET_DESK.advanced);
    expect(JSON.parse(localStorage.getItem(drawingsKey(user, 'main', 'BTC/USDT'))!)).toEqual(drawings);
  });

  it('reports a storage that refuses a write instead of showing the layout as opened', () => {
    const refusing = {
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => undefined,
    };
    expect(applyWrites([{ key: 'k', value: 'v' }], refusing)).toBe(false);
    expect(applyWrites([{ key: 'k', value: 'v' }], null)).toBe(false);
  });
});
