import { appendFile, mkdir, open, rmdir, truncate } from 'node:fs/promises';
import path from 'node:path';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';

/**
 * LOCAL TEST: the payout stand-in's own record of what it paid out and took back, so the stack's outside source can say
 * what rail `payout-sim` holds in the stand-in's words, never by reading the ledger back. The stack names the folder
 * (`BANK_PAYOUT_SIM_RECORDS_DIR`, its `<state>/test-rail-records`); unset, nothing is written.
 *
 * The format is the stack's own (`tooling/scripts/local-test-rail-records.mjs`, which reads it): one append-only JSONL
 * file per rail, a line `{"label":"TEST","rail","key","direction","assetId","amount","at"}`. `key` is the movement's
 * business key: the same key with the same facts writes nothing new, and with other facts refuses before anything is
 * written. A line counts once its newline is written; a torn last line is cut off by the next write. Writers on the stack
 * share the folder's `.lock`.
 */
const LABEL = 'TEST';

export interface RailMovement {
  readonly key: string;
  /** The value's way across custody: `in` to the platform, `out` from it. */
  readonly direction: 'in' | 'out';
  readonly assetId: string;
  readonly amount: bigint;
}

/** Why the stand-in could not record a movement; nothing was written and nothing is posted. */
export class RailRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RailRecordError';
  }
}

interface RecordLine {
  label: string;
  rail: string;
  key: string;
  direction: string;
  assetId: string;
  amount: string;
  at: string;
}

const facts = (r: Pick<RecordLine, 'direction' | 'assetId' | 'amount'>) =>
  `${r.direction} ${r.assetId} ${formatAmount(parseAmount(r.amount))}`;

/** A writer of one rail's records in `dir`; another writer's `.lock` is waited on for up to `lockWaitMs`. */
export function railRecorder(dir: string, rail: string, lockWaitMs = 10_000) {
  const file = path.join(dir, `${rail}.jsonl`);
  return async (movement: RailMovement): Promise<void> => {
    if (movement.amount <= 0n) throw new RailRecordError(`${rail} ${movement.key}: only an amount above zero is a movement`);
    const record: RecordLine = {
      label: LABEL,
      rail,
      key: movement.key,
      direction: movement.direction,
      assetId: movement.assetId,
      amount: formatAmount(movement.amount),
      at: new Date().toISOString(),
    };
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await withLock(dir, lockWaitMs, async () => {
      const { lines, complete, size } = await readComplete(file);
      const earlier = lines.find((line) => line.key === record.key);
      if (earlier) {
        if (facts(earlier) !== facts(record)) {
          throw new RailRecordError(`${rail} ${record.key} is already recorded as "${facts(earlier)}", not "${facts(record)}"`);
        }
        return;
      }
      if (complete < size) await truncate(file, complete);
      await appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    });
  };
}

/** The file's complete lines and the bytes they take; a torn last line is left out of both. */
async function readComplete(file: string): Promise<{ lines: RecordLine[]; complete: number; size: number }> {
  let bytes: Buffer;
  try {
    const handle = await open(file, 'r');
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], complete: 0, size: 0 };
    throw err;
  }
  const complete = bytes.lastIndexOf(0x0a) + 1;
  const lines = bytes
    .subarray(0, complete)
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line, at) => {
      try {
        return JSON.parse(line) as RecordLine;
      } catch {
        throw new RailRecordError(`${path.basename(file)}:${at + 1} is not JSON`);
      }
    });
  return { lines, complete, size: bytes.length };
}

/** One writer at a time across the stack's processes: the folder's `.lock`, waited on, then refused by name. */
async function withLock<T>(dir: string, waitMs: number, fn: () => Promise<T>): Promise<T> {
  const lock = path.join(dir, '.lock');
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (Date.now() > deadline) throw new RailRecordError(`${lock} is held; if no stack command is writing, remove it`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock);
  }
}
