/** The bank builds a statement for one UTC calendar month (a PDF must be one; a CSV may be wider, but the screen offers months). */
export type StatementRange = { from: string; to: string };

/** "2026-10" to its first and last millisecond in UTC, or null when the text is not a real month. */
export function monthRange(month: string): StatementRange | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  const start = Date.UTC(year, index, 1);
  const end = Date.UTC(year, index + 1, 1) - 1;
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}

/** The month a person is most likely to want: the last one that is over, as "YYYY-MM" in UTC. */
export function lastFullMonth(now: Date): string {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Whether a month is still running or has not started: such a statement would be incomplete. */
export function monthIsOver(month: string, now: Date): boolean {
  const range = monthRange(month);
  return range !== null && Date.parse(range.to) < now.getTime();
}

/** The bytes of a base64 string, or null when it is not valid base64. */
export function decodeBase64(text: string): Uint8Array | null {
  try {
    const raw = atob(text);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** The first 12 characters of the file's SHA-256, grouped for reading aloud to support. */
export function shortFingerprint(sha256: string): string {
  return (sha256.match(/.{1,4}/g) ?? []).slice(0, 3).join(' ');
}
