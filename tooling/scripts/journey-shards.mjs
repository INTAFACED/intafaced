// Splits the real-app journey files across the Real-app journeys shards by how long each file took in the last
// finished run on main, so the shards end at about the same time.
// (Failure it prevents: Playwright's own --shard splits by test count, in file-name order. In run 338 the bank journeys
// sat together and shard 2 ran 36 minutes while shard 4 ran 3, so every run waited about 20 minutes on one shard.)
//
// Usage: node tooling/scripts/journey-shards.mjs --shards 8 [--report <last run's report.json>]
// Prints a JSON array with one string per shard: that shard's file names, separated by spaces. A file the report does
// not know (a new journey) counts as the median time; with no report every file counts the same.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const JOURNEY_DIR = 'apps/customer/tests/real-app';
export const JOURNEY_GLOB = /\.pw\.mjs$/;

/** Milliseconds per journey file in a Playwright JSON report: every result of every test in the file, retries included. */
export function fileDurations(report) {
  const out = new Map();
  const visit = (suite) => {
    if (suite.file && Array.isArray(suite.specs)) {
      const name = path.basename(suite.file);
      let ms = out.get(name) ?? 0;
      for (const spec of suite.specs)
        for (const test of spec.tests ?? []) for (const result of test.results ?? []) ms += result.duration ?? 0;
      out.set(name, ms);
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report?.suites ?? []) visit(suite);
  return out;
}

/**
 * Longest file first onto the shard with the least time so far. Ties go to the lower shard and files of equal time
 * keep name order, so the same inputs always give the same split. Every shard gets a file when there are enough files.
 */
export function planShards(files, durations, shards) {
  if (!Number.isInteger(shards) || shards < 1) throw new Error(`shards must be a whole number of 1 or more, got ${shards}`);
  if (files.length < shards) throw new Error(`${files.length} journey files cannot fill ${shards} shards`);
  const known = files
    .map((f) => durations.get(f))
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weighted = [...files]
    .sort()
    .map((file) => ({ file, ms: durations.get(file) > 0 ? durations.get(file) : median }))
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

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const shards = Number(arg('--shards'));
  const reportPath = arg('--report');
  const files = fs.readdirSync(JOURNEY_DIR).filter((f) => JOURNEY_GLOB.test(f));
  let durations = new Map();
  if (reportPath && fs.existsSync(reportPath)) durations = fileDurations(JSON.parse(fs.readFileSync(reportPath, 'utf8')));
  else console.error('journey-shards: no report from a finished run, so every file counts the same');
  const plan = planShards(files, durations, shards);
  plan.forEach((bin, i) =>
    console.error(`shard ${i + 1}: ${bin.files.length} files, about ${Math.round(bin.ms / 60_000)} min by the last run`),
  );
  process.stdout.write(JSON.stringify(plan.map((bin) => bin.files.join(' '))));
}
