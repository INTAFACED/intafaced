/**
 * The person's saved workspaces on this device, per user (PRO-TERMINAL-PLAN section 3: "Saved on this device";
 * syncing across devices waits for the back-end settings store, T-BE4).
 *
 * `WorkspaceBook` is the whole saved state: up to ten named workspaces and which one is open. Every function here is
 * pure (state in, state out) except `loadBook` and `saveBook`, which take the storage as a parameter so they can be
 * tested without a browser and never throw when storage is blocked (private windows, quota, site data cleared).
 */
import { DEFAULT_PRESET, workspaceFromPreset } from './presets';
import { cleanName, MAX_WORKSPACES, pruneWorkspace, readWorkspace, type PresetId, type WorkspaceV1 } from './workspace';

export const BOOK_VERSION = 1 as const;

export interface WorkspaceBook {
  version: typeof BOOK_VERSION;
  /** The open workspace's id. Always one of `items`. */
  activeId: string;
  /** Slot order: slot 1 first. */
  items: WorkspaceV1[];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function bookKey(userId: string | null): string {
  return `intafaced.terminal.workspaces.v1:${userId ?? 'guest'}`;
}

export type NewId = () => string;
export const randomId: NewId = () => {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return 'ws-' + [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** First open: one workspace, Classic. */
export function freshBook(newId: NewId = randomId): WorkspaceBook {
  const first = workspaceFromPreset(DEFAULT_PRESET, newId());
  return { version: BOOK_VERSION, activeId: first.id, items: [first] };
}

/**
 * Read the saved book. Anything unreadable falls back quietly: a workspace that fails validation or that no longer
 * has any known panel is dropped (and the rest kept), and if nothing is left the person gets Classic again.
 */
export function loadBook(
  storage: StorageLike | null,
  userId: string | null,
  isKnownType: (type: string) => boolean,
  newId: NewId = randomId,
): WorkspaceBook {
  try {
    const text = storage?.getItem(bookKey(userId)) ?? null;
    if (text) {
      const raw: unknown = JSON.parse(text);
      if (typeof raw === 'object' && raw !== null && (raw as { version?: unknown }).version === BOOK_VERSION) {
        const { activeId, items } = raw as { activeId?: unknown; items?: unknown };
        if (Array.isArray(items)) {
          const seen = new Set<string>();
          const kept: WorkspaceV1[] = [];
          for (const item of items.slice(0, MAX_WORKSPACES)) {
            const read = readWorkspace(item);
            if (!read.ok || seen.has(read.workspace.id)) continue;
            const safe = pruneWorkspace(read.workspace, isKnownType);
            if (!safe) continue;
            seen.add(safe.id);
            kept.push(safe);
          }
          if (kept.length > 0)
            return {
              version: BOOK_VERSION,
              activeId: kept.some((item) => item.id === activeId) ? (activeId as string) : kept[0]!.id,
              items: kept,
            };
        }
      }
    }
  } catch {
    /* unreadable or blocked: start fresh */
  }
  return freshBook(newId);
}

/** Write the book. Returns false when the browser refused (the desk keeps working, it just will not remember). */
export function saveBook(storage: StorageLike | null, userId: string | null, book: WorkspaceBook): boolean {
  try {
    if (!storage) return false;
    storage.setItem(bookKey(userId), JSON.stringify(book));
    return true;
  } catch {
    return false;
  }
}

export function activeWorkspace(book: WorkspaceBook): WorkspaceV1 {
  return book.items.find((item) => item.id === book.activeId) ?? book.items[0]!;
}

/** Replace one workspace (a drag, a resize, the lock). */
export function updateWorkspace(book: WorkspaceBook, next: WorkspaceV1): WorkspaceBook {
  return { ...book, items: book.items.map((item) => (item.id === next.id ? next : item)) };
}

export function openWorkspace(book: WorkspaceBook, id: string): WorkspaceBook {
  return book.items.some((item) => item.id === id) ? { ...book, activeId: id } : book;
}

/** "Scalper", then "Scalper 2", "Scalper 3": names stay readable and distinct. */
export function uniqueName(book: WorkspaceBook, wanted: string): string {
  const base = cleanName(wanted) || 'Workspace';
  const taken = new Set(book.items.map((item) => item.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 100; n += 1) {
    const suffix = ` ${n}`;
    const candidate = base.slice(0, 32 - suffix.length) + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

export function canAddWorkspace(book: WorkspaceBook): boolean {
  return book.items.length < MAX_WORKSPACES;
}

/** A new workspace from a preset, opened. Refused (book unchanged) at the limit. */
export function addFromPreset(book: WorkspaceBook, preset: PresetId, newId: NewId = randomId): WorkspaceBook {
  if (!canAddWorkspace(book)) return book;
  const made = workspaceFromPreset(preset, newId());
  const named = { ...made, name: uniqueName(book, made.name) };
  return { ...book, activeId: named.id, items: [...book.items, named] };
}

/** "Save as": a copy of the open layout under a new name, opened. Refused at the limit. */
export function saveAs(book: WorkspaceBook, name: string, newId: NewId = randomId): WorkspaceBook {
  if (!canAddWorkspace(book)) return book;
  const copy: WorkspaceV1 = { ...activeWorkspace(book), id: newId(), name: uniqueName(book, name) };
  return { ...book, activeId: copy.id, items: [...book.items, copy] };
}

export function renameWorkspace(book: WorkspaceBook, id: string, name: string): WorkspaceBook {
  const clean = cleanName(name);
  if (!clean) return book;
  const others = { ...book, items: book.items.filter((item) => item.id !== id) };
  return { ...book, items: book.items.map((item) => (item.id === id ? { ...item, name: uniqueName(others, clean) } : item)) };
}

/** Delete one. The last workspace cannot be deleted; deleting the open one opens its neighbour. */
export function deleteWorkspace(book: WorkspaceBook, id: string): WorkspaceBook {
  if (book.items.length <= 1) return book;
  const index = book.items.findIndex((item) => item.id === id);
  if (index < 0) return book;
  const items = book.items.filter((item) => item.id !== id);
  const activeId = book.activeId === id ? items[Math.min(index, items.length - 1)]!.id : book.activeId;
  return { ...book, activeId, items };
}

/** Put the open workspace back to a preset's layout, keeping its id and name, and unlocking it. */
export function applyPreset(book: WorkspaceBook, preset: PresetId): WorkspaceBook {
  const current = activeWorkspace(book);
  const fresh = workspaceFromPreset(preset, current.id, current.name);
  return updateWorkspace(book, fresh);
}

/** "Reset to preset": the open workspace's own starting layout. Null when it has none (nothing to reset to). */
export function resetToPreset(book: WorkspaceBook): WorkspaceBook | null {
  const current = activeWorkspace(book);
  return current.preset ? applyPreset(book, current.preset) : null;
}

export function setLocked(book: WorkspaceBook, locked: boolean): WorkspaceBook {
  const current = activeWorkspace(book);
  return current.locked === locked ? book : updateWorkspace(book, { ...current, locked });
}
