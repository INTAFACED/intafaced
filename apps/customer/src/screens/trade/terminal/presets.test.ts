import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESET, isPresetId, PRESETS, presetInfo, workspaceFromPreset } from './presets';
import { panelsOf, PRESET_IDS, readWorkspace, structureProblem } from './workspace';

// The panel types the desk registers today (panels.tsx). The browser test checks each one renders.
const builtIn = new Set<string>(['markets', 'chart', 'orderbook', 'trades', 'ticket', 'orders']);

describe('presets', () => {
  it('are the six the roadmap names, Classic first and the default', () => {
    expect(PRESETS.map((preset) => preset.name)).toEqual(['Classic', 'Chart focus', 'Scalper', 'Book focus', 'Multi-market', 'Minimal']);
    expect(PRESETS.map((preset) => preset.id)).toEqual([...PRESET_IDS]);
    expect(DEFAULT_PRESET).toBe('classic');
    expect(isPresetId('scalper')).toBe(true);
    expect(isPresetId('nope')).toBe(false);
  });

  for (const preset of PRESETS) {
    it(`${preset.name} loads as valid workspace JSON that uses only panels the desk has`, () => {
      const workspace = workspaceFromPreset(preset.id, 'ws-' + preset.id);
      expect(structureProblem(workspace.tree)).toBeNull();
      expect(readWorkspace(JSON.parse(JSON.stringify(workspace)))).toMatchObject({ ok: true });
      for (const panel of panelsOf(workspace.tree)) expect(builtIn.has(panel.type), `${preset.id}: ${panel.type}`).toBe(true);
      expect(workspace.preset).toBe(preset.id);
      expect(workspace.name).toBe(preset.name);
      expect(workspace.locked).toBe(false);
    });
  }

  it('every preset has the ticket and a way to see orders, except none is missing the chart or the book', () => {
    for (const preset of PRESETS) {
      const types = panelsOf(workspaceFromPreset(preset.id, 'x').tree).map((panel) => panel.type);
      expect(types, preset.id).toContain('ticket');
      expect(types, preset.id).toContain('chart');
      expect(types, preset.id).toContain('orders');
    }
    // Classic is the OKX shape from the plan: markets, chart over ticket, book with trades, orders dock.
    const classic = panelsOf(workspaceFromPreset('classic', 'x').tree).map((panel) => panel.type);
    expect(classic).toEqual(['markets', 'chart', 'ticket', 'orderbook', 'trades', 'orders']);
  });

  it('gives a fresh tree each time, so editing one workspace never edits a preset', () => {
    const a = workspaceFromPreset('classic', 'a');
    const b = workspaceFromPreset('classic', 'b');
    expect(a.tree).toEqual(b.tree);
    expect(a.tree).not.toBe(b.tree);
    expect(presetInfo('minimal').name).toBe('Minimal');
  });
});
