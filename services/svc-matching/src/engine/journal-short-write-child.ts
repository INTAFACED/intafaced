import { writeFileSync } from 'node:fs';
import { FileJournal } from './journal-io.js';

/**
 * Appends once under a parent-applied RLIMIT_FSIZE. A short writeSync returns
 * before fsync; this process records whether that attempt was admitted.
 */
const journalPath = process.env.JOURNAL_PATH;
const statusPath = process.env.JOURNAL_STATUS;
const rawCommand = process.env.JOURNAL_COMMAND;
if (!journalPath || !statusPath || !rawCommand) {
  throw new Error('short-write child requires JOURNAL_PATH, JOURNAL_STATUS, and JOURNAL_COMMAND');
}

const command = JSON.parse(rawCommand) as {
  kind: 'cancel';
  marketId: string;
  at: string;
  orderId: string;
};

const journal = new FileJournal(journalPath);
let message = 'admitted';
try {
  journal.append(command);
} catch (err) {
  message = err instanceof Error ? err.message : String(err);
}
writeFileSync(statusPath, JSON.stringify({ message, length: journal.length }));
journal.close();
