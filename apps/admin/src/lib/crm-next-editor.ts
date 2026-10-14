/**
 * The next-action editor in the enquiry header is collapsed behind a "Change" button. It must still open by itself when
 * it holds edits (typed, or restored after a reload), so no draft ever sits hidden.
 */
export type NextActionRecord = { description: string; dueAt: string } | null | undefined;

/** True when the editor's fields differ from the record. `toLocalDate` turns the record's ISO due time into the field's value. */
export function nextEditorDirty(
  record: NextActionRecord,
  fields: { description: string; due: string },
  toLocalDate: (iso: string) => string,
): boolean {
  if (!record) return false;
  return fields.description.trim() !== record.description || fields.due !== toLocalDate(record.dueAt);
}

/** Shown expanded when the founder opened it, or when it holds edits. */
export const nextEditorOpen = (openedByFounder: boolean, dirty: boolean): boolean => openedByFounder || dirty;
