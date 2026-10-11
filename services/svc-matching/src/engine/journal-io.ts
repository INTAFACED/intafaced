import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { encode, type EngineJournal, type JournalCommand, type JournalRecord } from './journal-codec.js';

export const JOURNAL_LOCKED = 'journal_locked' as const;

/** Second FileJournal on the same path — not a shared writer. */
export class FileJournalLockedError extends Error {
  readonly code = JOURNAL_LOCKED;

  constructor(readonly path: string) {
    super(`journal already has an exclusive writer: ${path}`);
    this.name = 'FileJournalLockedError';
  }
}

function writerLockPath(journalPath: string): string {
  return `${journalPath}.lock`;
}

function errnoCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = gone. EPERM = live but not ours — still a writer.
    return errnoCode(err) === 'EPERM';
  }
}

/** Nonces this process wrote. A live pid that is us, with a nonce we do not hold, is a dead container that reused pid 1. */
const heldLockNonces = new Set<string>();

function parseLock(raw: string): { pid: number; nonce: string | null } {
  const [pidLine, nonceLine] = raw.split('\n');
  return {
    pid: Number.parseInt((pidLine ?? '').trim(), 10),
    nonce: nonceLine?.trim() ? nonceLine.trim() : null,
  };
}

function canSteal(pid: number, nonce: string | null): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pidIsLive(pid) && pid !== process.pid) return false;
  if (pidIsLive(pid) && nonce !== null && heldLockNonces.has(nonce)) return false;
  return true;
}

const RECOVER_BARRIER_ENV = 'MATCHING_JOURNAL_LOCK_RECOVER_BARRIER';

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Unset in production. A test creates `release-${pid}` to let that recoverer continue. */
function waitForRecoverBarrier(): void {
  const barrier = process.env[RECOVER_BARRIER_ENV];
  if (!barrier) return;
  writeFileSync(`${barrier}/seen-${process.pid}`, '1');
  const release = `${barrier}/release-${process.pid}`;
  const deadline = Date.now() + 8_000;
  while (!existsSync(release)) {
    if (Date.now() > deadline) throw new Error('journal lock recover barrier timed out');
    sleepMs(10);
  }
}

function readFdText(fd: number): string {
  const buf = Buffer.alloc(256);
  const n = readSync(fd, buf, 0, buf.length, 0);
  return buf.subarray(0, n).toString('utf8');
}

/** Drop the directory entry only when it still names the inode with this nonce. */
function unlinkIfNonce(lockPath: string, expectedNonce: string | null): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, 'r');
  } catch (err) {
    return errnoCode(err) === 'ENOENT';
  }
  try {
    if (parseLock(readFdText(fd)).nonce !== expectedNonce) return false;
    const inode = fstatSync(fd);
    let pathStat: ReturnType<typeof statSync>;
    try {
      pathStat = statSync(lockPath);
    } catch (err) {
      return errnoCode(err) === 'ENOENT';
    }
    if (pathStat.ino !== inode.ino || pathStat.dev !== inode.dev) return false;
    unlinkSync(lockPath);
    return true;
  } finally {
    closeSync(fd);
  }
}

function recoverGatePath(lockPath: string): string {
  return `${lockPath}.recover`;
}

function tryEnterRecoverGate(lockPath: string): string | null {
  const gate = recoverGatePath(lockPath);
  try {
    mkdirSync(gate);
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') return null;
    throw err;
  }
  const nonce = randomBytes(8).toString('hex');
  try {
    writeFileSync(`${gate}/owner`, `${process.pid}\n${nonce}\n`, { flag: 'wx' });
  } catch (err) {
    try {
      rmdirSync(gate);
    } catch {
      /* Preserve an ownership entry we did not create. */
    }
    throw err;
  }
  // A stale gate refuses. Renaming an observed-dead gate can race with its
  // replacement and steal a live recoverer's gate. Only the holder removes it.
  return nonce;
}

function leaveRecoverGate(lockPath: string, nonce: string): void {
  const gate = recoverGatePath(lockPath);
  if (!unlinkIfNonce(`${gate}/owner`, nonce)) return;
  try {
    rmdirSync(gate);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT' && errnoCode(err) !== 'ENOTEMPTY') throw err;
  }
}

