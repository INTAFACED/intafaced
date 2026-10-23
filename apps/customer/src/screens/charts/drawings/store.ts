/**
 * Where a person's drawings are kept: on this device, per person, workbench and symbol (the same pattern as the workbench's
 * own settings). A drawing is a display choice, never money, so browser storage is the right place; a write that fails is
 * reported, not dropped, and the caller shows "not saved" with a retry.
 */
import { EMPTY_DOC, parseDoc, type DrawingDoc } from './model';

export const drawingsKey = (userId: string | null, workbench: string, symbol: string): string =>
  `charts-drawings:${userId ?? 'guest'}:${workbench}:${symbol}`;

/** The stored document, or an empty one when nothing is stored, the storage is blocked, or the value is not valid. */
export function readDoc(storage: Pick<Storage, 'getItem'> | null, key: string): DrawingDoc {
  try {
    const raw = storage?.getItem(key) ?? null;
    if (raw === null) return EMPTY_DOC;
    return parseDoc(JSON.parse(raw)) ?? EMPTY_DOC;
  } catch {
    return EMPTY_DOC;
  }
}

/** True when the document is stored. A blocked or full storage returns false: the drawings stay on screen, marked not saved. */
export function writeDoc(storage: Pick<Storage, 'setItem'> | null, key: string, doc: DrawingDoc): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify(doc));
    return true;
  } catch {
    return false;
  }
}
