/**
 * A transfer id as svc-bank takes one: a standing-order execution id (a UUID) or a client-chosen `transferId` of 8 to 64 characters
 * (`z.string().min(8).max(64)`, any characters). Trimmed first; no control characters, which no id has. It travels only inside the
 * JSON `input` of one fixed procedure, encoded, so it cannot choose a path or a procedure.
 */
export function transferIdOf(raw: string | null): string | null {
  const id = raw?.trim() ?? '';
  return id.length >= 8 && id.length <= 64 && !/\p{Cc}/u.test(id) ? id : null;
}
