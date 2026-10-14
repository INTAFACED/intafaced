import { describe, expect, it } from 'vitest';
import {
  activeWorkspace,
  addFromPreset,
  applyPreset,
  bookKey,
  canAddWorkspace,
  deleteWorkspace,
  freshBook,
  loadBook,
  openWorkspace,
  renameWorkspace,
  resetToPreset,
  saveAs,
  saveBook,
  setLocked,
  uniqueName,
  updateWorkspace,
  type StorageLike,
} from './store';
import { workspaceFromPreset } from './presets';
import { MAX_WORKSPACES, panelsOf } from './workspace';

const known = (type: string) => ['markets', 'chart', 'orderbook', 'trades', 'ticket', 'orders'].includes(type);
const counter = () => {
  let n = 0;
  return () => `ws-${(n += 1).toString().padStart(4, '0')}`;
};
function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}
const blockedStorage: StorageLike = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('quota');
  },
};

describe('first open', () => {
  it('is one workspace, Classic', () => {
    const book = freshBook(counter());
    expect(book.items).toHaveLength(1);
    expect(activeWorkspace(book)).toMatchObject({ name: 'Classic', preset: 'classic', locked: false });
  });

  it('loads Classic when nothing is saved, in a private window, or when storage throws', () => {
    for (const storage of [memoryStorage(), null, blockedStorage]) {
      const book = loadBook(storage, 'user-1', known, counter());
      expect(activeWorkspace(book).preset).toBe('classic');
    }
  });
});

describe('save, restore and reset', () => {
  it('saves per user and restores exactly', () => {
    const storage = memoryStorage();
    let book = freshBook(counter());
    book = addFromPreset(book, 'scalper', counter());
    const edited = { ...activeWorkspace(book), locked: true };
    book = updateWorkspace(book, edited);
    expect(saveBook(storage, 'user-1', book)).toBe(true);
    expect(Object.keys(storage.data)).toEqual([bookKey('user-1')]);

    const restored = loadBook(storage, 'user-1', known);
    expect(restored).toEqual(book);
    // Another user on the same device has their own desk.
    expect(activeWorkspace(loadBook(storage, 'user-2', known)).preset).toBe('classic');
    expect(loadBook(storage, 'user-2', known).items).toHaveLength(1);
    // A signed-out visitor too.
    expect(bookKey(null)).toContain('guest');
  });

  it('says so when the browser refuses to save', () => {
    expect(saveBook(blockedStorage, 'u', freshBook())).toBe(false);
    expect(saveBook(null, 'u', freshBook())).toBe(false);
  });

  it('survives a stored book that is damaged: it keeps the good workspaces and drops the rest', () => {
    const good = freshBook(counter());
    const bad = { ...good.items[0]!, id: 'ws-bad', name: '' };
    const storage = memoryStorage({ [bookKey('u')]: JSON.stringify({ ...good, items: [bad, good.items[0]] }) });
    const book = loadBook(storage, 'u', known);
    expect(book.items.map((item) => item.id)).toEqual([good.items[0]!.id]);
    for (const text of [
      'not json',
      '{}',
      '[]',
      'null',
      JSON.stringify({ version: 2, items: [] }),
      JSON.stringify({ version: 1, items: 'x' }),
    ]) {
      expect(activeWorkspace(loadBook(memoryStorage({ [bookKey('u')]: text }), 'u', known)).preset).toBe('classic');
    }
  });

  it('opens the first workspace when the saved active id no longer exists, and never keeps duplicate ids', () => {
    const book = freshBook(counter());
    const twin = { ...book, activeId: 'gone', items: [book.items[0]!, book.items[0]!] };
    const restored = loadBook(memoryStorage({ [bookKey('u')]: JSON.stringify(twin) }), 'u', known);
    expect(restored.items).toHaveLength(1);
    expect(restored.activeId).toBe(book.items[0]!.id);
  });

  it('drops panels this build does not know, and falls back to Classic if that leaves nothing', () => {
    const book = freshBook(counter());
    const stored = memoryStorage({ [bookKey('u')]: JSON.stringify(book) });
    const nothing = loadBook(stored, 'u', () => false);
    expect(activeWorkspace(nothing).preset).toBe('classic');
    expect(panelsOf(activeWorkspace(nothing).tree).length).toBeGreaterThan(0);
    const fewer = loadBook(stored, 'u', (type) => type !== 'trades');
    expect(panelsOf(activeWorkspace(fewer).tree).map((panel) => panel.type)).not.toContain('trades');
  });

  it('reset to preset goes back to the starting layout, keeping the id and name, and unlocks', () => {
    let book = freshBook(counter());
    const original = activeWorkspace(book);
    // The person closes a panel and locks the desk.
    const changed = { ...original, locked: true, tree: workspaceFromPreset('minimal', original.id).tree };
    book = updateWorkspace(book, changed);
    expect(activeWorkspace(book).tree).not.toEqual(original.tree);
    const reset = resetToPreset(book)!;
    expect(activeWorkspace(reset)).toEqual(original);
    expect(activeWorkspace(reset).locked).toBe(false);
  });

  it('has nothing to reset to when a workspace has no preset', () => {
    let book = freshBook();
    book = updateWorkspace(book, { ...activeWorkspace(book), preset: null });
    expect(resetToPreset(book)).toBeNull();
  });

  it('applies a preset in place', () => {
    const book = applyPreset(freshBook(counter()), 'minimal');
    expect(activeWorkspace(book)).toMatchObject({ preset: 'minimal', name: 'Classic', id: 'ws-0001' });
    expect(panelsOf(activeWorkspace(book).tree).map((panel) => panel.type)).toEqual(['chart', 'ticket', 'orders']);
  });
});

