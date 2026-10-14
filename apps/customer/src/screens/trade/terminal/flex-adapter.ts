/**
 * The edge between `WorkspaceV1` (ours) and flexlayout-react's JSON (theirs). This is the only file that knows the
 * library's shape. Swapping the docking library later means rewriting this file and `theme` CSS, not migrating saved
 * layouts (docking-spike DECISION.md, "What the choice locks in").
 *
 * flexlayout-react is a 0.x library: the version is pinned exactly in package.json, and `flex-adapter.test.ts` checks
 * that a layout survives our JSON -> library -> library JSON -> our JSON round trip unchanged. Re-run it on every bump.
 */
import type { IGlobalAttributes, IJsonModel, IJsonRowNode, IJsonTabNode, IJsonTabSetNode } from 'flexlayout-react';
import type { LayoutNode, PanelRef, SettingValue, WorkspaceV1 } from './workspace';
import { structureProblem } from './workspace';

export interface PanelLook {
  title: string;
  minWidth?: number;
  minHeight?: number;
}

/** Tab ids are our panel ids; everything else about a tab is rebuilt from the registry, never trusted from storage. */
interface TabConfig {
  type: string;
  link: PanelRef['link'];
  settings: Record<string, SettingValue>;
}

/** Global switches for a locked or unlocked desk. Also applied to a live model when the lock is toggled. */
export function lockAttributes(locked: boolean): IGlobalAttributes {
  return {
    tabEnableDrag: !locked,
    tabSetEnableDrag: !locked,
    tabSetEnableDrop: !locked,
    tabEnableClose: !locked,
    tabSetEnableClose: false,
  };
}

/** Actions that change the arrangement. A locked desk drops all of them (the keyboard and the pointer both end here). */
export const LAYOUT_CHANGING_ACTIONS: ReadonlySet<string> = new Set([
  'FlexLayout_MoveNode',
  'FlexLayout_AdjustWeights',
  'FlexLayout_AdjustBorderSplit',
  'FlexLayout_DeleteTab',
  'FlexLayout_DeleteTabset',
  'FlexLayout_AddNode',
  'FlexLayout_PopoutTab',
  'FlexLayout_PopoutTabset',
  'FlexLayout_PopoutFloat',
  'FlexLayout_MoveFloat',
  'FlexLayout_DockFloatToLayout',
  'FlexLayout_CreateSubLayout',
]);

function globalAttributes(workspace: WorkspaceV1): IGlobalAttributes {
  return {
    ...lockAttributes(workspace.locked),
    rootOrientationVertical: workspace.tree.kind === 'split' && workspace.tree.direction === 'column',
    tabSetEnableMaximize: true,
    tabSetEnableDivide: true,
    tabSetEnableTabStrip: true,
    tabSetEnableDeleteWhenEmpty: true,
    tabEnableRename: false,
    tabEnablePopout: false,
    tabEnablePopoutIcon: false,
    tabEnableFloat: false,
    tabEnableFloatIcon: false,
    enableEdgeDock: true,
  };
}

/** Our workspace to the library's JSON. */
export function toFlexJson(workspace: WorkspaceV1, look: (type: string) => PanelLook): IJsonModel {
  const tab = (panel: PanelRef): IJsonTabNode => {
    const shown = look(panel.type);
    return {
      type: 'tab',
      id: panel.id,
      name: shown.title,
      component: 'panel',
      config: { type: panel.type, link: panel.link, settings: panel.settings } satisfies TabConfig,
      ...(shown.minWidth ? { minWidth: shown.minWidth } : {}),
      ...(shown.minHeight ? { minHeight: shown.minHeight } : {}),
    };
  };
  const convert = (node: LayoutNode): IJsonRowNode | IJsonTabSetNode =>
    node.kind === 'stack'
      ? { type: 'tabset', weight: node.weight, selected: node.selected, children: node.panels.map(tab) }
      : { type: 'row', weight: node.weight, children: node.children.map(convert) };

  const root = workspace.tree;
  // The library's root is always a row. A layout that is one stack, or a split whose direction the library's root
  // cannot take, sits inside it; `rootOrientationVertical` makes a column root run top to bottom.
  const children = root.kind === 'stack' ? [convert(root)] : root.children.map(convert);
  return { global: globalAttributes(workspace), layout: { type: 'row', children } };
}

/** The library's JSON back to our tree. `workspace` supplies everything the library does not hold (id, name, preset, lock). */
export function fromFlexJson(json: IJsonModel, workspace: WorkspaceV1): WorkspaceV1 | null {
  const panelsById = new Map<string, PanelRef>();
  const collect = (node: LayoutNode) => {
    if (node.kind === 'stack') for (const panel of node.panels) panelsById.set(panel.id, panel);
    else node.children.forEach(collect);
  };
  collect(workspace.tree);

  const vertical = json.global?.rootOrientationVertical ?? (workspace.tree.kind === 'split' && workspace.tree.direction === 'column');
  const convert = (node: IJsonRowNode | IJsonTabSetNode, parent: 'row' | 'column'): LayoutNode | null => {
    const weight = typeof node.weight === 'number' && node.weight > 0 ? node.weight : 100;
    if (node.type === 'tabset') {
      const tabset = node as IJsonTabSetNode;
      const tabs = (tabset.children ?? []).filter((child): child is IJsonTabNode => child.type === 'tab');
      const panels = tabs.flatMap((child): PanelRef[] => {
        const config = (child.config ?? {}) as Partial<TabConfig>;
        if (!child.id || typeof config.type !== 'string') return [];
        // Prefer what we already hold for this id (it validated); take the library's copy for a panel added from the menu.
        const known = panelsById.get(child.id);
        return [known ?? { id: child.id, type: config.type, link: config.link ?? 'lime', settings: config.settings ?? {} }];
      });
      if (panels.length === 0) return null;
      const selected = typeof tabset.selected === 'number' && tabset.selected >= 0 && tabset.selected < panels.length ? tabset.selected : 0;
      return { kind: 'stack', weight, selected, panels };
    }
    const direction: 'row' | 'column' = parent === 'row' ? 'column' : 'row';
    const children = ((node as IJsonRowNode).children ?? [])
      .map((child) => convert(child as IJsonRowNode | IJsonTabSetNode, direction))
      .filter((child): child is LayoutNode => child !== null);
    if (children.length === 0) return null;
    return { kind: 'split', direction, weight, children };
  };

  const rootDirection: 'row' | 'column' = vertical ? 'column' : 'row';
  const children = json.layout.children
    ?.map((child) => convert(child as IJsonRowNode | IJsonTabSetNode, rootDirection))
    .filter((child): child is LayoutNode => child !== null);
  if (!children || children.length === 0) return null;
  const tree: LayoutNode =
    children.length === 1 && children[0]!.kind === 'stack'
      ? { ...children[0]!, weight: 100 }
      : { kind: 'split', direction: rootDirection, weight: 100, children };
  if (structureProblem(tree)) return null;
  return { ...workspace, tree };
}