function unlinkObservedDeadLock(lockPath: string, expectedNonce: string | null): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return true;
    throw err;
  }
  const current = parseLock(raw);
  if (current.nonce !== expectedNonce) return false;
  if (!canSteal(current.pid, current.nonce)) return false;
  return unlinkIfNonce(lockPath, expectedNonce);
}

function stealDeadWriterLock(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch (err) {
    return errnoCode(err) === 'ENOENT';
  }
  const observed = parseLock(raw);
  if (!canSteal(observed.pid, observed.nonce)) return false;
  // Both recoverers have already decided this lock is dead. The test holds them
  // here so the slower one resumes only after the winner has installed a new lock.
  waitForRecoverBarrier();
  const gateNonce = tryEnterRecoverGate(lockPath);
  if (gateNonce === null) return false;
  try {
    return unlinkObservedDeadLock(lockPath, observed.nonce);
  } finally {
    leaveRecoverGate(lockPath, gateNonce);
  }
}

/** O_EXCL sidecar. Kernel flock is not in node:fs; this is the equivalent. */
function acquireExclusiveWriterLock(journalPath: string): { lockPath: string; nonce: string } {
  const lockPath = writerLockPath(journalPath);
  for (let attempt = 0; attempt < 2; attempt++) {
    const nonce = randomBytes(8).toString('hex');
    try {
      writeFileSync(lockPath, `${process.pid}\n${nonce}\n`, { flag: 'wx' });
      heldLockNonces.add(nonce);
      return { lockPath, nonce };
    } catch (err) {
      if (errnoCode(err) !== 'EEXIST') throw err;
      if (attempt === 0 && stealDeadWriterLock(lockPath)) continue;
      throw new FileJournalLockedError(journalPath);
    }
  }
  throw new FileJournalLockedError(journalPath);
}

function releaseExclusiveWriterLock(lockPath: string, nonce: string): void {
  try {
    unlinkIfNonce(lockPath, nonce);
  } finally {
    heldLockNonces.delete(nonce);
  }
}

// ── Implementations ──────────────────────────────────────

/** For tests and single-process dev. Durable only for the life of the process. */
export class MemoryJournal implements EngineJournal {
  private readonly records: JournalRecord[] = [];

  append(command: JournalCommand): JournalRecord {
    const record = { ...command, seq: this.records.length + 1 } as JournalRecord;
    this.records.push(record);
    return record;
  }

  read(): readonly JournalRecord[] {
    return this.records;
  }

  get length(): number {
    return this.records.length;
  }

  close(): void {
    // Nothing to release.
  }
}

/**
 * Append-only NDJSON on disk, fsync'd per record.
 *
 * The fsync is the whole point and it is not negotiable: an input that is only
 * in the page cache is an input the recovery guarantee does not cover. This
 * costs throughput, which is why §5.1 marks the engine for a Rust port rather
 * than asking this file to be clever.
 *
 * SOCKET §13 — durable journal transport. A replicated log (Postgres
 * `matching.engine_journal`, or a JetStream work queue) replaces this class
 * without touching `EngineJournal`'s three methods when the engine goes
 * multi-replica.
 */
export class FileJournal implements EngineJournal {
  private readonly fd: number;
  private readonly lockPath: string;
  private readonly lockNonce: string;
  private records: JournalRecord[];
  private ioUnknown = false;
  private closed = false;

  constructor(readonly path: string) {
    /**
     * Exclusive writer first — two O_APPEND fds on one file can tear the book.
     * Lock before rewriteClean so a second process cannot rewrite under us.
     * Sidecar lock, not a replica log (SOCKET §13 still replaces this class).
     */
    const acquired = acquireExclusiveWriterLock(path);
    this.lockPath = acquired.lockPath;
    this.lockNonce = acquired.nonce;
    try {
      /**
       * Crash mid-write can leave a partial last NDJSON line. `decodeAll` skips
       * that residue so recovery can boot (#1520). But the torn bytes still sit
       * on disk — opening O_APPEND without rewriting would glue the next durable
       * append onto the tear, so a later boot either drops a real record or
       * throws mid-file corruption and refuses recovery. Rewrite the decoded
       * records as the clean durable body before any further append.
       */
      this.records = existsSync(path) ? decodeAll(readFileSync(path, 'utf8')) : [];
      rewriteClean(path, this.records);
      this.fd = openSync(path, 'a');
    } catch (err) {
      releaseExclusiveWriterLock(this.lockPath, this.lockNonce);
      throw err;
    }
  }

