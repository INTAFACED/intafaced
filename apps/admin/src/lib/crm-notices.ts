/**
 * What the open enquiry's notice area shows, so an edit and the message about it sit together and a founder never reads
 * three messages about one draft. Order is the order on screen.
 */
export const RESTORED_EDITS_NOTICE = 'Restored your unsaved edits from before the reload.';
export const SAVED_NOTICE = 'Saved to the enquiry history.';
export const RETAINED_EDITS_NOTICE = 'Unsaved edits are retained while you review this enquiry.';

/** Shown when leaving the enquiry is refused because a retention review result still has to be confirmed. */
export const RETENTION_BLOCKED_NOTICE = 'A retention review result is unconfirmed. Retry that same request before leaving this enquiry.';

/** 'stale_refused' is the stale warning for a draft whose save was just refused: it leads with "Your save was refused." */
export type DetailNoticeKind = 'error' | 'blocked' | 'stale' | 'stale_refused' | 'notice' | 'retained';
/** Same meaning as CrmErrorKind: session = 401/403, conflict = 409/412 (changed or refused), other = anything else. */
export type DetailErrorKind = 'session' | 'conflict' | 'other';
export type DetailNoticeInput = {
  /** A failed save or read for this enquiry. */
  error: string;
  /** What kind of failure `error` is. A conflict while the draft is stale is folded into the stale warning. */
  errorKind?: DetailErrorKind;
  /** "Saved", "Restored your unsaved edits", and similar. */
  notice: string;
  /** A click on another enquiry, view or Back was refused (see RETENTION_BLOCKED_NOTICE). It explains why nothing happened. */
  blocked?: boolean;
  /** The form is based on an older revision than the record on screen. */
  stale: boolean;
  /** There are unsaved edits. */
  dirty: boolean;
};

/**
 * - An error shows, and so does the stale warning, except that a conflict error (changed or refused) while the draft is stale is the
 *   same fact the stale warning already states: one amber box leads with "Your save was refused." and offers the one action.
 *   Any other error (a 500, a network failure, a lost session) is a different fact and shows as well.
 * - The "blocked" message is the answer to a click that otherwise does nothing, so it is never hidden behind another notice.
 * - The stale warning replaces any saved / restored / retained notice, because those would only repeat or contradict it.
 * - The "retained" hint is the quietest message: it shows only when nothing else does.
 */
export function detailNotices({
  error,
  errorKind = 'other',
  notice,
  stale,
  dirty,
  blocked = false,
}: DetailNoticeInput): DetailNoticeKind[] {
  const shown: DetailNoticeKind[] = [];
  const refusedWhileStale = Boolean(error) && stale && errorKind === 'conflict';
  if (error && !refusedWhileStale) shown.push('error');
  if (blocked) shown.push('blocked');
  if (stale) shown.push(refusedWhileStale ? 'stale_refused' : 'stale');
  else if (!error && notice) shown.push('notice');
  else if (!error && dirty) shown.push('retained');
  return shown;
}
