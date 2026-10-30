/**
 * LOCAL TEST rail records: each stack stand-in for an outside rail (the TEST chain and its signer on rail crypto-native,
 * the TEST bank payout on rail payout-sim) writes one line here for every movement it makes, in its own words, before it asks the ledger to
 * post it. The stack's outside source totals these per rail, so a reconciliation run compares each rail boundary
 * `rail:<rail>` with what that rail itself says, never with the ledger read back. Rail `local-test` is the stack's TEST
 * mint: it has no outside party to hold a statement, so it has no records here.
 *
 * One append-only JSONL file per rail under `<state>/test-rail-records/`. A line is
 * `{"label":"TEST","rail":…,"key":…,"direction":"in"|"out","assetId":…,"amount":"<decimal>","at":"<ISO time>"}`.
 * `key` is the movement's business key: a retried movement with the same facts writes nothing new, and the same key with
 * other facts refuses before anything is written, since the rail would be contradicting itself. A line counts once its
 * newline is written; a line torn by a crash is not a record and the next write on that rail cuts it off.
 * LOCAL TEST only; nothing here is a real rail.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmdirSync, truncateSync } from 'node:fs';
import path from 'node:path';

export const RECORDS_DIR = 'test-rail-records';
export const RECORD_LABEL = 'TEST';
const RAIL = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ASSET = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
// The ledger's own scale: 18 decimals, so a rail never records an amount the ledger could not post.
const SCALE = 18;
const DECIMAL = /^(0|[1-9]\d*)(\.\d{1,18})?$/;
const DIRECTIONS = new Set(['in', 'out']);
const MAX_KEY = 512;
const MINT = 'local-test';
const LOCK_WAIT_MS = 10_000;

export class RailRecordError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RailRecordError';
  }
}

function units(text) {
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole + frac.padEnd(SCALE, '0'));
}

function formatUnits(value) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(SCALE + 1, '0');
  const out = `${digits.slice(0, -SCALE)}.${digits.slice(-SCALE)}`.replace(/\.?0+$/, '');
  return negative ? `-${out}` : out;
}

function check(record) {
  const { rail, key, direction, assetId, amount, at } = record;
  if (typeof rail !== 'string' || !RAIL.test(rail)) throw new RailRecordError(`rail "${rail}" is not a rail id`);
  if (rail === MINT) throw new RailRecordError(`rail ${MINT} is the stack's TEST mint and has no outside records`);
  if (typeof key !== 'string' || key.length === 0) throw new RailRecordError(`${rail}: the record has no business key`);
  if (key.length > MAX_KEY) throw new RailRecordError(`${rail}: the business key is longer than ${MAX_KEY} characters`);
  if (!DIRECTIONS.has(direction)) throw new RailRecordError(`${rail} ${key}: direction "${direction}" is neither in nor out`);
  if (typeof assetId !== 'string' || !ASSET.test(assetId)) {
    throw new RailRecordError(`${rail} ${key}: asset "${assetId}" is not an asset id`);
  }
  if (typeof amount !== 'string' || !DECIMAL.test(amount) || units(amount) === 0n) {
    throw new RailRecordError(`${rail} ${key}: amount "${amount}" is not a positive decimal string of at most ${SCALE} decimals`);
  }
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) throw new RailRecordError(`${rail} ${key}: time "${at}" is not a time`);
  // The stand-in's own reference for a movement, when it gave one (svc-bank's payout stand-in: `TEST-PAYOUT-<id>`).
  if (record.ref !== undefined && (typeof record.ref !== 'string' || !/^TEST-[A-Za-z0-9-]{1,128}$/.test(record.ref)))
    throw new RailRecordError(`${rail} ${key}: reference "${record.ref}" is not a TEST reference`);
}

const facts = (record) => `${record.direction} ${record.assetId} ${formatUnits(units(record.amount))}`;

/** The rail file's complete lines, and the byte length they take (a torn last line is left out of both). */
function readRailFile(file) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return { records: [], complete: 0, size: 0 };
    throw err;
  }
  const complete = bytes.lastIndexOf(0x0a) + 1;
  const name = path.basename(file);
  const records = [];
  bytes
    .subarray(0, complete)
    .toString('utf8')
    .split('\n')
    .forEach((line, at) => {
      if (line === '') return;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new RailRecordError(`${name}:${at + 1} is not JSON`);
      }
      if (record?.label !== RECORD_LABEL) throw new RailRecordError(`${name}:${at + 1} is not labelled ${RECORD_LABEL}`);
      check(record);
      if (`${record.rail}.jsonl` !== name) throw new RailRecordError(`${name}:${at + 1} names rail ${record.rail}`);
      records.push(record);
    });
  return { records, complete, size: bytes.length };
}

