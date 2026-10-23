import { SUPPORT_MERGE_REASON_MAX, supportMergePreviewSchema, type SupportMergePreview } from '@intafaced/contracts/support-merge';
import { isTicketId, type ActionGate } from './model';

/**
 * Merging a duplicate request into the one that stays, as the console reads and sends it.
 *
 * A merge cannot be undone: the source's messages and files move under the survivor and the source ends closed. The
 * console therefore reads what would move first (`previewMerge`), shows it, and sends only after a second, plainly
 * worded click. A reason is required and is kept in the log of both requests.
 */

export const MERGE_REASON_MAX = SUPPORT_MERGE_REASON_MAX;

/** The preview as svc-support answered it, or null when the answer is not exactly that shape. */
export function readMergePreview(raw: unknown): SupportMergePreview | null {
  const parsed = supportMergePreviewSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export interface MergeForm {
  readonly survivorId: string;
  readonly reason: string;
}

export const emptyMergeForm: MergeForm = { survivorId: '', reason: '' };

/** Whether the form is complete enough to read a preview for: a different request, named by its id. */
export function mergeTargetGate(sourceId: string, form: MergeForm): ActionGate {
  const id = form.survivorId.trim();
  if (!isTicketId(id)) return { ok: false, why: 'Paste the id of the request that stays (the full ticket id).' };
  if (id === sourceId) return { ok: false, why: 'A request cannot be merged into itself.' };
  return { ok: true };
}

/** Whether the merge may be armed: a complete target, a reason, and a preview that did not refuse. */
export function mergeGate(sourceId: string, form: MergeForm, preview: SupportMergePreview | null, busy: boolean): ActionGate {
  if (busy) return { ok: false, why: 'A step is already in progress.' };
  const target = mergeTargetGate(sourceId, form);
  if (!target.ok) return target;
  const reason = form.reason.trim();
  if (reason === '') return { ok: false, why: 'A reason is required. It is kept in the log of both requests.' };
  if (reason.length > MERGE_REASON_MAX) return { ok: false, why: `The reason can be at most ${MERGE_REASON_MAX} characters.` };
  if (!preview || preview.survivorId !== form.survivorId.trim() || preview.sourceId !== sourceId) {
    return { ok: false, why: 'Read what would move first.' };
  }
  if (preview.refusal !== null) return { ok: false, why: 'svc-support would refuse this merge. Nothing can be sent.' };
  return { ok: true };
}

/** What a merge would do, in words for the confirmation. */
export function mergeConsequence(preview: SupportMergePreview): string {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const stays = [preview.staysOnSource.rating ? 'its rating' : null, preview.staysOnSource.caseFile ? 'its case file' : null].filter(
    (v): v is string => v !== null,
  );
  return [
    `${n(preview.commentsToMove, 'message', 'messages')} and ${n(preview.attachmentsToMove, 'file', 'files')} move under the request that stays.`,
    'The duplicate is closed and links to it.',
    stays.length > 0 ? `The duplicate keeps ${stays.join(' and ')}.` : 'The duplicate has no rating or case file to keep.',
    'This cannot be undone.',
  ].join(' ');
}

export const MERGE_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  'support.merge_not_allowed':
    'Both requests must be open, pending or on hold and belong to the same customer account. One of them is not, or the duplicate was already merged elsewhere.',
  'support.merge_same_ticket': 'A request cannot be merged into itself.',
};
