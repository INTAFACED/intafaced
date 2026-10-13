/**
 * The "discard your unsaved edits?" question, asked inside the page instead of in the browser's own dialog.
 *
 * `ask` returns a promise that settles when the founder answers, so the callers keep their shape: `if (!(await ask(...))) return`.
 * Only one question is open at a time. Asking again replaces it, and the replaced question counts as "keep editing", so
 * edits are never discarded by a question the founder did not answer.
 */
export type DiscardQuestion = { id: number; prompt: string };

/**
 * A save while the question is open answers it as "Keep editing". The form stays live behind the bar, so a save followed by a
 * late Discard would otherwise reset the form from the record as it was when the question was asked. Returns true when a
 * question was open and has now been closed.
 */
export function keepEditingBeforeSave(confirm: { pending(): boolean; answer(discard: boolean): void }): boolean {
  if (!confirm.pending()) return false;
  confirm.answer(false);
  return true;
}

export function createDiscardConfirm(onChange: (question: DiscardQuestion | null) => void) {
  let counter = 0;
  let open: { question: DiscardQuestion; settle: (discard: boolean) => void } | null = null;
  const close = (discard: boolean) => {
    const current = open;
    if (!current) return;
    open = null;
    onChange(null);
    current.settle(discard);
  };
  return {
    ask(prompt: string): Promise<boolean> {
      if (open) close(false);
      const question = { id: ++counter, prompt };
      return new Promise<boolean>((settle) => {
        open = { question, settle };
        onChange(question);
      });
    },
    /** The founder chose Discard (true) or Keep editing (false). Ignored when no question is open. */
    answer(discard: boolean): void {
      close(discard);
    },
    /** True while a question waits for an answer. */
    pending(): boolean {
      return open !== null;
    },
  };
}