/** One writer at a time across the stack's processes, so a check, a cut and an append are never interleaved. */
function withLock(dir, fn) {
  const lock = path.join(dir, '.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (Date.now() > deadline) throw new RailRecordError(`${lock} is held; if no stack command is writing, remove it`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(lock);
  }
}

/**
 * Records one movement on its rail, unless the rail already recorded that key with the same facts. `direction` is the
 * value's way across custody: `in` to us, `out` from us. Returns the record that stands for the movement.
 */
export function recordRailMovement(stateDir, { rail, key, direction, assetId, amount, at = new Date().toISOString() }) {
  if (!stateDir || typeof stateDir !== 'string') throw new RailRecordError('the stack state directory is missing');
  const record = { label: RECORD_LABEL, rail, key, direction, assetId, amount, at };
  check(record);
  const dir = path.join(stateDir, RECORDS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${rail}.jsonl`);
  return withLock(dir, () => {
    const { records, complete, size } = readRailFile(file);
    const earlier = records.find((row) => row.key === key);
    if (earlier) {
      if (facts(earlier) !== facts(record)) {
        throw new RailRecordError(`${rail} ${key} is already recorded as "${facts(earlier)}", not "${facts(record)}"`);
      }
      return earlier;
    }
    if (complete < size) truncateSync(file, complete);
    appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return record;
  });
}

/** One rail's complete records, each checked. */
export function readRail(stateDir, rail) {
  if (typeof rail !== 'string' || !RAIL.test(rail)) throw new RailRecordError(`rail "${rail}" is not a rail id`);
  return readRailFile(path.join(stateDir, RECORDS_DIR, `${rail}.jsonl`)).records;
}

/** Every complete record on disk, each checked; a line that is not a TEST record refuses rather than being skipped. */
export function readRailRecords(stateDir) {
  const dir = path.join(stateDir, RECORDS_DIR);
  let files;
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  return files.sort().flatMap((name) => readRailFile(path.join(dir, name)).records);
}

/**
 * Each rail's own total per asset at `asOf`, in the ledger's signed form for its boundary `rail:<rail>`: value in to
 * custody leaves the boundary negative, value out leaves it positive. Each business key counts once.
 */
export function railTotals(stateDir, asOf) {
  return totalsOf(signedTotals(readRailRecords(stateDir), asOf));
}

function totalsOf(sums) {
  return [...sums.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([slot, value]) => {
      const [rail, assetId] = slot.split('\u0000');
      return { rail, assetId, amount: formatUnits(value) };
    });
}

function signedTotals(records, asOf = new Date().toISOString()) {
  const cutoff = Date.parse(asOf);
  if (Number.isNaN(cutoff)) throw new RailRecordError(`asOf "${asOf}" is not a time`);
  const seen = new Map();
  const sums = new Map();
  for (const record of records) {
    const id = `${record.rail}\u0000${record.key}`;
    const earlier = seen.get(id);
    if (earlier !== undefined) {
      if (earlier !== facts(record)) {
        throw new RailRecordError(`${record.rail} ${record.key} is recorded as both "${earlier}" and "${facts(record)}"`);
      }
      continue;
    }
    seen.set(id, facts(record));
    if (Date.parse(record.at) > cutoff) continue;
    const slot = `${record.rail}\u0000${record.assetId}`;
    const signed = record.direction === 'in' ? -units(record.amount) : units(record.amount);
    sums.set(slot, (sums.get(slot) ?? 0n) + signed);
  }
  return sums;
}

/**
 * One rail's statement at `asOf`, in the body svc-ledger's per-rail outside reader takes (railBalanceSnapshotSchema plus
 * `rail`; read with `GET <LEDGER_RECONCILE_RAIL_<RAIL>_URL>?rail=<rail>&asOf=<instant>`). Figures come only from that rail's
 * own records, in the ledger's signed form for its boundary.
 */
export function railStatement(stateDir, rail, asOf) {
  if (typeof rail !== 'string' || !RAIL.test(rail)) throw new RailRecordError(`rail "${rail}" is not a rail id`);
  if (rail === MINT) throw new RailRecordError(`rail ${MINT} is the stack's TEST mint and has no outside records`);
  if (typeof asOf !== 'string' || Number.isNaN(Date.parse(asOf))) throw new RailRecordError(`asOf "${asOf}" is not a time`);
  return {
    source: 'rail',
    rail,
    asOf: new Date(Date.parse(asOf)).toISOString(),
    // Only this rail's own file is read, so a bad line on another rail never takes this statement down.
    balances: totalsOf(signedTotals(readRail(stateDir, rail), asOf)).map(({ assetId, amount }) => ({ assetId, amount })),
  };
}
