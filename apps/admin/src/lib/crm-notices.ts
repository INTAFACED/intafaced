/**
 * What the open enquiry's notice area shows, so an edit and the message about it sit together and a founder never reads
 * three messages about one draft. Order is the order on screen.
 */
export const RESTORED_EDITS_NOTICE = 'Restored your unsaved edits from before the reload.';
export const SAVED_NOTICE = 'Saved to the enquiry history.';
export const RETAINED_EDITS_NOTICE = 'Unsaved edits are retained while you review this enquiry.';

export type DetailNoticeKind = 'error' | 'stale' | 'notice' | 'retained';
export type DetailNoticeInput = {
  /** A failed save or read for this enquiry. */
  error: string;
  /** "Saved", "Restored your unsaved edits", and similar. */
  notice: string;
  /** The form is based on an older revision than the record on screen. */
  stale: boolean;
  /** There are unsaved edits. */
  dirty: boolean;
};

/**
 * - An error always shows, and so does the stale warning (a refused save and "the record has changed" are different facts).
 * - The stale warning replaces any saved / restored / retained notice, because those would only repeat or contradict it.
 * - The "retained" hint is the quietest message: it shows only when nothing else does.
 */
export function detailNotices({ error, notice, stale, dirty }: DetailNoticeInput): DetailNoticeKind[] {
  const shown: DetailNoticeKind[] = [];
  if (error) shown.push('error');
  if (stale) shown.push('stale');
  else if (!error && notice) shown.push('notice');
  else if (!error && dirty) shown.push('retained');
  return shown;
}
