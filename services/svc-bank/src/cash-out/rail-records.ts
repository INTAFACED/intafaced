import { mkdir, open, rmdir, truncate } from 'node:fs/promises';
import path from 'node:path';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';

/**
 * LOCAL TEST: the payout stand-in's own record of what it paid out and took back, so the stack's outside source can say
 * what rail `payout-sim` holds in the stand-in's words, never by reading the ledger back. The stack names the folder
 * (`BANK_PAYOUT_SIM_RECORDS_DIR`, its `<state>/test-rail-records`); unset, nothing is written.
 *
 * The format and its checks are the stack's own (`tooling/scripts/local-test-rail-records.mjs`, which reads it): one
 * append-only JSONL file per rail, a line `{"label":"TEST","rail","key","direction","assetId","amount","at"}`, plus
 * `ref` when the stand-in gave the movement a reference of its own (a payout's `TEST-PAYOUT-<id>`). `key` is the
 * movement's business key: the same key with the same facts writes nothing new, and with other facts refuses before
 * anything is written. A line counts once its newline is written; a torn last line is cut off by the next write. Writers
 * on the stack share the folder's `.lock`.
 */
const LABEL = 'TEST';
const RAIL = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ASSET = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const DECIMAL = /^(0|[1-9]\d*)(\.\d{1,18})?$/;
const MAX_KEY = 512;
const REF = /^TEST-[A-Za-z0-9-]{1,128}$/;

export interface RailMovement {
  readonly key: string;
  /** The value's way across custody: `in` to the platform, `out` from it. */
  readonly direction: 'in' | 'out';
  readonly assetId: string;
  readonly amount: bigint;
  /** The stand-in's own reference for the movement, when it gave one (a payout's `TEST-PAYOUT-<cash-out id>`). */
  readonly ref?: string;
}

/** Why the stand-in could not record a movement; nothing was written. `conflict`: the rail already says otherwise. */
export class RailRecordError extends Error {
  constructor(
    message: string,
    readonly conflict = false,
  ) {
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
  ref?: string;
  at: string;
}

/** The reader's checks, so the writer never leaves a line the stack's reader would refuse. */
function check(line: RecordLine, where: string): void {
  const ok =
    line?.label === LABEL &&
    typeof line.rail === 'string' &&
    RAIL.test(line.rail) &&
    typeof line.key === 'string' &&
    line.key.length > 0 &&
    line.key.length <= MAX_KEY &&
    (line.direction === 'in' || line.direction === 'out') &&
    typeof line.assetId === 'string' &&
    ASSET.test(line.assetId) &&
    typeof line.amount === 'string' &&
    DECIMAL.test(line.amount) &&
    positive(line.amount) &&
    typeof line.at === 'string' &&
    !Number.isNaN(Date.parse(line.at)) &&
    (line.ref === undefined || (typeof line.ref === 'string' && REF.test(line.ref)));
  if (!ok) throw new RailRecordError(`${where} is not a TEST rail record`);
}

function positive(amount: string): boolean {
  try {
    return parseAmount(amount) > 0n;
  } catch {
    return false;
  }
}

const facts = (r: Pick<RecordLine, 'direction' | 'assetId' | 'amount' | 'ref'>) =>
  `${r.direction} ${r.assetId} ${formatAmount(parseAmount(r.amount))}${r.ref === undefined ? '' : ` ${r.ref}`}`;

/** One rail's records in `dir`; another writer's `.lock` is waited on for up to `lockWaitMs`. */
export function railRecorder(dir: string, rail: string, lockWaitMs = 10_000) {
  const file = path.join(dir, `${rail}.jsonl`);
  return {
    /** Records one movement, unless the rail already recorded its key with the same facts. */
    async record(movement: RailMovement): Promise<void> {
      if (movement.amount <= 0n) throw new RailRecordError(`${rail} ${movement.key}: only an amount above zero is a movement`);
      const fields = {
        rail,
        key: movement.key,
        direction: movement.direction,
        assetId: movement.assetId,
        ...(movement.ref === undefined ? {} : { ref: movement.ref }),
      };
      const amount = formatAmount(movement.amount);
      check({ label: LABEL, ...fields, amount, at: new Date().toISOString() }, `${rail} ${movement.key}`);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await withLock(dir, lockWaitMs, async () => {
        const { lines, complete, size } = await readComplete(file, rail);
        // Stamped under the lock, so a statement read before this line lands never gains it afterwards.
        const record: RecordLine = { label: LABEL, ...fields, amount, at: new Date().toISOString() };
        const earlier = lines.find((line) => line.key === record.key);
        if (earlier) {
          if (facts(earlier) !== facts(record)) {
            throw new RailRecordError(`${rail} ${record.key} is already recorded as "${facts(earlier)}", not "${facts(record)}"`, true);
          }
          return;
        }
        if (complete < size) await truncate(file, complete);
        const handle = await open(file, 'a', 0o600);
        try {
          await handle.appendFile(`${JSON.stringify(record)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
      });
    },
    /** Whether the rail has a complete record under `key`. */
    async has(key: string): Promise<boolean> {
      return (await readComplete(file, rail)).lines.some((line) => line.key === key);
    },
  };
}

export type RailRecorder = ReturnType<typeof railRecorder>;

/** The file's complete lines, each checked, and the bytes they take; a torn last line is left out of both. */
async function readComplete(file: string, rail: string): Promise<{ lines: RecordLine[]; complete: number; size: number }> {
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
  const name = path.basename(file);
  const lines: RecordLine[] = [];
  bytes
    .subarray(0, complete)
    .toString('utf8')
    .split('\n')
    .forEach((text, at) => {
      if (text === '') return;
      let line: RecordLine;
      try {
        line = JSON.parse(text) as RecordLine;
      } catch {
        throw new RailRecordError(`${name}:${at + 1} is not JSON`);
      }
      check(line, `${name}:${at + 1}`);
      if (line.rail !== rail) throw new RailRecordError(`${name}:${at + 1} names rail ${line.rail}`);
      lines.push(line);
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
