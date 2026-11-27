/**
 * Panel link groups: in a multi-panel desk, panels follow each other. Each panel may join one colour group; a
 * group carries one market (symbol, venue and market kind), and a change in one member reaches every member of its group
 * and none outside it. The shape is the contract's (`deskLinksSchema` in `@intafaced/contracts/desk-layouts-preferences`)
 * and is saved with the layout (`saved-layouts.ts`). Pure rules and a small live store, no React and no screen.
 */
import {
  DESK_LINK_COLOURS,
  type DeskLinkColour,
  type DeskLinkContext,
  type DeskLinks,
} from '@intafaced/contracts/desk-layouts-preferences';
import { WIDGET_IDS, type WidgetId } from './workspace';

export type { DeskLinkColour as LinkColour, DeskLinkContext as LinkContext, DeskLinks };

export const NO_LINKS: DeskLinks = { members: {}, groups: {} };

/** The group a panel is in, if any. */
function groupOf(links: DeskLinks, panel: WidgetId): DeskLinkColour | undefined {
  return links.members[panel];
}

/** The panels in a group, in the desk's widget order. */
function membersOf(links: DeskLinks, colour: DeskLinkColour): WidgetId[] {
  return WIDGET_IDS.filter((panel) => links.members[panel] === colour);
}

/** The market a panel shows: its group's when it is in one, else its own. */
export function contextOf(links: DeskLinks, panel: WidgetId, own: DeskLinkContext): DeskLinkContext {
  const colour = groupOf(links, panel);
  return (colour && links.groups[colour]) ?? own;
}

/** A group nobody is in is dropped, so a saved layout never keeps one. */
function prune(members: DeskLinks['members'], groups: DeskLinks['groups']): DeskLinks {
  const kept: DeskLinks['groups'] = {};
  for (const colour of DESK_LINK_COLOURS) {
    const group = groups[colour];
    if (group && WIDGET_IDS.some((panel) => members[panel] === colour)) kept[colour] = group;
  }
  return { members, groups: kept };
}

/**
 * A panel joins a group, leaving any other. It takes what the group carries; when it is the first one in, the group takes
 * the panel's own market (`current`).
 */
export function joinGroup(links: DeskLinks, panel: WidgetId, colour: DeskLinkColour, current: DeskLinkContext): DeskLinks {
  const members = { ...links.members, [panel]: colour };
  const groups = links.groups[colour] ? links.groups : { ...links.groups, [colour]: { ...current } };
  return prune(members, groups);
}

/** A panel leaves its group; the last one out takes the group with it. */
export function leaveGroup(links: DeskLinks, panel: WidgetId): DeskLinks {
  if (groupOf(links, panel) === undefined) return links;
  const { [panel]: _left, ...members } = links.members;
  return prune(members, links.groups);
}

/**
 * A panel changes its market. In a group, the group carries the new market and every member is reached; alone, only the
 * panel itself is, and the links are unchanged.
 */
export function changeSymbol(links: DeskLinks, panel: WidgetId, next: DeskLinkContext): { links: DeskLinks; reached: WidgetId[] } {
  const colour = groupOf(links, panel);
  if (colour === undefined) return { links, reached: [panel] };
  return { links: { ...links, groups: { ...links.groups, [colour]: { ...next } } }, reached: membersOf(links, colour) };
}

type Listener = (context: DeskLinkContext) => void;

/** The live links of one desk: panels subscribe, and a change tells each listening member of the group. */
export function createLinkGroups(initial: DeskLinks = NO_LINKS) {
  let current = initial;
  const listeners = new Map<WidgetId, Set<Listener>>();
  return {
    links: () => current,
    subscribe(panel: WidgetId, listener: Listener): () => void {
      const set = listeners.get(panel) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(panel, set);
      return () => set.delete(listener);
    },
    join(panel: WidgetId, colour: DeskLinkColour, own: DeskLinkContext) {
      current = joinGroup(current, panel, colour, own);
    },
    leave(panel: WidgetId) {
      current = leaveGroup(current, panel);
    },
    change(panel: WidgetId, next: DeskLinkContext): WidgetId[] {
      const result = changeSymbol(current, panel, next);
      current = result.links;
      for (const member of result.reached) for (const listener of listeners.get(member) ?? []) listener(next);
      return result.reached;
    },
  };
}
export type LinkGroups = ReturnType<typeof createLinkGroups>;
