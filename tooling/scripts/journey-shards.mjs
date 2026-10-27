// Splits the real-app journey files across the Real-app journeys shards by how long each file took in the last
// finished runs on main, so the shards end at about the same time.
// (Failure it prevents: Playwright's own --shard splits by test count, in file-name order. In run 338 the bank journeys
// sat together and shard 2 ran 36 minutes while shard 4 ran 3, so every run waited about 20 minutes on one shard.)
//
// Usage: node tooling/scripts/journey-shards.mjs --shards <n | auto> [--report <report.json>]...
// Prints a JSON array with one string per shard: that shard's journey files (relative to the journey folder),
// separated by spaces. Each file counts its longest time across the reports, so a shard that was cut short or a file
// that failed early in one run does not make it look fast, plus the suite's time per step for each step no report
// timed, so a new journey or steps added to an old one count before any run has timed them. With no report every step
// counts the same. A report that cannot be read is skipped.
//
// `--shards auto` picks as many shards as keep each one's journeys near TARGET_MINUTES, between MIN_SHARDS and
// MAX_SHARDS. (Failure it prevents: run 631 spent about 30 minutes per shard of a 60-minute job, and the real-app tests
// for about 2,364 more steps were on their way; a fixed 8 would have pushed shards past the limit, and a shard that hits
// it loses its whole report.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const JOURNEY_DIR = 'apps/customer/tests/real-app';
export const JOURNEY_FILE = /\.pw\.mjs$/;
// The shard hands the names to Playwright's testMatch as globs, so a name must match only itself.
const GLOB_CHARS = /[*?[\]{}()!+@\s\\]/;
// Each shard's journeys aim at this, so setup (about 10 minutes) plus the journeys stays well inside the job's limit.
export const TARGET_MINUTES = 25;
// At least the 8 shards the suite ran on before; at most what leaves pull-request CI runners while a run is going.
export const MIN_SHARDS = 8;
export const MAX_SHARDS = 24;
// The workflow stops a shard's journeys after this (Playwright's globalTimeout), so the shard still reports.
export const JOURNEY_LIMIT_MINUTES = 60;
// A step is a `test(` call at the start of a line, the way every journey file declares one.
const STEP = /^\s*test\(/gm;

/** Journey files under `dir`, as paths relative to it with forward slashes, the way Playwright's report names them. */
export function journeyFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true })
    .map((f) => String(f).split(path.sep).join('/'))
    .filter((f) => JOURNEY_FILE.test(f) && !f.split('/').includes('node_modules'))
    .sort();
}

