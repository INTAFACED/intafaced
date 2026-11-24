/**
 * LOCAL TEST venue and partner reports: the stack's stand-ins for the TEST venue and the TEST partner keep their own record
 * of what they owe us or hold of ours, one line each time they report a movement, so svc-ledger's report controls
 * (LEDGER_RECONCILE_REPORT_<VENUE|PARTNER>_URL) compare our own records with what the venue or partner itself said, never
 * with the ledger read back.
 *
 * One append-only JSONL file per reporter under `<state>/test-own-reports/`. A line is
 * `{"label":"TEST","reporter":"venue"|"partner","place":…,"key":…,"assetId":…,"amount":"<signed decimal>","at":"<ISO time>"}`,
 * its amount in the ledger's signed form for our account at that place (what the venue owes us in builder fees is
 * negative). `key` is the movement's business key: the same key with the same facts writes nothing new; with other facts
 * it refuses, since the reporter would be contradicting itself.
 *
 * `report(stateDir, reporter, place, asOf)` is the report the reporter had published by `asOf`: its latest line at or
 * before that instant names the report's as-of, and the lines up to it sum to its balances. With no line by then it had
 * published nothing: `reported: false`, which the ledger shows as "not reported", never a match. LOCAL TEST only.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPORTS_DIR = 'test-own-reports';
export const REPORTERS = Object.freeze(['venue', 'partner']);
const PLACE = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const ASSET = /^[A-Za-z0-9]{2,16}$/;
const SCALE = 18;
const SIGNED = /^-?(0|[1-9]\d*)(\.\d{1,18})?$/;
const MAX_KEY = 512;

export class OwnReportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OwnReportError';
  }
}

function units(text) {
  const negative = text.startsWith('-');
  const [whole, frac = ''] = text.replace(/^-/, '').split('.');
  const value = BigInt(whole + frac.padEnd(SCALE, '0'));
  return negative ? -value : value;
}

function formatUnits(value) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(SCALE + 1, '0');
  const out = `${digits.slice(0, -SCALE)}.${digits.slice(-SCALE)}`.replace(/\.?0+$/, '');
  return negative ? `-${out}` : out;
}

function checkReporter(reporter) {
  if (!REPORTERS.includes(reporter)) throw new OwnReportError(`reporter "${reporter}" is neither venue nor partner`);
}

function checkPlace(place) {
  if (typeof place !== 'string' || !PLACE.test(place)) throw new OwnReportError(`place "${place}" is not a lower-case place id`);
}

function check(line) {
  checkReporter(line.reporter);
  checkPlace(line.place);
  if (typeof line.key !== 'string' || line.key.length === 0 || line.key.length > MAX_KEY)
    throw new OwnReportError(`${line.reporter} ${line.place}: the record needs a business key of 1 to ${MAX_KEY} characters`);
  if (typeof line.assetId !== 'string' || !ASSET.test(line.assetId))
    throw new OwnReportError(`${line.reporter} ${line.key}: asset "${line.assetId}" is not an asset id`);
  if (typeof line.amount !== 'string' || !SIGNED.test(line.amount) || units(line.amount) === 0n)
    throw new OwnReportError(`${line.reporter} ${line.key}: amount "${line.amount}" is not a non-zero signed decimal string`);
  if (typeof line.at !== 'string' || Number.isNaN(Date.parse(line.at)))
    throw new OwnReportError(`${line.reporter} ${line.key}: time "${line.at}" is not a time`);
}

const fileOf = (stateDir, reporter) => path.join(stateDir, REPORTS_DIR, `${reporter}.jsonl`);

/** Every complete line the reporter has written; a torn last line is not a record. A line that does not read refuses. */
function readLines(stateDir, reporter) {
  let text;
  try {
    text = readFileSync(fileOf(stateDir, reporter), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  return complete
    .split('\n')
    .filter(Boolean)
    .map((raw) => {
      let line;
      try {
        line = JSON.parse(raw);
      } catch {
        throw new OwnReportError(`${reporter}: a record line is not JSON`);
      }
      check(line);
      return line;
    });
}

const facts = (line) => `${line.place} ${line.assetId} ${formatUnits(units(line.amount))}`;

/** Writes one reported movement; the same key with the same facts writes nothing. Returns the line as stored. */
export function recordOwnReport(stateDir, { reporter, place, key, assetId, amount, at = new Date().toISOString() }) {
  const line = { label: 'TEST', reporter, place, key, assetId, amount, at: new Date(Date.parse(at)).toISOString() };
  check(line);
  const seen = readLines(stateDir, reporter).find((l) => l.key === key);
  if (seen) {
    if (facts(seen) !== facts(line)) throw new OwnReportError(`${reporter} ${key}: already recorded as ${facts(seen)}, not ${facts(line)}`);
    return seen;
  }
  mkdirSync(path.join(stateDir, REPORTS_DIR), { recursive: true });
  appendFileSync(fileOf(stateDir, reporter), `${JSON.stringify(line)}\n`);
  return line;
}

/** The report the reporter had published by `asOf` for one place (`outsideReportSchema`). */
export function ownReport(stateDir, reporter, place, asOf) {
  checkReporter(reporter);
  checkPlace(place);
  const at = Date.parse(asOf);
  if (typeof asOf !== 'string' || Number.isNaN(at)) throw new OwnReportError(`asOf "${asOf}" is not a time`);
  const lines = readLines(stateDir, reporter).filter((l) => l.place === place && Date.parse(l.at) <= at);
  if (lines.length === 0) return { source: 'report', reporter, place, reported: false };
  const latest = Math.max(...lines.map((l) => Date.parse(l.at)));
  const totals = new Map();
  for (const l of lines) totals.set(l.assetId, (totals.get(l.assetId) ?? 0n) + units(l.amount));
  return {
    source: 'report',
    reporter,
    place,
    asOf: new Date(latest).toISOString(),
    balances: [...totals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([assetId, value]) => ({ assetId, amount: formatUnits(value) })),
  };
}
