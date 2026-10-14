/**
 * Which result of "open this enquiry" may reach the screen.
 *
 * Several opens can be in flight at once: the founder clicks a row while a focus or 60-second background refresh is still
 * loading the previous one. Only the latest call may apply its result, and a background (silent) call may also only apply
 * while its enquiry is still the one on screen. Framework-free so the rules can be tested without a browser.
 */
export type OpenDecision = { apply: false } | { apply: true; changedRecord: boolean; showMobileDetail: boolean };

export function createOpenGate() {
  let latest = 0;
  let selected = '';
  return {
    /** Call when an open starts. Every earlier call is stale from now on. */
    begin(): number {
      return ++latest;
    },
    /** True while no newer open has started. */
    isCurrent(call: number): boolean {
      return call === latest;
    },
    /** The enquiry id currently on screen, or ''. */
    selected(): string {
      return selected;
    },
    /** Call when the detail is cleared (a failed open with nothing to keep). */
    clear(): void {
      selected = '';
    },
    /**
     * Call when the result arrives. `apply: false` means drop it: a newer open started, or a silent refresh finished
     * after the founder moved to another enquiry. The phone detail view opens only for a non-silent open, so a background
     * refresh never re-shows an enquiry the founder backed out of. `reveal: false` (a manual Refresh) applies the result
     * but leaves the phone on whichever view the founder chose.
     */
    settle(call: number, id: string, silent: boolean, reveal = true): OpenDecision {
      if (call !== latest) return { apply: false };
      if (silent && selected !== id) return { apply: false };
      const changedRecord = selected !== id;
      selected = id;
      return { apply: true, changedRecord, showMobileDetail: !silent && reveal };
    },
  };
}

type DraftSource = {
  opportunity: { ownerUserId: string; stage: string; nextAction?: { description: string; dueAt: string } | null };
};
type DiscardSource = DraftSource & { opportunity: { id: string; revision: number } };
/**
 * What a Discard puts back: every field from the record on screen NOW, and a base revision equal to that record's. Callers pass
 * the latest record (read through a ref), never one captured when the question was asked, because the founder can save while
 * the question is open and the record moves on.
 */
export function formAfterDiscard(detail: DiscardSource, toLocalDate: (iso: string) => string) {
  const fields = draftOf(detail, toLocalDate);
  return {
    ...fields,
    editDescription: fields.actionDescription,
    editDue: fields.actionDue,
    base: { id: detail.opportunity.id, revision: detail.opportunity.revision },
  };
}
/** The editable fields an enquiry opens with. `toLocalDate` turns an ISO due time into the date field's value. */
export function draftOf(detail: DraftSource, toLocalDate: (iso: string) => string) {
  const next = detail.opportunity.nextAction;
  return {
    newOwner: detail.opportunity.ownerUserId,
    newStage: detail.opportunity.stage,
    actionDescription: next?.description ?? '',
    actionDue: next?.dueAt ? toLocalDate(next.dueAt) : '',
  };
}

/** The next action as the form shows it: description text and the local date field's value. */
export type ActionValue = { description: string; due: string };
/** The four fields that mirror the record's next action: the header editor's pair and the stage form's follow-up pair. */
export type ActionFields = { editDescription: string; editDue: string; actionDescription: string; actionDue: string };

/**
 * Which values the next-action fields hold after a refresh of the SAME enquiry.
 *
 * A field that still equals what was loaded last time was never touched by the founder, so it follows the record: a change
 * made elsewhere (the Tasks tab, a stage change, a logged call) shows up in the editor, Save stays disabled and the field no
 * longer counts as an unsaved edit. A field the founder typed into is kept, so their draft is never overwritten and never
 * re-sent in place of a newer record. `loaded` is what the fields were set to when the previous record arrived; `next` is
 * what the refreshed record says.
 */
export function rebaseActionFields(current: ActionFields, loaded: ActionValue, next: ActionValue): ActionFields {
  return {
    editDescription: followRecord(current.editDescription, loaded.description, next.description),
    editDue: followRecord(current.editDue, loaded.due, next.due),
    actionDescription: followRecord(current.actionDescription, loaded.description, next.description),
    actionDue: followRecord(current.actionDue, loaded.due, next.due),
  };
}

/** One field's rule, usable as a React state updater so it reads the latest value even after a slow network call. */
export function followRecord(current: string, loaded: string, next: string): string {
  return current === loaded ? next : current;
}
