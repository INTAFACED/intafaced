/** The private note on an activity line: the service keeps 1 to 500 characters of plain text, so the screen says so first. */
export const NOTE_MAX = 500;

export type NoteProblem = 'empty' | 'tooLong' | 'control' | 'unchanged';

/** What is wrong with the text about to be saved, or null when it can go. `saved` is the note already stored. */
export function noteProblem(text: string, saved: string | undefined): NoteProblem | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'empty';
  if (/[\u0000-\u001F]/.test(trimmed)) return 'control';
  if (trimmed.length > NOTE_MAX) return 'tooLong';
  if (trimmed === saved) return 'unchanged';
  return null;
}
