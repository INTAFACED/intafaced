import { describe, expect, it } from 'vitest';
import { autosave, copyLayout, deleteLayout, exportFile, markInUse, restoreLayout, saveAs } from './saved-layouts';
import { EMPTY_DESK_LAYOUTS } from '@intafaced/contracts/desk-layouts-preferences';
import { presetLayout } from './workspace';

const NOW = new Date('2026-11-07T09:00:00.000Z');
const LATER = new Date('2026-11-07T09:05:00.000Z');
const saved = saveAs(EMPTY_DESK_LAYOUTS, { name: 'Scalp', symbol: 'BTC/USDT', interval: '15m', desk: presetLayout('advanced') }, NOW);
const scalp = saved.layouts[0]!;

describe('saved desk layouts', () => {
  it('saves the desk with its symbol and interval and puts it in use', () => {
    expect(scalp).toMatchObject({ name: 'Scalp', symbol: 'BTC/USDT', interval: '15m', desk: { preset: 'advanced' } });
    expect(saved.active).toBe(scalp.id);
  });

  it('saving the same name replaces that layout, keeping its id', () => {
    const again = saveAs(saved, { name: 'scalp ', symbol: 'ETH/USDT', interval: '1h', desk: presetLayout('classic') }, LATER);
    expect(again.layouts).toHaveLength(1);
    expect(again.layouts[0]).toMatchObject({ id: scalp.id, symbol: 'ETH/USDT', interval: '1h' });
  });

  it('autosaves only into the layout in use', () => {
    expect(autosave(saved, presetLayout('classic'), LATER).layouts[0]?.desk.preset).toBe('classic');
    const none = { ...saved, active: null };
    expect(autosave(none, presetLayout('classic'), LATER)).toBe(none);
  });

  it('copies under a free name, deletes into the restore list, and restores', () => {
    const copied = copyLayout(saved, scalp.id, LATER);
    expect(copied.layouts.map((layout) => layout.name)).toEqual(['Scalp', 'Scalp (copy)']);
    expect(new Set(copied.layouts.map((layout) => layout.id)).size).toBe(2);
    const deleted = deleteLayout(copied, scalp.id, LATER);
    expect(deleted.layouts.map((layout) => layout.name)).toEqual(['Scalp (copy)']);
    expect(deleted.active).toBeNull();
    expect(deleted.deleted[0]).toMatchObject({ id: scalp.id, deletedAt: LATER.toISOString() });
    const restored = restoreLayout(deleted, scalp.id);
    expect(restored.layouts.map((layout) => layout.name)).toEqual(['Scalp (copy)', 'Scalp']);
    expect(restored.deleted).toEqual([]);
    expect(markInUse(restored, scalp.id).active).toBe(scalp.id);
  });

  it('exports the layout settings as a named JSON file', () => {
    const file = exportFile(scalp);
    expect(file.name).toBe('Scalp desk layout.json');
    expect(JSON.parse(file.text)).toMatchObject({ kind: 'intafaced.desk-layout', v: 1, layout: { name: 'Scalp' } });
  });
});
