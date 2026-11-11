// Splits the real-app journey files across the Real-app journeys shards by how long each file took in the last
// finished runs on main, so the shards end at about the same time.
// (Failure it prevents: Playwright's own --shard splits by test count, in file-name order. In run 338 the bank journeys
// sat together and shard 2 ran 36 minutes while shard 4 ran 3, so every run waited about 20 minutes on one shard.)
//
// Usage: node tooling/scripts/journey-shards.mjs --shards <n | auto> [--report <report.json>]... [--only "<files>"]
// Prints a JSON array with one string per shard: that shard's journey files (relative to the journey folder),
// separated by spaces. Each file counts its longest time across the reports, so a shard that was cut short or a file
// that failed early in one run does not make it look fast, plus the suite's time per step for each step no report
// timed, so a new journey or steps added to an old one count before any run has timed them. With no report every step
// counts the same. A report that cannot be read is skipped.
//
// `--shards auto` picks as many shards as keep each one's journeys near the target (shardTarget), between MIN_SHARDS
// and MAX_SHARDS. (Failure it prevents: run 631 spent about 30 minutes per shard of a 60-minute job, and the real-app
// tests for about 2,364 more steps were on their way; a fixed 8 would have pushed shards past the limit, and a shard that
// hits it loses its whole report.) The target follows the longest journey file: a file runs in one shard, one step at a
// time, so the run never ends before setup plus that file. Shards shorter than the file less SETUP_SPREAD_MINUTES only add
// setups and end no sooner, and longer ones become the run's long pole. (Measured 6 Nov 2026 on main's runs
// 42159345632, 42162651623, 42163741447, 42164583521 and 42166558019: 20 to 21 shards near 25 minutes each, 43 to 48
// minutes a run; J-wallet-05 alone took 25.9 minutes; a shard's setup took 7.6 minutes at the median and 18.4 at most,
// the browser's system packages up to 11.7 of it. Replaying those runs, 32 shards of about 16 minutes bring the median
// run to about 36 minutes, and 40 or 56 shards to the same 36.)
//
// Before it prints, the plan is checked to hold every journey file exactly once (planCovers), so a planning bug can
// never drop or repeat a journey; a plan that fails the check prints nothing and the workflow falls back to Playwright's
// own split of every file.
//
// `--only` plans a targeted run: only the journey files it names (targetFiles), which must all exist. The workflow
// passes it only for a manual run on a branch other than main (owner decision 2026-10-30).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stackFresh } from '../../apps/customer/tests/real-app/world-line.mjs';

export const JOURNEY_DIR = 'apps/customer/tests/real-app';
export const JOURNEY_FILE = /\.pw\.mjs$/;
// The shard hands the names to Playwright's testMatch as globs, so a name must match only itself.
const GLOB_CHARS = /[*?[\]{}()!+@\s\\]/;
// A shard's journeys aim at the longest file's time less this, the spread of a shard's setup (7.6 minutes at the median,
// 18.4 at most in the runs above), so a shard with a slow setup still ends before the longest file's shard.
export const SETUP_SPREAD_MINUTES = 10;
// Never below this, so a shard's setup (about 8 minutes) stays under half of its job.
export const MIN_TARGET_MINUTES = 10;
// Never above this, so setup plus the journeys stays well inside the job's limit.
export const MAX_TARGET_MINUTES = 25;
// At least the 8 shards the suite ran on before. At most 32: the org's runners are not the 500 GitHub's limits page names
// for its plan. Counted from the jobs' own start and end times (project-state #1906, 9 Nov 2026), about 180 jobs ran at
// once (178 to 185 through 09:50-10:50 UTC, 175 to 179 through 13:16-13:28, peaks to about 230) while jobs that wait on
// nothing queued for up to 37 minutes. A main run of 48 shards took over a quarter of that, and pull-request CI starved
// behind it. The replay above puts the median run at about 36 minutes with
// 32 shards and the same 36 with 40 or 56, so 32 costs main's verdict about nothing and leaves the rest for CI.
export const MIN_SHARDS = 8;
export const MAX_SHARDS = 32;
// The workflow stops a shard's journeys after this (Playwright's globalTimeout), so the shard still reports.
const JOURNEY_LIMIT_MINUTES = Number(process.env.JOURNEY_GLOBAL_TIMEOUT_MS || 3_600_000) / 60_000;
// The planner warns when a shard's journeys come within this of the limit; a capped plan must stay clear of it.
const LIMIT_MARGIN_MINUTES = 20;
// A targeted run (a pull request's touched journeys, or a manual run's files) takes at most this many shards
// (project-state research/fable-blueprint-2026-11-10 file 10, item 6: "the run is capped at 10 shards"). Each shard
// costs a runner and about 8 minutes of setup, and runners are what main's verdict and every other pull request wait
// on. The cap only packs the same files into fewer shards; it never drops one. It gives way, and the shards stay
// as many as the target asks, whenever the capped plan's longest shard would come within LIMIT_MARGIN_MINUTES of the
// limit (targetedShards), so a cap never costs a journey its report.
export const TARGETED_MAX_SHARDS = 10;
// A step is a `test(` call at the start of a line, the way journey files declare one. A step a loop declares counts
// once until a run has timed its file; from then on the report's count wins.
const STEP = /^\s*test\(/gm;
const TIMED = new Set(['passed', 'failed', 'timedOut']);

/** Journey files under `dir`, as paths relative to it with forward slashes, the way Playwright's report names them. */
export function journeyFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true })
    .map((f) => String(f).split(path.sep).join('/'))
    .filter((f) => JOURNEY_FILE.test(f) && !f.split('/').includes('node_modules'))
    .sort();
}

