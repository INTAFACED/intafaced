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
