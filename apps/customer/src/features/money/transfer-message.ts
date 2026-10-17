/**
 * The note and the payment reference that can travel with a transfer.
 *
 * Both rules are the service's own: a note is plain text of up to 140 characters with no control characters, and a
 * reference is 1 to 64 printable ASCII characters. Blank means "none" and is simply left out of the request.
 */
export const NOTE_MAX = 140;
export const REFERENCE_MAX = 64;

/** Trimmed text, or undefined when nothing is left. The request carries a field only when the customer wrote one. */
export function cleanText(value: string | undefined | null): string | undefined {
  const text = value?.trim() ?? '';
  return text === '' ? undefined : text;
}

export function noteProblem(value: string | undefined | null): 'tooLong' | 'control' | null {
  const note = cleanText(value);
  if (note === undefined) return null;
  // Counted in UTF-16 units, as the bank's own check counts them, so an accepted note is never refused later.
  if (note.length > NOTE_MAX) return 'tooLong';
  return /[\u0000-\u001F\u007F]/.test(note) ? 'control' : null;
}

export function referenceProblem(value: string | undefined | null): 'tooLong' | 'characters' | null {
  const reference = cleanText(value);
  if (reference === undefined) return null;
  if (reference.length > REFERENCE_MAX) return 'tooLong';
  return /^[\x20-\x7E]+$/.test(reference) ? null : 'characters';
}

/** Did the service store exactly the note and reference that were reviewed? `null` on the wire means none. */
export function messageEchoed(
  data: { note?: string | null | undefined; reference?: string | null | undefined },
  sent: { note?: string | undefined; reference?: string | undefined },
): boolean {
  return (data.note ?? null) === (cleanText(sent.note) ?? null) && (data.reference ?? null) === (cleanText(sent.reference) ?? null);
}
