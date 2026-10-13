import { writeFileSync } from 'node:fs';
import { FileJournal } from './journal-io.js';

/**
 * Opens a journal under a parent-applied RLIMIT_FSIZE. The clean rewrite cannot
 * fit in that limit, so this process records whether the live file was opened.
 */
const journalPath = process.env.JOURNAL_PATH;
const statusPath = process.env.JOURNAL_STATUS;
if (!journalPath || !statusPath) {
  throw new Error('rewrite-fault child requires JOURNAL_PATH and JOURNAL_STATUS');
}

let opened = false;
let message = 'opened';
try {
  const journal = new FileJournal(journalPath);
  opened = true;
  journal.close();
} catch (err) {
  message = err instanceof Error ? err.message : String(err);
}
writeFileSync(statusPath, JSON.stringify({ opened, message }));
