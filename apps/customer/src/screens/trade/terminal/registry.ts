/**
 * The panel registry: how a box on the desk gets its content.
 *
 * A panel is a `type` (a short stable word saved in the workspace JSON) plus a React component. Later panels plug in
 * with one `registerPanel(...)` call and appear in the rail's "Add panel" menu and in presets and saved layouts,
 * without touching the shell: scanner, heatmap, depth chart, alerts, and the Preview products
 * (`status: 'preview'`, which puts a Preview chip on the tab).
 *
 * The component reads whatever it needs from `useDesk()` (the desk's coin, book, ticker, balances, orders).
 * Nothing here imports a screen, so the registry can be tested on its own.
 */
import type { ComponentType } from 'react';

export interface PanelProps {
  /** False while this panel's tab is hidden behind another tab, or another panel is maximised. Stop polling when false. */
  visible: boolean;
}

export interface PanelDefinition {
  /** Saved in workspaces. Lowercase letters, digits and dashes. Never rename one that shipped. */
  type: string;
  /** Tab title. English source; the shell passes it through as written. */
  title: string;
  /** One plain sentence for the "Add panel" menu. */
  about: string;
  /** `preview`: sample data, never real; the tab carries a Preview chip. */
  status: 'live' | 'preview';
  /** Shows prices. Dimmed with a "Reconnecting" note when the feed is lost, so nobody trades on a silent stale screen. */
  prices?: boolean;
  /** Smallest size in pixels the panel stays usable at. */
  minWidth?: number;
  minHeight?: number;
  component: ComponentType<PanelProps>;
}

const panels = new Map<string, PanelDefinition>();
const listeners = new Set<() => void>();
let version = 0;

const TYPE = /^[a-z0-9][a-z0-9-]*$/;

/** Add (or replace) a panel type. Returns a function that removes it again. */
export function registerPanel(definition: PanelDefinition): () => void {
  if (!TYPE.test(definition.type)) throw new Error(`Bad panel type "${definition.type}"`);
  panels.set(definition.type, definition);
  version += 1;
  for (const listener of listeners) listener();
  return () => {
    if (panels.get(definition.type) === definition) {
      panels.delete(definition.type);
      version += 1;
      for (const listener of listeners) listener();
    }
  };
}

export function getPanel(type: string): PanelDefinition | undefined {
  return panels.get(type);
}

export function isKnownPanel(type: string): boolean {
  return panels.has(type);
}

/** Every registered panel, built-in ones first in the order they were registered. */
export function listPanels(): PanelDefinition[] {
  return [...panels.values()];
}

/** For `useSyncExternalStore`: re-render when a panel is added or removed. */
export function subscribePanels(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function panelsVersion(): number {
  return version;
}
