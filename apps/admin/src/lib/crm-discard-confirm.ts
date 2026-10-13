/**
 * The "discard your unsaved edits?" question, asked inside the page instead of in the browser's own dialog.
 *
 * `ask` returns a promise that settles when the founder answers, so the callers keep their shape: `if (!(await ask(...))) return`.
 * Only one question is open at a time. Asking again replaces it, and the replaced question counts as "keep editing", so
 * edits are never discarded by a question the founder did not answer.
 */
export type DiscardQuestion = { id: number; prompt: string };

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
