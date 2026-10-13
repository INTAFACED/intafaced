/**
 * The record revision the open form is based on, which every save sends as `expectedRevision`.
 *
 * It is NOT always the revision on screen. Edits restored from an earlier visit were typed against the revision stored with
 * them; if another founder has saved since, the restored form must still send that older revision so the server refuses the
 * save and the founder is taken through "Reload this enquiry", instead of silently overwriting the newer record.
 */
export type BaseRevisionChange =
  /** A different enquiry was opened. `kept` is the revision stored with restored edits, or null when nothing was restored. */
  | { kind: 'open'; loaded: number; kept: number | null }
  /** The founder confirmed "discard and reload": the form was reset onto the newest record. */
  | { kind: 'rebase'; loaded: number }
  /** The founder's own write succeeded, so the record they just changed is the base. */
  | { kind: 'saved'; loaded: number }
  /** The same enquiry was read again. Typed edits keep their base; a clean form follows the record. */
  | { kind: 'refresh'; previous: number; loaded: number; formDirty: boolean };

export function nextBaseRevision(change: BaseRevisionChange): number {
  switch (change.kind) {
    case 'open':
      return change.kept ?? change.loaded;
    case 'rebase':
    case 'saved':
      return change.loaded;
    case 'refresh':
      return change.formDirty ? change.previous : change.loaded;
  }
}

export type BaseRevision = { id: string; revision: number };

/** The revision a save sends: the tracked base for this enquiry, else the one on screen. */
export function expectedRevisionFor(base: BaseRevision | null, openId: string, onScreen: number): number {
  return base && base.id === openId ? base.revision : onScreen;
}

/**
 * True while the form is based on an older revision than the record on screen (restored edits, or typed edits whose
 * record changed elsewhere). It stays true until the founder discards the edits or a save succeeds, so the warning cannot
 * be wiped by an unrelated notice.
 */
export function baseIsStale(base: BaseRevision | null, openId: string, onScreen: number): boolean {
  return expectedRevisionFor(base, openId, onScreen) !== onScreen;
}
