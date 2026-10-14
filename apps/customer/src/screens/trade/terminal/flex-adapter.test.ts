import { Actions, DockLocation, Model } from 'flexlayout-react';
import { describe, expect, it } from 'vitest';
import { fromFlexJson, LAYOUT_CHANGING_ACTIONS, lockAttributes, toFlexJson } from './flex-adapter';
import { PRESETS, workspaceFromPreset } from './presets';
import { panelsOf, readWorkspace, structureProblem, type WorkspaceV1 } from './workspace';

const look = (type: string) => ({ title: type.toUpperCase(), minWidth: 100, minHeight: 80 });

/** Our JSON -> the library's model -> the library's JSON -> our JSON. */
const roundTrip = (workspace: WorkspaceV1) => fromFlexJson(Model.fromJson(toFlexJson(workspace, look)).toJson(), workspace);

describe('the flexlayout-react edge', () => {
  for (const preset of PRESETS) {
    it(`${preset.name} survives a round trip through the library byte for byte`, () => {
      const workspace = workspaceFromPreset(preset.id, 'ws-' + preset.id);
      const back = roundTrip(workspace);
      expect(back).toEqual(workspace);
      expect(JSON.stringify(back)).toBe(JSON.stringify(workspace));
    });
  }

  it('keeps the selected tab, the lock, the name and the preset it was started from', () => {
    const workspace = workspaceFromPreset('classic', 'ws-a', 'My desk');
    const stack = JSON.parse(JSON.stringify(workspace)) as WorkspaceV1;
    // The right column holds the book and the trades; select the second.
    const walk = (node: WorkspaceV1['tree']): void => {
      if (node.kind === 'stack') {
        if (node.panels.length === 2) node.selected = 1;
      } else node.children.forEach(walk);
    };
    walk(stack.tree);
    stack.locked = true;
    const back = roundTrip(stack)!;
    expect(back).toEqual(stack);
    expect(back.name).toBe('My desk');
    expect(back.preset).toBe('classic');
  });

  it('keeps fractional weights exactly (a dragged gutter)', () => {
    const workspace = workspaceFromPreset('classic', 'ws-a');
    const model = Model.fromJson(toFlexJson(workspace, look));
    const row = model.getRootRow()!.getChildren()[0]!;
    model.doAction(Actions.adjustWeights(row.getId(), [18.5, 62.25, 19.25]));
    const back = fromFlexJson(model.toJson(), workspace)!;
    const json = JSON.stringify(back.tree);
    expect(json).toContain('18.5');
    expect(json).toContain('62.25');
    expect(fromFlexJson(Model.fromJson(toFlexJson(back, look)).toJson(), back)).toEqual(back);
    expect(readWorkspace(JSON.parse(JSON.stringify(back)))).toMatchObject({ ok: true });
  });

  it('turns a dragged tab into the new tree, and the result still validates', () => {
    const workspace = workspaceFromPreset('classic', 'ws-a');
    const model = Model.fromJson(toFlexJson(workspace, look));
    // Drag the Last trades tab out of the book's box and into the ticket's box.
    const trades = model.getNodeById('trades')!;
    const ticket = model.getNodeById('ticket')!;
    model.doAction(Actions.moveNode(trades.getId(), ticket.getParent()!.getId(), DockLocation.CENTER, -1));
    const back = fromFlexJson(model.toJson(), workspace)!;
    expect(structureProblem(back.tree)).toBeNull();
    expect(
      panelsOf(back.tree)
        .map((panel) => panel.id)
        .sort(),
    ).toEqual(['chart', 'markets', 'orderbook', 'orders', 'ticket', 'trades']);
    const ticketStack = JSON.stringify(back.tree).match(/"panels":\[[^\]]*"id":"ticket"[^\]]*\]/)![0];
    expect(ticketStack).toContain('"id":"trades"');
    expect(readWorkspace(JSON.parse(JSON.stringify(back)))).toMatchObject({ ok: true });
  });

  it('returns null, not a half layout, when every panel was closed', () => {
    const workspace = workspaceFromPreset('minimal', 'ws-a');
    const model = Model.fromJson(toFlexJson(workspace, look));
    for (const id of ['chart', 'ticket', 'orders']) model.doAction(Actions.deleteTab(id));
    expect(fromFlexJson(model.toJson(), workspace)).toBeNull();
  });

  it('gives each tab its registry title and minimum size, and our panel config', () => {
    const json = toFlexJson(workspaceFromPreset('minimal', 'ws-a'), look);
    const tabs: Array<Record<string, unknown>> = [];
    const visit = (node: { children?: unknown[] }) => {
      for (const child of node.children ?? []) {
        const record = child as Record<string, unknown> & { children?: unknown[] };
        if (record.type === 'tab') tabs.push(record);
        else visit(record);
      }
    };
    visit(json.layout);
    expect(tabs.map((tab) => tab.name)).toEqual(['CHART', 'TICKET', 'ORDERS']);
    expect(tabs[0]).toMatchObject({
      id: 'chart',
      component: 'panel',
      minWidth: 100,
      minHeight: 80,
      config: { type: 'chart', link: 'lime', settings: {} },
    });
  });

  it('runs a column root top to bottom, and a row root left to right', () => {
    expect(toFlexJson(workspaceFromPreset('classic', 'a'), look).global?.rootOrientationVertical).toBe(true);
    expect(toFlexJson(workspaceFromPreset('book-focus', 'a'), look).global?.rootOrientationVertical).toBe(false);
  });
});