/**
 * The journey files a targeted run asked for (the Real-app journeys workflow's manual `journeys` input), checked against
 * the journey files that exist. Entries are separated by spaces, commas or new lines and may carry the folder
 * (`apps/customer/tests/real-app/`) and leave out `.pw.mjs`. Anything that is not an existing journey file is refused
 * by name, so a typo never runs the full suite or nothing.
 */
export function targetFiles(asked, files) {
  const known = new Set(files);
  const wanted = String(asked ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((f) => f.replace(/^(\.\/)?apps\/customer\/tests\/real-app\//, ''))
    .map((f) => (JOURNEY_FILE.test(f) ? f : `${f}.pw.mjs`));
  if (wanted.length === 0) throw new Error('the journeys input names no journey file');
  const unknown = wanted.filter((f) => !known.has(f));
  if (unknown.length) throw new Error(`not a journey file under ${JOURNEY_DIR}: ${unknown.join(', ')}`);
  return [...new Set(wanted)].sort();
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

/**
 * Steps per journey file that a Playwright JSON report timed: ran to an end (passed, failed or timed out). A skipped step,
 * or one a shard's own limit interrupted, says nothing about how long a step takes, so it stays untimed.
 */
export function timedSteps(report) {
  const out = new Map();
  const visit = (suite) => {
    if (suite.file && Array.isArray(suite.specs))
      out.set(
        suite.file,
        (out.get(suite.file) ?? 0) +
          suite.specs.flatMap((spec) => spec.tests ?? []).filter((test) => (test.results ?? []).some((r) => TIMED.has(r.status))).length,
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
/** The journey files under `dir` that need a fresh stack (world-line.mjs `stackFresh`, a `// Stack: fresh` line). */
export function freshFiles(dir, files) {
  return new Set(files.filter((f) => stackFresh(fs.readFileSync(path.join(dir, f), 'utf8'))));
}

/** Whether `a` runs before `b` in one shard: Playwright runs a shard's files in name order, the order `sort()` gives. */
const runsFirst = (a, b) => [a, b].sort()[0] === a;

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

/** Each shard's journeys aim at the longest file less the setup spread, within MIN_ and MAX_TARGET_MINUTES. */
export function shardTarget(durations) {
  const longest = Math.max(0, ...durations.values());
  const min = 60_000;
  return Math.min(MAX_TARGET_MINUTES * min, Math.max(MIN_TARGET_MINUTES * min, longest - SETUP_SPREAD_MINUTES * min));
}

/**
 * Problems with a plan against the journey files it must run: a file in no shard, a file in two shards or twice in one,
 * a name that is not one of the files, or an empty shard. An empty list means every file runs exactly once.
 */
export function planCovers(plan, files, fresh = new Set()) {
  const problems = [];
  // A file that needs a fresh stack runs first in its shard, so no other file has used that stack before it.
  plan.forEach((bin, i) => {
    const first = [...bin.files].sort()[0];
    for (const f of bin.files)
      if (fresh.has(f) && f !== first) problems.push(`${f} needs a fresh stack but runs after ${first} in shard ${i + 1}`);
  });
  const seen = new Map();
  plan.forEach((bin, i) => {
    if (!bin.files.length) problems.push(`shard ${i + 1} has no file`);
    for (const f of bin.files) seen.set(f, [...(seen.get(f) ?? []), i + 1]);
  });
  const known = new Set(files);
  for (const f of files) if (!seen.has(f)) problems.push(`${f} is in no shard`);
  for (const [f, shards] of seen) {
    if (!known.has(f)) problems.push(`${f} is not a journey file of this run`);
    if (shards.length > 1) problems.push(`${f} is in shards ${shards.join(', ')}`);
  }
  return problems;
}

/** How many shards keep each one's journeys near `targetMs`, between `min` and `max`. */
export function shardCount(totalMs, targetMs, min = MIN_SHARDS, max = MAX_SHARDS) {
  return Math.min(max, Math.max(min, Math.ceil(totalMs / targetMs)));
}

/**
 * How many shards a targeted run takes: as many as the target asks (from one, never more than its files), capped at
 * TARGETED_MAX_SHARDS, unless the capped plan's longest shard (planShards) would need more than `limitMs` of journeys;
 * then the uncapped count stands. Fails open: an uncapped count is never lowered past what keeps every shard clear of
 * the limit. Pure, for the tests.
 */
export function targetedShards(files, durations, targetMs, limitMs = (JOURNEY_LIMIT_MINUTES - LIMIT_MARGIN_MINUTES) * 60_000) {
  const totalMs = files.reduce((a, f) => a + (durations.get(f) ?? 0), 0);
  const uncapped = Math.min(files.length, shardCount(totalMs, targetMs, 1));
  if (uncapped <= TARGETED_MAX_SHARDS) return uncapped;
  const capped = planShards(files, durations, TARGETED_MAX_SHARDS);
  return Math.max(...capped.map((bin) => bin.ms)) <= limitMs ? TARGETED_MAX_SHARDS : uncapped;
}

/**
 * Longest file first onto the shard with the least time so far. Ties go to the lower shard and files of equal time
 * keep name order, so the same inputs always give the same split. Every shard gets a file when there are enough files.
 * A file in `fresh` (it needs a fresh stack) gets a shard of its own to start, and only files that run after it in name
 * order join it, so it runs first there; a plan that can't keep that throws, naming why.
 */
export function planShards(files, durations, shards, fresh = new Set()) {
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
  const bins = Array.from({ length: shards }, () => ({ ms: 0, files: [], fresh: null }));
  const needing = weighted.filter(({ file }) => fresh.has(file));
  if (needing.length > shards) throw new Error(`${needing.length} journey files need a fresh stack and there are ${shards} shards`);
  for (const { file, ms } of needing) {
    let target = null;
    for (const bin of bins) if (bin.fresh === null && (target === null || bin.ms < target.ms)) target = bin;
    target.ms += ms;
    target.files.push(file);
    target.fresh = file;
  }
  for (const { file, ms } of weighted) {
    if (fresh.has(file)) continue;
    let target = null;
    for (const bin of bins) if ((bin.fresh === null || runsFirst(bin.fresh, file)) && (target === null || bin.ms < target.ms)) target = bin;
    if (target === null) throw new Error(`${file} runs before every file that needs a fresh stack, and every shard has one`);
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
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  const reports = argv.flatMap((a, i) => (argv[i - 1] === '--report' && fs.existsSync(a) ? [a] : []));
  if (!reports.length) console.error('journey-shards: no report from a finished run, so every step counts the same');
  const files = only === null ? journeyFiles(JOURNEY_DIR) : targetFiles(only, journeyFiles(JOURNEY_DIR));
  if (only !== null) console.error(`journey-shards: a targeted run of ${files.length} journey file(s): ${files.join(' ')}`);
  const read = reports.map(readReport);
  const durations = estimateDurations(
    files,
    longestDurations(read.map((r) => fileDurations(r))),
    longestDurations(read.map((r) => timedSteps(r))),
    stepCounts(JOURNEY_DIR, files),
  );
  const totalMs = [...durations.values()].reduce((a, b) => a + b, 0);
  // Never more shards than files: a shard must have a file to run.
  // A targeted run takes as few stacks as its files need (from one), not the full suite's floor, and at most
  // TARGETED_MAX_SHARDS while every shard stays clear of the limit (targetedShards).
  const target = shardTarget(durations);
  const shards =
    asked !== 'auto'
      ? Number(asked)
      : only === null
        ? Math.min(files.length, shardCount(totalMs, target))
        : targetedShards(files, durations, target);
  const fresh = freshFiles(JOURNEY_DIR, files);
  // A targeted run too small to give each file that needs a fresh stack a shard it runs first in takes one more shard.
  let plan = null;
  for (let n = shards; plan === null; n += 1) {
    try {
      plan = planShards(files, durations, n, fresh);
    } catch (err) {
      if (n >= files.length || n >= MAX_SHARDS || !/fresh stack/.test(err.message)) throw err;
    }
  }
  const problems = planCovers(plan, files, fresh);
  if (problems.length) {
    for (const p of problems) console.error(`::error::the shard plan does not run every journey file once: ${p}`);
    process.exit(1);
  }
  console.error(
    `journey-shards: ${files.length} files, about ${Math.round(totalMs / 60_000)} min in all, ${shards} shards aimed at about ${Math.round(target / 60_000)} min each${only !== null ? ` (a targeted run: at most ${TARGETED_MAX_SHARDS} while each shard stays clear of the limit)` : ''}`,
  );
  plan.forEach((bin, i) =>
    console.error(`shard ${i + 1}: ${bin.files.length} files, about ${Math.round(bin.ms / 60_000)} min by the last runs`),
  );
  const longest = Math.max(...plan.map((bin) => bin.ms)) / 60_000;
  // Stderr, so the plan on stdout stays clean; the runner reads workflow commands from both.
  if (longest > JOURNEY_LIMIT_MINUTES - LIMIT_MARGIN_MINUTES)
    console.error(
      `::warning::the longest shard needs about ${Math.round(longest)} of its ${JOURNEY_LIMIT_MINUTES} minutes of journeys; raise MAX_SHARDS in tooling/scripts/journey-shards.mjs`,
    );
  process.stdout.write(JSON.stringify(plan.map((bin) => bin.files.join(' '))));
}