/** Milliseconds per journey file in a Playwright JSON report: every result of every test in the file, retries included. */
export function fileDurations(report) {
  const out = new Map();
  const visit = (suite) => {
    if (suite.file && Array.isArray(suite.specs)) {
      let ms = out.get(suite.file) ?? 0;
      for (const spec of suite.specs)
        for (const test of spec.tests ?? []) for (const result of test.results ?? []) ms += result.duration ?? 0;
      out.set(suite.file, ms);
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report?.suites ?? []) visit(suite);
  return out;
}

/** Steps per journey file that a Playwright JSON report timed (ran at least once). */
export function timedSteps(report) {
  const out = new Map();
  const visit = (suite) => {
    if (suite.file && Array.isArray(suite.specs))
      out.set(
        suite.file,
        (out.get(suite.file) ?? 0) + suite.specs.flatMap((spec) => spec.tests ?? []).filter((test) => (test.results ?? []).length).length,
      );
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report?.suites ?? []) visit(suite);
  return out;
}

/** Each file's longest time (or most timed steps) across several runs. */
export function longestDurations(runs) {
  const out = new Map();
  for (const run of runs) for (const [file, ms] of run) out.set(file, Math.max(out.get(file) ?? 0, ms));
  return out;
}

/** Steps per journey file under `dir`. */
export function stepCounts(dir, files) {
  return new Map(files.map((f) => [f, (fs.readFileSync(path.join(dir, f), 'utf8').match(STEP) ?? []).length]));
}

/**
 * Every file's expected time: its longest past time plus the suite's time per step (all past time over all timed steps)
 * for each of its steps no report timed. A file no report knows and with no step counts as one step, so it still lands.
 */
export function estimateDurations(files, past, timed, steps) {
  let ms = 0;
  let count = 0;
  for (const f of files)
    if (past.get(f) > 0 && timed.get(f) > 0) {
      ms += past.get(f);
      count += timed.get(f);
    }
  const perStep = count ? ms / count : 1;
  return new Map(
    files.map((f) => {
      const known = past.get(f) ?? 0;
      const untimed = Math.max(0, (steps.get(f) ?? 0) - (timed.get(f) ?? 0));
      return [f, known + (untimed || (known ? 0 : 1)) * perStep];
    }),
  );
}

/** How many shards keep each one's journeys near `targetMs`, between `min` and `max`. */
export function shardCount(totalMs, targetMs, min = MIN_SHARDS, max = MAX_SHARDS) {
  return Math.min(max, Math.max(min, Math.ceil(totalMs / targetMs)));
}

/**
 * Longest file first onto the shard with the least time so far. Ties go to the lower shard and files of equal time
 * keep name order, so the same inputs always give the same split. Every shard gets a file when there are enough files.
 */
export function planShards(files, durations, shards) {
  if (!Number.isInteger(shards) || shards < 1) throw new Error(`shards must be a whole number of 1 or more, got ${shards}`);
  if (files.length < shards) throw new Error(`${files.length} journey files cannot fill ${shards} shards`);
  const odd = files.find((f) => GLOB_CHARS.test(f));
  if (odd) throw new Error(`journey file name ${JSON.stringify(odd)} would match other files as a glob; rename it`);
  const known = files
    .map((f) => durations.get(f))
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);
  const middle = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weighted = [...files]
    .sort()
    .map((file) => ({ file, ms: durations.get(file) > 0 ? durations.get(file) : middle }))
    .sort((a, b) => b.ms - a.ms);
  const bins = Array.from({ length: shards }, () => ({ ms: 0, files: [] }));
  for (const { file, ms } of weighted) {
    let target = bins[0];
    for (const bin of bins) if (bin.ms < target.ms) target = bin;
    target.ms += ms;
    target.files.push(file);
  }
  return bins.map((bin) => ({ ms: bin.ms, files: bin.files.sort() }));
}

function readReport(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`journey-shards: skipping ${file}: ${err.message}`);
    return {};
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const asked = argv[argv.indexOf('--shards') + 1];
  const reports = argv.flatMap((a, i) => (argv[i - 1] === '--report' && fs.existsSync(a) ? [a] : []));
  if (!reports.length) console.error('journey-shards: no report from a finished run, so every step counts the same');
  const files = journeyFiles(JOURNEY_DIR);
  const read = reports.map(readReport);
  const durations = estimateDurations(
    files,
    longestDurations(read.map((r) => fileDurations(r))),
    longestDurations(read.map((r) => timedSteps(r))),
    stepCounts(JOURNEY_DIR, files),
  );
  const totalMs = [...durations.values()].reduce((a, b) => a + b, 0);
  const shards = asked === 'auto' ? shardCount(totalMs, TARGET_MINUTES * 60_000) : Number(asked);
  const plan = planShards(files, durations, shards);
  console.error(`journey-shards: ${files.length} files, about ${Math.round(totalMs / 60_000)} min in all, ${shards} shards`);
  plan.forEach((bin, i) =>
    console.error(`shard ${i + 1}: ${bin.files.length} files, about ${Math.round(bin.ms / 60_000)} min by the last runs`),
  );
  const longest = Math.max(...plan.map((bin) => bin.ms)) / 60_000;
  // Stderr, so the plan on stdout stays clean; the runner reads workflow commands from both.
  if (longest > JOURNEY_LIMIT_MINUTES - 20)
    console.error(
      `::warning::the longest shard needs about ${Math.round(longest)} of its ${JOURNEY_LIMIT_MINUTES} minutes of journeys; raise MAX_SHARDS in tooling/scripts/journey-shards.mjs`,
    );
  process.stdout.write(JSON.stringify(plan.map((bin) => bin.files.join(' '))));
}
