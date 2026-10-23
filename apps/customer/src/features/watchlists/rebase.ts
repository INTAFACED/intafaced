/**
 * The write path of an account record, without React. A write is an updater: it runs on the record as it stands at send time and
 * its result is stored with compare-and-set on the version it was computed from. On a version conflict the newer record is read,
 * the updater runs again on it, and the write is sent once more. A second conflict is reported, not looped on.
 */

export type CommitOutcome = { ok: true } | { ok: false; code: string };
export type RecordUpdate<T> = (latest: T) => T;

export const CONFLICT = 'preferences.version_conflict';

export type WriteReply<T> = { ok: true; version: number; value: T | null } | { ok: false; code: string };

export interface RecordIo<T> {
  /** The newest record, or null when the read fails. */
  read(): Promise<{ version: number; value: T | null } | null>;
  /** Stores `next` if the account is still at `ifVersion`. */
  write(next: T, ifVersion: number): Promise<WriteReply<T>>;
}

export interface WriteResult<T> {
  outcome: CommitOutcome;
  /** The record to show after the write: the stored one, or the newer one a conflict read. Absent when nothing was read or stored. */
  record?: { version: number; value: T };
  /** The newest record could not be read, so the caller must show the error and stop writing. */
  readFailed?: boolean;
}

/** Runs one change over `start`, with one rebase on a conflict. `empty` stands for a null record. */
export async function rebaseAndWrite<T>(
  start: { version: number; value: T },
  io: RecordIo<T>,
  update: RecordUpdate<T>,
  empty: T,
): Promise<WriteResult<T>> {
  let base = start;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const next = update(base.value);
    const reply = await io.write(next, base.version);
    if (reply.ok) return { outcome: { ok: true }, record: { version: reply.version, value: reply.value ?? empty } };
    if (reply.code !== CONFLICT) return { outcome: { ok: false, code: reply.code } };
    const latest = await io.read();
    if (!latest) return { outcome: { ok: false, code: CONFLICT }, readFailed: true };
    base = { version: latest.version, value: latest.value ?? empty };
  }
  return { outcome: { ok: false, code: CONFLICT }, record: base };
}
