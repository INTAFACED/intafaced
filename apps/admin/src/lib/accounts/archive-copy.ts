import type { AccountArchiveState } from '@intafaced/contracts';

/**
 * What every edit control on an archived record says (J-ops-console-04 #10): when it was archived, and that the record is
 * read-only for good. Null while the record is not archived.
 */
export function archivedNote(state: Pick<AccountArchiveState, 'archivedAt'> | null | undefined): string | null {
  if (!state?.archivedAt) return null;
  return `Archived on ${state.archivedAt.slice(0, 10)}: identity keeps this record read-only, so it cannot be frozen, unfrozen, reopened, moved to another tier or archived again (identity.account_archived).`;
}