describe('several named workspaces', () => {
  it('adds from a preset, names them apart, and opens the new one', () => {
    const newId = counter();
    let book = freshBook(newId);
    book = addFromPreset(book, 'classic', newId);
    book = addFromPreset(book, 'classic', newId);
    book = addFromPreset(book, 'scalper', newId);
    expect(book.items.map((item) => item.name)).toEqual(['Classic', 'Classic 2', 'Classic 3', 'Scalper']);
    expect(activeWorkspace(book).name).toBe('Scalper');
    expect(new Set(book.items.map((item) => item.id)).size).toBe(4);
  });

  it('stops at ten', () => {
    const newId = counter();
    let book = freshBook(newId);
    for (let i = 0; i < 20; i += 1) book = addFromPreset(book, 'minimal', newId);
    expect(book.items).toHaveLength(MAX_WORKSPACES);
    expect(canAddWorkspace(book)).toBe(false);
    expect(saveAs(book, 'More', newId)).toBe(book);
  });

  it('saves a copy under a new name, with the same layout', () => {
    const newId = counter();
    let book = freshBook(newId);
    book = applyPreset(book, 'scalper');
    const copy = saveAs(book, 'Night desk', newId);
    expect(copy.items.map((item) => item.name)).toEqual(['Classic', 'Night desk']);
    expect(activeWorkspace(copy).tree).toEqual(book.items[0]!.tree);
    expect(activeWorkspace(copy).id).not.toBe(book.items[0]!.id);
  });

  it('renames, keeping names distinct, and refuses an empty name', () => {
    const newId = counter();
    let book = addFromPreset(freshBook(newId), 'scalper', newId);
    const [first, second] = book.items;
    book = renameWorkspace(book, second!.id, 'Classic');
    expect(book.items.find((item) => item.id === second!.id)!.name).toBe('Classic 2');
    expect(renameWorkspace(book, first!.id, '   ')).toBe(book);
    expect(renameWorkspace(book, first!.id, '  Fast   hands ').items[0]!.name).toBe('Fast hands');
    expect(uniqueName(book, 'x'.repeat(40)).length).toBeLessThanOrEqual(32);
  });

  it('deletes one, opens its neighbour, and never deletes the last', () => {
    const newId = counter();
    let book = freshBook(newId);
    book = addFromPreset(book, 'scalper', newId);
    book = addFromPreset(book, 'minimal', newId);
    const [a, b, c] = book.items;
    book = openWorkspace(book, b!.id);
    const after = deleteWorkspace(book, b!.id);
    expect(after.items.map((item) => item.id)).toEqual([a!.id, c!.id]);
    expect(after.activeId).toBe(c!.id);
    const last = deleteWorkspace(deleteWorkspace(after, a!.id), c!.id);
    expect(last.items).toHaveLength(1);
    expect(deleteWorkspace(last, last.items[0]!.id)).toBe(last);
    expect(openWorkspace(last, 'missing')).toBe(last);
  });

  it('locks and unlocks the open workspace only', () => {
    const newId = counter();
    let book = addFromPreset(freshBook(newId), 'minimal', newId);
    book = setLocked(book, true);
    expect(book.items.map((item) => item.locked)).toEqual([false, true]);
    expect(setLocked(book, true)).toBe(book);
  });
});
