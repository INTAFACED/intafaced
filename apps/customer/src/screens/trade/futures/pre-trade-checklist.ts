/**
 * The person's pre-trade checklist on the futures ticket (J-derivatives-34 #4 #5): up to three items they write, and
 * whether it is on, kept per wallet in device storage (`if.venue.checklist.<owner>`). While it is on, an opening order
 * waits at Confirm until every item is ticked; a close, a reduce-only order, a stop and a cancel never meet it. Pure
 * functions over a storage object, so every rule is unit tested (pre-trade-checklist.test.ts). Storage can throw
 * (private mode, quota, blocked) and a kept value can be hand-edited: every read is guarded, and anything unknown reads
 * as no checklist, never as one that is ticked.
 */

export const CHECKLIST_ITEMS = 3;
export const CHECKLIST_ITEM_MAX = 120;

export interface Checklist {
  readonly on: boolean;
  /** The items as written, trimmed, blanks dropped; at most three. */
  readonly items: readonly string[];
}

export const NO_CHECKLIST: Checklist = { on: false, items: [] };

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const keyOf = (owner: string) => `if.venue.checklist.${owner.toLowerCase()}`;

/** The items as they are kept: trimmed, blanks dropped, each cut to its length, at most three. */
function cleanItems(items: readonly string[]): string[] {
  return items
    .map((x) => x.trim().slice(0, CHECKLIST_ITEM_MAX))
    .filter((x) => x !== '')
    .slice(0, CHECKLIST_ITEMS);
}

export function readChecklist(store: Store | null, owner: string): Checklist {
  if (!store) return NO_CHECKLIST;
  try {
    const raw = store.getItem(keyOf(owner));
    if (!raw) return NO_CHECKLIST;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return NO_CHECKLIST;
    const { on, items } = parsed as { on?: unknown; items?: unknown };
    const list = Array.isArray(items) ? cleanItems(items.filter((x): x is string => typeof x === 'string')) : [];
    return { on: on === true && list.length > 0, items: list };
  } catch {
    return NO_CHECKLIST;
  }
}

export type SaveChecklist = { ok: true; checklist: Checklist } | { ok: false; reason: 'no_items' | 'not_kept' };

/** Keeps the checklist; turning it on needs at least one item. Answers what was kept, or why nothing was. */
export function saveChecklist(store: Store | null, owner: string, next: { on: boolean; items: readonly string[] }): SaveChecklist {
  const items = cleanItems(next.items);
  if (next.on && items.length === 0) return { ok: false, reason: 'no_items' };
  const checklist: Checklist = { on: next.on, items };
  if (!store) return { ok: false, reason: 'not_kept' };
  try {
    store.setItem(keyOf(owner), JSON.stringify(checklist));
  } catch {
    return { ok: false, reason: 'not_kept' };
  }
  return { ok: true, checklist };
}

/** Whether the checklist holds this order: only an opening order, and only while it is on. */
export const holdsOrder = (checklist: Checklist, order: { reduceOnly: boolean }): boolean =>
  checklist.on && checklist.items.length > 0 && !order.reduceOnly;

/** The first item not ticked, or null when every item is. */
export function firstUnticked(checklist: Checklist, ticked: ReadonlySet<number>): string | null {
  const i = checklist.items.findIndex((_, n) => !ticked.has(n));
  return i === -1 ? null : checklist.items[i]!;
}

/** The browser's device storage, or null where it cannot be reached. */
export function deviceStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
