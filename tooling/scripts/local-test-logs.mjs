/**
 * LOCAL TEST log rotation — keeps every log of the local test stack under a size cap.
 *
 * Failure it prevents: the stack's service logs and the market log only ever grew. After two days matching.log
 * alone was 347 MB and the logs together 789 MB, on a Mac that is already short of disk and memory.
 *
 * Copy-truncate, because the services are long-running processes that hold their log open for appending
 * (O_APPEND, see startProc in local-test-stack.mjs): the file is never renamed or replaced, so nothing needs
 * restarting; after the file is emptied the writer's next line lands at the start. The cap is per file: the live
 * log plus `files - 1` older ones (`x.log.1`, `x.log.2`), each at most `maxBytes`. Only the newest `maxBytes` of a
 * file that is far over the cap are kept (no 300 MB copy). A line written during the few milliseconds of a
 * rotation can be lost; these are diagnostic logs, not records.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MAX_LOG_BYTES = 50 * 1024 * 1024;
export const LOG_FILES = 3;

/** Rotate one file if it is over `maxBytes`. Returns the bytes it held, or 0 if it was left alone. */
export function rotateLog(file, { maxBytes = MAX_LOG_BYTES, files = LOG_FILES } = {}) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return 0;
  }
  if (size <= maxBytes) return 0;
  for (let i = files - 1; i >= 1; i -= 1) {
    const from = i === 1 ? null : `${file}.${i - 1}`;
    const to = `${file}.${i}`;
    if (i === files - 1) fs.rmSync(to, { force: true });
    if (from && fs.existsSync(from)) fs.renameSync(from, to);
  }
  if (files > 1) {
    // The newest `maxBytes` of the live file become `.1`.
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const out = fs.openSync(`${file}.1`, 'w', 0o600);
    try {
      const buf = Buffer.allocUnsafe(1024 * 1024);
      let pos = start;
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        fs.writeSync(out, buf, 0, n);
        pos += n;
      }
    } finally {
      fs.closeSync(fd);
      fs.closeSync(out);
    }
  }
  fs.truncateSync(file, 0);
  return size;
}

/** Rotate every `*.log` in a directory. Returns [{ file, bytes }] for the ones that were rotated. */
export function rotateAll(dir, opts) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.log'));
  } catch {
    return [];
  }
  const done = [];
  for (const n of names) {
    const file = path.join(dir, n);
    try {
      const bytes = rotateLog(file, opts);
      if (bytes) done.push({ file, bytes });
    } catch {
      /* a log that cannot be rotated is left; it must never stop the stack or the market */
    }
  }
  return done;
}