  append(command: JournalCommand): JournalRecord {
    if (this.closed) throw new Error('journal_closed');
    if (this.ioUnknown) throw new Error('journal_io_unknown: close and recover before admitting another input');
    const record = { ...command, seq: this.records.length + 1 } as JournalRecord;
    const line = `${encode(record)}\n`;
    const expected = Buffer.byteLength(line, 'utf8');
    const offset = fstatSync(this.fd).size;
    let written: number;
    try {
      written = writeSync(this.fd, line);
    } catch (err) {
      // A thrown write can have made partial progress. Refuse further inputs
      // until recovery validates the durable prefix.
      this.ioUnknown = true;
      throw err;
    }
    if (written !== expected) {
      // writeSync can return a short count and still leave those bytes on the
      // O_APPEND fd. A retry would then land after the tear, so the fsynced
      // command would not be its own NDJSON record. Drop the tear back to the
      // pre-write offset and do not admit the record.
      try {
        ftruncateSync(this.fd, offset);
        fsyncSync(this.fd);
      } catch (err) {
        this.ioUnknown = true;
        throw err;
      }
      throw new Error(`short journal write: wrote ${written} of ${expected} bytes at ${this.path}`);
    }
    try {
      fsyncSync(this.fd);
    } catch (err) {
      // The complete record may already be durable. Reusing its sequence
      // here would create two inputs at one position after restart.
      this.ioUnknown = true;
      throw err;
    }
    this.records.push(record);
    return record;
  }

  read(): readonly JournalRecord[] {
    return this.records;
  }

  get length(): number {
    return this.records.length;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      closeSync(this.fd);
    } finally {
      releaseExclusiveWriterLock(this.lockPath, this.lockNonce);
    }
  }
}

/**
 * Publish exactly the durable records.
 *
 * The new body is written to a temp file in the same directory, fsynced, then
 * renamed over `path`. A crash before that rename leaves the previous journal
 * bytes in place. Truncating the live path first would destroy an already
 * fsynced prefix if the process died before the replacement was durable.
 */
function rewriteClean(path: string, records: readonly JournalRecord[]): void {
  const body = records.length === 0 ? '' : `${records.map((r) => encode(r)).join('\n')}\n`;
  const tmp = join(dirname(path), `.${randomBytes(8).toString('hex')}.journal-rewrite`);
  const fd = openSync(tmp, 'wx');
  try {
    const bytes = Buffer.from(body, 'utf8');
    if (bytes.length > 0) {
      const written = writeSync(fd, bytes, 0, bytes.length, 0);
      if (written !== bytes.length) {
        throw new Error(`short journal rewrite: wrote ${written} of ${bytes.length} bytes at ${path}`);
      }
    }
    fsyncSync(fd);
  } catch (err) {
    try {
      discardRewriteTemp(fd, tmp);
    } catch {
      // The rewrite error is the one that must surface.
    }
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (err) {
    try {
      discardRewriteTemp(undefined, tmp);
    } catch {
      // The live path was not replaced. Surface the rename failure.
    }
    throw err;
  }
}

function discardRewriteTemp(fd: number | undefined, tmp: string): void {
  if (fd !== undefined) {
    try {
      closeSync(fd);
    } catch {
      // The failed rewrite is already closing this fd.
    }
  }
  try {
    unlinkSync(tmp);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
  }
}

/**
 * Decode an NDJSON journal body.
 *
 * A crash mid-write can leave a partial last line (write started, fsync never
 * finished). That is not corruption of history — it is an input that never
 * became durable, so recovery must skip it and boot. A broken line in the
 * middle of the file is real corruption and still throws.
 */
export function decodeAll(contents: string): JournalRecord[] {
  const lines = contents.split('\n');
  const records: JournalRecord[] = [];
  // Last element of split is often '' after a trailing newline — track the
  // last non-empty line index so we know when a parse failure is terminal residue.
  let lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().length > 0) lastNonEmpty = i;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as JournalRecord);
    } catch (err) {
      if (i === lastNonEmpty) {
        // Truncated tail — durable records above stand; this input never landed.
        continue;
      }
      throw err;
    }
  }
  return records;
}
