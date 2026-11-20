'use client';
/**
 * The CRM's unsaved edits kept in this tab's browser storage (crm-drafts.ts) while they exist: written whenever the kept
 * fields or the revision they were written against change, and cleared as soon as nothing is left to keep (after a save or
 * a discard). Nothing is written or cleared while `paused` (no enquiry open, or a save in flight, so a half-finished save
 * never leaves its own values behind). A newly loaded record or a new base revision writes the draft again, so its saved
 * time is the last time it was compared with what is on screen.
 */
import { useEffect } from 'react';
import { browserDraftStorage, clearDraft, saveDraft, type DraftValues } from '../crm-drafts';

export type KeptDraft = { enquiryId: string; userId: string; revision: number; fields: Partial<DraftValues> | null };

export function useKeptDraft(draft: KeptDraft | null, paused: boolean, { record, base }: { record: unknown; base: unknown }): void {
  const signature = draft ? JSON.stringify(draft) : '';
  useEffect(() => {
    if (paused || !signature) return;
    const { enquiryId, userId, revision, fields } = JSON.parse(signature) as KeptDraft;
    const storage = browserDraftStorage();
    if (fields) saveDraft(storage, { enquiryId, userId, revision, fields });
    else clearDraft(storage, enquiryId);
  }, [signature, paused, record, base]);
}
