import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { FileJournal, FileJournalLockedError } from './journal-io.js';

/**
 * One dead-lock recoverer. The parent releases this pid from the barrier
 * inside stealDeadWriterLock, then reads the status files this process writes.
 */
const journalPath = process.env.JOURNAL_PATH;
const barrier = process.env.MATCHING_JOURNAL_LOCK_RECOVER_BARRIER;
if (!journalPath || !barrier) {
  throw new Error('recover child requires JOURNAL_PATH and MATCHING_JOURNAL_LOCK_RECOVER_BARRIER');
}

const cancel = {
  kind: 'cancel' as const,
  marketId: 'BTC/USDT',
  at: '2026-01-01T00:00:02.000Z',
  orderId: '00000000-0000-4000-8000-000000000003',
};

/**
 * The parent polls for a status file and reads it as soon as it exists, so a
 * file must appear with its whole content: write a side file, then rename it
 * (writeFileSync alone creates the file empty before the bytes land, #6629).
 */
function publish(name: string, data: string | Buffer): void {
  const tmp = `${barrier}/.tmp-${name}`;
  writeFileSync(tmp, data);
  renameSync(tmp, `${barrier}/${name}`);
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

try {
  const journal = new FileJournal(journalPath);
  journal.append(cancel);
  publish(`appended-${process.pid}`, readFileSync(`${journalPath}.lock`));
  const deadline = Date.now() + 8_000;
  while (!existsSync(`${barrier}/done`)) {
    if (Date.now() > deadline) throw new Error('timed out waiting for done');
    sleepMs(10);
  }
  journal.close();
} catch (err) {
  const code = err instanceof FileJournalLockedError ? err.code : '';
  const message = err instanceof Error ? err.message : String(err);
  publish(`failed-${process.pid}`, `${code}\n${message}\n`);
}
