// Splits the real-app journey files across the Real-app journeys shards by how long each file took in the last
// finished runs on main, so the shards end at about the same time.
// (Failure it prevents: Playwright's own --shard splits by test count, in file-name order. In run 338 the bank journeys
// sat together and shard 2 ran 36 minutes while shard 4 ran 3, so every run waited about 20 minutes on one shard.)
//
// Usage: node tooling/scripts/journey-shards.mjs --shards 8 [--report <report.json>]...
// Prints a JSON array with one string per shard: that shard's journey files (relative to the journey folder),
// separated by spaces. Each file counts its longest time across the reports, so a shard that was cut short or a file
// that failed early in one run does not make it look fast. A file no report knows (a new journey) counts as the middle
// known time; with no report every file counts the same. A report that cannot be read is skipped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const JOURNEY_DIR = 'apps/customer/tests/real-app';
export const JOURNEY_FILE = /\.pw\.mjs$/;
// The shard hands the names to Playwright's testMatch as globs, so a name must match only itself.
const GLOB_CHARS = /[*?[\]{}()!+@\s\\]/;

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

/** Each file's longest time across several runs' durations. */
export function longestDurations(runs) {
  const out = new Map();
  for (const run of runs) for (const [file, ms] of run) out.set(file, Math.max(out.get(file) ?? 0, ms));
  return out;
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
    return fileDurations(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    console.error(`journey-shards: skipping ${file}: ${err.message}`);
    return new Map();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const shards = Number(argv[argv.indexOf('--shards') + 1]);
  const reports = argv.flatMap((a, i) => (argv[i - 1] === '--report' && fs.existsSync(a) ? [a] : []));
  if (!reports.length) console.error('journey-shards: no report from a finished run, so every file counts the same');
  const plan = planShards(journeyFiles(JOURNEY_DIR), longestDurations(reports.map(readReport)), shards);
  plan.forEach((bin, i) =>
    console.error(`shard ${i + 1}: ${bin.files.length} files, about ${Math.round(bin.ms / 60_000)} min by the last runs`),
  );
  process.stdout.write(JSON.stringify(plan.map((bin) => bin.files.join(' '))));
}