describe('the lock', () => {
  it('switches drag, drop and close off together', () => {
    expect(lockAttributes(true)).toMatchObject({
      tabEnableDrag: false,
      tabSetEnableDrag: false,
      tabSetEnableDrop: false,
      tabEnableClose: false,
    });
    expect(lockAttributes(false)).toMatchObject({
      tabEnableDrag: true,
      tabSetEnableDrag: true,
      tabSetEnableDrop: true,
      tabEnableClose: true,
    });
  });

  it('builds the model locked when the workspace is saved locked', () => {
    const workspace = { ...workspaceFromPreset('minimal', 'a'), locked: true };
    expect(toFlexJson(workspace, look).global).toMatchObject({ tabEnableDrag: false, tabEnableClose: false });
  });

  it('lists the actions a locked desk drops (moves, resizes, closes) and not select or maximise', () => {
    for (const type of ['FlexLayout_MoveNode', 'FlexLayout_AdjustWeights', 'FlexLayout_DeleteTab', 'FlexLayout_DeleteTabset'])
      expect(LAYOUT_CHANGING_ACTIONS.has(type)).toBe(true);
    for (const type of ['FlexLayout_SelectTab', 'FlexLayout_MaximizeToggle', 'FlexLayout_SetActiveTabset'])
      expect(LAYOUT_CHANGING_ACTIONS.has(type)).toBe(false);
    // The names must be the library's own, or the lock would silently drop nothing.
    expect(Actions.MOVE_NODE).toBe('FlexLayout_MoveNode');
    expect(Actions.ADJUST_WEIGHTS).toBe('FlexLayout_AdjustWeights');
    expect(Actions.DELETE_TAB).toBe('FlexLayout_DeleteTab');
    expect(Actions.DELETE_TABSET).toBe('FlexLayout_DeleteTabset');
    expect(Actions.MAXIMIZE_TOGGLE).toBe('FlexLayout_MaximizeToggle');
    expect(Actions.SELECT_TAB).toBe('FlexLayout_SelectTab');
    for (const name of LAYOUT_CHANGING_ACTIONS) expect(Object.values(actionNames())).toContain(name);
  });
});

function actionNames(): Record<string, string> {
  return Object.fromEntries(Object.entries(Actions).filter(([key, value]) => typeof value === 'string' && /^[A-Z_]+$/.test(key)));
}
